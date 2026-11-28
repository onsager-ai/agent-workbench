import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";

const FILE_LIMIT = 25 * 1024 * 1024;
const CONFIG_LIMIT = 16 * 1024;
const UPLOAD_TIMEOUT_MS = 120_000;
const CONFIG_KEYS = new Set(["host", "accountId", "hostPrefix", "accessKeyId", "secretAccessKey", "sessionToken",
  "expiresAt", "directEgressVerified"]);
const BUCKET = "owner-files";
const PUBLIC_ORIGIN = "https://files.onsager.ai";
const openFlags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hmac = (key, value) => createHmac("sha256", key).update(value).digest();
const matches = (value, pattern) => typeof value === "string" && value === value.trim() && pattern.test(value);

class AttachmentError extends Error {}
const unavailable = () => new AttachmentError("host-local R2 credentials are missing, invalid, or expired");
const changed = () => new AttachmentError("source changed while preparing or uploading the attachment");

function readAtMost(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
    if (read === 0) break;
    offset += read;
  }
  return offset;
}

function validCredentials(config, host, now) {
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      !Object.keys(config).every((key) => CONFIG_KEYS.has(key)) || config.host !== host ||
      config.directEgressVerified !== true || !matches(config.accountId, /^[a-f0-9]{32}$/) ||
      !matches(config.hostPrefix, /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/) ||
      !matches(config.accessKeyId, /^[A-Za-z0-9]+$/) ||
      ![config.secretAccessKey, config.sessionToken].every((value) => matches(value, /^[!-~]+$/)) ||
      !matches(config.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/)) return false;
  const expiry = new Date(config.expiresAt);
  const expected = config.expiresAt.includes(".") ? config.expiresAt : config.expiresAt.replace(/Z$/, ".000Z");
  return expiry.valueOf() > now && expiry.toISOString() === expected;
}

export function attachmentCredentials({ home = os.userInfo().homedir, host = os.hostname(), now = Date.now() } = {}) {
  const file = path.join(home, ".config/agent-workbench/attachment-r2.json");
  try {
    const fd = fs.openSync(file, openFlags);
    try {
      const info = fs.fstatSync(fd);
      if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o7777) !== 0o600 ||
          info.size > CONFIG_LIMIT) throw unavailable();
      const buffer = Buffer.alloc(CONFIG_LIMIT + 1);
      const bytes = readAtMost(fd, buffer);
      if (bytes > CONFIG_LIMIT) throw unavailable();
      const config = JSON.parse(buffer.toString("utf8", 0, bytes));
      if (!validCredentials(config, host, now)) throw unavailable();
      return config;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    throw unavailable();
  }
}

export function signedAttachmentPut(config, bytes, now = new Date(), id = randomBytes(16).toString("hex")) {
  const hostname = `${config.accountId}.r2.cloudflarestorage.com`;
  const key = `${config.hostPrefix}/${id}`;
  const uri = `/${BUCKET}/${key}`;
  const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = timestamp.slice(0, 8);
  const scope = `${date}/auto/s3/aws4_request`;
  const payload = sha256(bytes);
  const headers = {
    "content-length": String(bytes.length), "content-type": "application/octet-stream", host: hostname,
    "x-amz-content-sha256": payload, "x-amz-date": timestamp, "x-amz-security-token": config.sessionToken,
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonical = ["PUT", uri, "", canonicalHeaders, signedHeaders, payload].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", timestamp, scope, sha256(canonical)].join("\n");
  const signingKey = [date, "auto", "s3", "aws4_request"].reduce(hmac, `AWS4${config.secretAccessKey}`);
  const signature = hmac(signingKey, stringToSign).toString("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { hostname, uri, headers, url: `${PUBLIC_ORIGIN}/${key}` };
}

function requestOnce(upload, bytes, request) {
  const agent = new https.Agent({ keepAlive: false, proxyEnv: {} });
  let timer;
  const unusable = () => new AttachmentError("R2 upload failed");
  return new Promise((resolve, reject) => {
    const outgoing = request({
      protocol: "https:", hostname: upload.hostname, port: 443, method: "PUT", path: upload.uri,
      headers: upload.headers, agent, rejectUnauthorized: true,
    }, (response) => {
      response.once("error", () => reject(unusable()));
      if (response.statusCode !== 200) {
        response.resume();
        reject(unusable());
        return;
      }
      response.once("end", () => outgoing.writableFinished ? resolve() : reject(unusable()));
      response.resume();
    });
    outgoing.once("error", () => reject(unusable()));
    timer = setTimeout(() => {
      reject(unusable());
      outgoing.destroy();
    }, UPLOAD_TIMEOUT_MS);
    outgoing.end(bytes);
  }).finally(() => {
    clearTimeout(timer);
    agent.destroy();
  });
}

function stableSource(file, fd, original) {
  const same = (info) => info.isFile() && ["dev", "ino", "size", "mtimeNs", "ctimeNs"]
    .every((key) => info[key] === original[key]);
  try {
    return same(fs.fstatSync(fd, { bigint: true })) && same(fs.lstatSync(file, { bigint: true }));
  } catch {
    return false;
  }
}

export async function putAttachment(file, { request = https.request, credentials = attachmentCredentials } = {}) {
  const config = credentials();
  const invalidFile = () => new AttachmentError("source must be a readable regular file of at most 25 MiB");
  let fd;
  try {
    fd = fs.openSync(file, openFlags);
    const original = fs.fstatSync(fd, { bigint: true });
    if (!original.isFile() || original.size > BigInt(FILE_LIMIT)) throw invalidFile();
    const size = Number(original.size);
    const buffer = Buffer.allocUnsafe(size + 1);
    if (readAtMost(fd, buffer) !== size || !stableSource(file, fd, original)) throw changed();
    const bytes = buffer.subarray(0, size);
    const now = new Date();
    if (Date.parse(config.expiresAt) <= now.valueOf()) throw unavailable();
    const upload = signedAttachmentPut(config, bytes, now);
    if (!stableSource(file, fd, original)) throw changed();
    await requestOnce(upload, bytes, request);
    if (!stableSource(file, fd, original)) throw changed();
    return upload.url;
  } catch (error) {
    if (error instanceof AttachmentError) throw error;
    if (fd === undefined) throw invalidFile();
    throw new AttachmentError("attachment read or upload failed");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export async function runAttachmentCommand(args) {
  if (args.length !== 2 || args[0] !== "put" || !args[1].trim()) {
    console.error("Usage: agent-workbench attachment put <path>");
    return 2;
  }
  try {
    console.log(await putAttachment(args[1]));
    return 0;
  } catch (error) {
    console.error(`agent-workbench attachment: ${error instanceof AttachmentError ? error.message : "upload failed"}`);
    return 1;
  }
}
