import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { attachmentCredentials, putAttachment, signedAttachmentPut } from "../skills/workbench-setup/scripts/attachment.mjs";

const config = {
  host: os.hostname(), accountId: "0123456789abcdef0123456789abcdef", hostPrefix: "test-host",
  accessKeyId: "MockAccessKey", secretAccessKey: "MockSecretKey", sessionToken: "MockSessionToken",
  expiresAt: "2999-12-01T00:00:00Z", directEgressVerified: true,
};
const payload = Buffer.from([0, 255, 10, 65]);

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "awb-attachment-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const source = path.join(home, "private-source-filename.bin");
  const settings = path.join(home, ".config/agent-workbench/attachment-r2.json");
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(source, payload);
  const install = (value = config) => fs.writeFileSync(settings, JSON.stringify(value), { mode: 0o600 });
  const credentials = () => attachmentCredentials({ home });
  return { home, source, settings, install, credentials };
}

function transport({ statusCode = 200, onPut = () => {}, error } = {}) {
  const calls = [];
  const request = (options, respond) => {
    const outgoing = new EventEmitter();
    outgoing.destroy = () => {};
    outgoing.end = (body) => {
      calls.push({ options, body });
      outgoing.writableFinished = true;
      queueMicrotask(() => {
        onPut();
        if (error) {
          outgoing.emit("error", error);
          return;
        }
        const response = new PassThrough();
        response.statusCode = statusCode;
        response.headers = { location: "https://unapproved.example/redirect" };
        respond(response);
        response.end("mock service response body");
      });
    };
    return outgoing;
  };
  return { calls, request };
}

test("the R2 SigV4 signature signs exact bytes and the session token", () => {
  const put = signedAttachmentPut(config, payload, new Date("2026-11-28T12:34:56Z"), "abcdef0123456789abcdef0123456789");
  assert.equal(put.hostname, "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
  assert.equal(put.uri, "/owner-files/test-host/abcdef0123456789abcdef0123456789");
  assert.equal(put.url, "https://files.onsager.ai/test-host/abcdef0123456789abcdef0123456789");
  assert.equal(put.headers["x-amz-content-sha256"], "8fc3156c066463c772e9493b112bec494bc8d5ba3f9a1198837a2e404ee793fd");
  assert.equal(put.headers["x-amz-security-token"], config.sessionToken);
  assert.equal(put.headers.authorization, "AWS4-HMAC-SHA256 Credential=MockAccessKey/20261128/auto/s3/aws4_request, " +
    "SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, " +
    "Signature=742e0cae87e8039092971cad39d116eaff9acbc0c07f71bae12523ebdefb9a8c");
});

test("credentials require the local host, direct-egress attestation, expiry and owner-only file", (t) => {
  const { home, settings, install, credentials } = fixture(t);
  assert.throws(credentials, /missing, invalid, or expired/);
  install();
  assert.deepEqual(credentials(), config);
  for (const change of [{ host: "another-host" }, { directEgressVerified: false }, { expiresAt: "2000-01-01T00:00:00Z" },
    { expiresAt: "2999-02-30T00:00:00Z" }, { sessionToken: "" }, { hostPrefix: "../outside" }, { endpoint: "https://unapproved.example" }]) {
    install({ ...config, ...change });
    assert.throws(credentials, /missing, invalid, or expired/);
  }
  install();
  fs.chmodSync(settings, 0o644);
  assert.throws(credentials, /missing, invalid, or expired/);
  fs.chmodSync(settings, 0o600);
  fs.truncateSync(settings, 16 * 1024 + 1);
  assert.throws(credentials, /missing, invalid, or expired/);
  install();
  const copy = path.join(home, "credentials.json");
  fs.renameSync(settings, copy);
  fs.symlinkSync(copy, settings);
  assert.throws(credentials, /missing, invalid, or expired/);
});

test("one direct TLS PUT sends the exact file bytes and only returns the protected URL", async (t) => {
  const { source, install, credentials } = fixture(t);
  const { request, calls } = transport();
  install();
  const url = await putAttachment(source, { request, credentials });
  assert.match(url, /^https:\/\/files\.onsager\.ai\/test-host\/[a-f0-9]{32}$/);
  assert.equal(calls.length, 1);
  const [{ options, body }] = calls;
  assert.deepEqual(body, payload);
  assert.equal(options.protocol, "https:");
  assert.equal(options.port, 443);
  assert.equal(options.method, "PUT");
  assert.equal(options.path, `/owner-files${new URL(url).pathname}`);
  assert.equal(options.rejectUnauthorized, true);
  assert.ok(options.agent instanceof https.Agent);
  assert.notEqual(options.agent, https.globalAgent);
  assert.deepEqual(options.agent.options.proxyEnv, {});
  assert.equal(options.headers["content-length"], String(payload.length));
  assert.doesNotMatch(JSON.stringify(options.headers) + options.path + url, /private-source-filename/);
});

test("the uploader refuses unsupported sources and missing credentials before any request", async (t) => {
  const { home, source, install, credentials } = fixture(t);
  const { request, calls } = transport();
  await assert.rejects(putAttachment(source, { request, credentials }), /missing, invalid, or expired/);
  install();
  const link = path.join(home, "symlink");
  fs.symlinkSync(source, link);
  await assert.rejects(putAttachment(link, { request, credentials }), /readable regular file/);
  await assert.rejects(putAttachment(home, { request, credentials }), /readable regular file/);
  fs.truncateSync(source, 25 * 1024 * 1024 + 1);
  await assert.rejects(putAttachment(source, { request, credentials }), /at most 25 MiB/);
  assert.equal(calls.length, 0);
});

test("redirects, transport errors and source changes are terminal", async (t) => {
  const { source, install, credentials } = fixture(t);
  install();
  for (const options of [{ statusCode: 307 }, { error: new Error(config.secretAccessKey) }]) {
    const { request, calls } = transport(options);
    await assert.rejects(putAttachment(source, { request, credentials }), { message: "R2 upload failed" });
    assert.equal(calls.length, 1);
  }
  const { request, calls } = transport({ onPut: () => fs.appendFileSync(source, "changed") });
  await assert.rejects(putAttachment(source, { request, credentials }), /source changed/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, payload);
});

test("the npm wrapper forwards only the attachment command to the installed skill", (t) => {
  const { home } = fixture(t);
  const installed = path.join(home, ".agents/skills/workbench-setup/scripts/workbench.mjs");
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(installed, "console.log(JSON.stringify(process.argv.slice(2)));\n");
  const awb = fileURLToPath(new URL("../bin/awb.mjs", import.meta.url));
  const args = ["--home", home, "attachment", "put", "--home"];
  const result = spawnSync(process.execPath, [awb, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
});
