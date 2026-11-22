#!/usr/bin/env node
// Explicit, local global-instruction setup. Node 22.20+, POSIX only.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tty from "node:tty";
import { isDeepStrictEqual } from "node:util";
import { runOps, opsHelp } from "./ops.mjs";

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 20)) {
  console.error(`agent-workbench: Node 22.20 or newer is required (found ${process.versions.node}).`);
  process.exit(1);
}
const { isScalar, parseDocument, visit } = await import("../vendor/yaml/index.js");
const { parse: parseToml } = await import("../vendor/smol-toml/index.js");

export const VERSION = "1";
// Agent Workbench release; tests keep it equal to package.json.
export const RELEASE = "0.2.6";
const SOURCE = "onsager-ai/agent-workbench";
const BEGIN = Buffer.from("<!-- BEGIN agent-workbench -->");
const END = Buffer.from("<!-- END agent-workbench -->");
const PERSONAL_BEGIN = Buffer.from("<!-- BEGIN agent-workbench personal -->");
const PERSONAL_END = Buffer.from("<!-- END agent-workbench personal -->");
const MARKERS = [BEGIN, END, PERSONAL_BEGIN, PERSONAL_END];
const IMPORT = Buffer.from("@~/.agents/AGENTS.md");
const LIMIT = 10 * 1024 * 1024;
const ROLE = /^[a-z][a-z0-9-]*$/;
const CLAUDE_HOOK_MATCHERS = {
  PreToolUse: ["Agent|Task", "Bash", "mcp__t3-code__delegate_task", "mcp__t3-code__t3_thread_send"],
  PostToolUse: ["Agent|Task"],
  Stop: [undefined],
};
const claudeHookKey = (event, matcher) => matcher === undefined ? event : `${event}:${matcher}`;
const CODEX_HOOK_MATCHERS = ["Agent|spawn_agent", "Bash", "mcp__t3_code__delegate_task", "mcp__t3_code__t3_thread_send"];
const CODEX_HOOK_TIMEOUT = 30;

export class Conflict extends Error {}

const CONTEXT_INTEGER_KEYS = ["max_tokens", "gateway_window", "codex_window", "manager_window"];
const INTEGER_KEYS = new Set(["version", "timeout_s", "max_auto_rework", ...CONTEXT_INTEGER_KEYS]);

// Parse like PyYAML's safe_load: YAML 1.1, repeated keys keep the last value, keys must be strings
// (YAML 1.1 reads `no`, `on` and `null` as non-strings), and floats are not accepted in integer fields.
function parseWorkersYaml(text) {
  const document = parseDocument(text, { version: "1.1", uniqueKeys: false, intAsBigInt: true });
  if (document.errors.length) throw document.errors[0];
  visit(document, {
    Pair(_, pair) {
      if (isScalar(pair.key) && typeof pair.key.value !== "string") {
        throw new Error(`mapping keys must be strings: ${pair.key.value}`);
      }
      if (isScalar(pair.key) && INTEGER_KEYS.has(pair.key.value) && isScalar(pair.value) && typeof pair.value.value === "number") {
        throw new Error(`${pair.key.value} must be an integer`);
      }
    },
  });
  const plain = (value) => {
    if (typeof value === "bigint") return Number(value);
    if (Array.isArray(value)) return value.map(plain);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
    return value;
  };
  return plain(document.toJS());
}

const isDict = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const has = (object, key) => Object.hasOwn(object, key);
const clone = (value) => structuredClone(value);
const isInt = (value) => Number.isInteger(value);

// Equivalent of Python json.dumps (default separators, optional indent, sort_keys, ensure_ascii).
export function dumps(value, { indent = null, sortKeys = false, ascii = true } = {}) {
  const string = (text) => {
    const encoded = JSON.stringify(text);
    return ascii ? encoded.replace(/[\u007f-￿]/g, (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0")) : encoded;
  };
  const encode = (item, level) => {
    if (item === null || item === undefined) return "null";
    if (typeof item === "string") return string(item);
    if (typeof item !== "object") return JSON.stringify(item);
    const inner = indent === null ? "" : "\n" + " ".repeat(indent * (level + 1));
    const outer = indent === null ? "" : "\n" + " ".repeat(indent * level);
    const separator = indent === null ? ", " : "," + inner;
    if (Array.isArray(item)) {
      if (!item.length) return "[]";
      return "[" + inner + item.map((entry) => encode(entry, level + 1)).join(separator) + outer + "]";
    }
    let names = Object.keys(item).filter((name) => item[name] !== undefined);
    if (sortKeys) names = names.sort();
    if (!names.length) return "{}";
    return "{" + inner + names.map((name) => `${string(name)}: ${encode(item[name], level + 1)}`).join(separator) + outer + "}";
  };
  return encode(value, 0);
}

// Equivalent of Python shlex.join / shlex.quote.
export function shellQuote(word) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'"'"'`)}'`;
}

// Equivalent of Python shlex.split (POSIX, no comments).
export function shellSplit(text) {
  const words = [];
  let word = null;
  let quote = null;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\") {
        if (index + 1 >= text.length) throw new Conflict("No escaped character; close the quoted value and retry");
        const next = text[++index];
        word += next === '"' || next === "\\" ? next : "\\" + next;
      } else word += char;
    } else if (" \t\r\n".includes(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else if (char === "'" || char === '"') {
      quote = char;
      word ??= "";
    } else if (char === "\\") {
      if (index + 1 >= text.length) throw new Conflict("No escaped character; add the escaped character and retry");
      word = (word ?? "") + text[++index];
    } else word = (word ?? "") + char;
  }
  if (quote) throw new Conflict("No closing quotation; close the quoted value and retry");
  if (word !== null) words.push(word);
  return words;
}

export function mergeWorkers(base, overlay) {
  // Mappings merge recursively; lists replace; null deletes a tier.
  const result = clone(base);
  for (const [key, value] of Object.entries(overlay)) {
    if (key === "tiers" && isDict(value)) {
      if (!has(result, key)) result[key] = {};
      const tiers = result[key];
      if (!isDict(tiers)) throw new Conflict("tiers must be a mapping; edit workers.yml to use a mapping, then rerun the command");
      for (const [name, tier] of Object.entries(value)) {
        if (tier === null) tiers[name] = null;
        else if (isDict(tier) && isDict(tiers[name])) tiers[name] = mergeWorkers(tiers[name], tier);
        else tiers[name] = clone(tier);
      }
    } else if (isDict(value) && isDict(result[key])) {
      result[key] = mergeWorkers(result[key], value);
    } else {
      result[key] = clone(value);
    }
  }
  return result;
}

function keys(value, allowed, where) {
  if (!isDict(value)) throw new Conflict(`${where} must be a mapping; edit the named worker configuration and rerun the command`);
  const permitted = new Set(Array.isArray(allowed) ? allowed : Object.keys(allowed));
  const unknown = Object.keys(value).filter((name) => !permitted.has(name));
  if (unknown.length) throw new Conflict(`unknown keys in ${where}: ${unknown.join(", ")}; remove or correct those keys in workers.yml, then rerun the command`);
}

const positive = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
const nonEmptyString = (value) => typeof value === "string" && value !== "";

function validateWorkerShape(config, { profile = false } = {}) {
  keys(config, profile ? ["defaults", "tiers", "ladder", "policy"] :
    ["version", "defaults", "tiers", "ladder", "policy", "profiles", "profile", "select"], "workers");
  if (has(config, "defaults")) keys(config.defaults, ["effort", "timeout_s", "budget_usd"], "defaults");
  if (has(config, "tiers")) {
    keys(config.tiers, config.tiers, "tiers");
    for (const [name, tier] of Object.entries(config.tiers)) {
      if (!ROLE.test(name)) throw new Conflict(`invalid tier name: ${name}; rename it to lowercase letters, numbers or hyphens in workers.yml`);
      if (tier !== null) {
        keys(tier, ["harness", "model", "effort", "timeout_s", "budget_usd", "claude_route", "weekly_brake_percent", "opt_in"], `tier ${name}`);
      }
    }
  }
  if (has(config, "policy")) {
    keys(config.policy, ["max_auto_rework", "context", "stop_classifier"], "policy");
    if (has(config.policy, "stop_classifier") && config.policy.stop_classifier !== null) {
      keys(config.policy.stop_classifier, ["url", "model"], "policy.stop_classifier");
      const { url, model } = config.policy.stop_classifier;
      let parsedUrl;
      try { parsedUrl = new URL(url); } catch {}
      if (!parsedUrl || !["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new Conflict("policy.stop_classifier.url must be an http(s) URL; correct it in workers.yml");
      }
      if (!nonEmptyString(model)) {
        throw new Conflict("policy.stop_classifier.model must be a nonempty string; correct it in workers.yml");
      }
    }
    if (has(config.policy, "context")) {
      keys(config.policy.context, [...CONTEXT_INTEGER_KEYS, "manager_models"], "policy.context");
    }
  }
  if (has(config, "ladder")) {
    if (!Array.isArray(config.ladder)) throw new Conflict("ladder must be a list; edit workers.yml to use a list");
    for (const level of config.ladder) keys(level, ["level", "tiers", "approval", "start_for"], "ladder entry");
  }
}

export function resolveWorkerConfig(config) {
  validateWorkerShape(config, { profile: true });
  const defaults = config.defaults ?? {};
  if (!nonEmptyString(defaults.effort)) throw new Conflict("defaults.effort must be a nonempty string; set it in workers.yml");
  if (!isInt(defaults.timeout_s) || defaults.timeout_s <= 0) throw new Conflict("defaults.timeout_s must be a positive integer; set it in workers.yml");
  if (defaults.budget_usd != null && !positive(defaults.budget_usd)) {
    throw new Conflict("defaults.budget_usd must be positive and finite or null; correct it in workers.yml");
  }
  const result = clone(config);
  const tiers = {};
  for (const [name, tier] of Object.entries(result.tiers ?? {})) if (tier !== null) tiers[name] = tier;
  result.tiers = tiers;
  for (const [name, raw] of Object.entries(tiers)) {
    if (!isDict(raw)) throw new Conflict(`tier ${name} must be a mapping; edit its entry in workers.yml`);
    const tier = { ...defaults, opt_in: false, ...raw };
    tiers[name] = tier;
    const harness = tier.harness;
    if (!["codex", "claude"].includes(harness) || !nonEmptyString(tier.model)) {
      throw new Conflict(`tier ${name} needs a harness (codex|claude) and model string; correct its entry in workers.yml`);
    }
    if (!nonEmptyString(tier.effort)) throw new Conflict(`tier ${name}: effort must be a nonempty string; set it in workers.yml`);
    if (!isInt(tier.timeout_s) || tier.timeout_s <= 0) throw new Conflict(`tier ${name}: timeout_s must be a positive integer; correct it in workers.yml`);
    const budget = tier.budget_usd;
    if (budget != null && (harness !== "claude" || !positive(budget))) {
      throw new Conflict(`tier ${name}: budget_usd must be positive and finite or null, and Claude only; correct it in workers.yml`);
    }
    if (has(tier, "claude_route") && (harness !== "codex" ||
        (tier.claude_route !== null && !nonEmptyString(tier.claude_route)))) {
      throw new Conflict(`tier ${name}: claude_route is a Codex-only string or null; correct it in workers.yml`);
    }
    if (typeof tier.opt_in !== "boolean") throw new Conflict(`tier ${name}: opt_in must be boolean; correct it in workers.yml`);
    if (has(tier, "weekly_brake_percent") && (!positive(tier.weekly_brake_percent) || tier.weekly_brake_percent > 100)) {
      throw new Conflict(`tier ${name}: weekly_brake_percent must be > 0 and <= 100; correct it in workers.yml`);
    }
  }
  const seenLevels = new Set();
  const seenTiers = new Set();
  if (!Array.isArray(result.ladder) || !result.ladder.length) throw new Conflict("ladder must be a nonempty list; correct it in workers.yml");
  for (const level of result.ladder) {
    const name = level.level;
    if (!nonEmptyString(name) || seenLevels.has(name)) throw new Conflict("ladder level must be a unique nonempty string; correct levels in workers.yml");
    seenLevels.add(name);
    const names = level.tiers;
    if (!Array.isArray(names) || !names.length) throw new Conflict(`level ${name}: tiers must be a nonempty list; correct it in workers.yml`);
    for (const tier of names) {
      if (typeof tier !== "string" || !has(tiers, tier)) throw new Conflict(`level ${name}: undefined tier ${tier}; define it in tiers or remove it from the ladder in workers.yml`);
      if (seenTiers.has(tier)) throw new Conflict(`tier ${tier} occurs in multiple ladder entries; keep it in one ladder entry in workers.yml`);
      if (tiers[tier].opt_in) throw new Conflict(`opt_in tier ${tier} cannot appear in the ladder; remove it from the ladder in workers.yml`);
      seenTiers.add(tier);
    }
    if (has(level, "approval") && level.approval !== "required") throw new Conflict("ladder approval must be required or absent; correct it in workers.yml");
    if (has(level, "start_for") && (!Array.isArray(level.start_for) || level.start_for.some((kind) => !nonEmptyString(kind)))) {
      throw new Conflict("start_for must be a list of task-kind strings; correct it in workers.yml");
    }
  }
  const policy = result.policy ?? {};
  if (!isInt(policy.max_auto_rework) || policy.max_auto_rework < 0) {
    throw new Conflict("policy.max_auto_rework must be a nonnegative integer; correct it in workers.yml");
  }
  const context = policy.context ?? {};
  for (const key of CONTEXT_INTEGER_KEYS) {
    const value = context[key];
    if (key !== "max_tokens" && value == null) continue;
    if (!isInt(value) || value <= 0) {
      throw new Conflict(`policy.context.${key} must be a positive integer` + (key !== "max_tokens" ? " or null" : "") + "; correct it in workers.yml");
    }
  }
  if (has(context, "manager_models") && (!Array.isArray(context.manager_models) ||
      context.manager_models.some((model) => !nonEmptyString(model) || !model.trim()))) {
    throw new Conflict("policy.context.manager_models must be a list of model strings; correct it in workers.yml");
  }
  if (!has(context, "manager_models")) context.manager_models = ["claude-opus-5-5"];
  return result;
}

export function workerBundle(distributed, overlays = [], home = null) {
  const load = (file) => {
    let config;
    try {
      config = parseWorkersYaml(read(file).toString("utf8"));
    } catch (error) {
      throw new Conflict(`invalid YAML in ${file}: ${error.message}; correct the file and rerun the command`);
    }
    validateWorkerShape(config);
    if (has(config, "version") && config.version !== 2) throw new Conflict(`${file}: version must be 2; correct the file and rerun the command`);
    const profiles = has(config, "profiles") ? config.profiles : {};
    keys(profiles, profiles, "profiles");
    for (const [name, profile] of Object.entries(profiles)) {
      if (!name) throw new Conflict("profile name must be a nonempty string; assign a name in workers.yml");
      validateWorkerShape(profile, { profile: true });
    }
    return config;
  };
  let config = load(distributed);
  for (const overlay of overlays) if (present(overlay)) config = mergeWorkers(config, load(overlay));
  if (config.version !== 2) throw new Conflict("workers version must be 2; update workers.yml");
  const base = {};
  for (const key of ["defaults", "tiers", "ladder", "policy"]) if (has(config, key)) base[key] = config[key];
  const profiles = {};
  for (const [name, profile] of Object.entries(has(config, "profiles") ? config.profiles : {})) {
    profiles[name] = resolveWorkerConfig(mergeWorkers(base, profile));
  }
  const selected = config.profile ?? null;
  if (selected !== null && (typeof selected !== "string" || !has(profiles, selected))) {
    throw new Conflict(`undefined default profile: ${selected}; select a defined profile in workers.yml`);
  }
  const rules = has(config, "select") ? config.select : [];
  if (!Array.isArray(rules)) throw new Conflict("select must be a list; correct it in workers.yml");
  const resolvedRules = [];
  for (const rule of rules) {
    keys(rule, ["path", "profile"], "select entry");
    if (typeof rule.profile !== "string" || !has(profiles, rule.profile)) {
      throw new Conflict(`select references undefined profile: ${rule.profile ?? "None"}; select a defined profile in workers.yml`);
    }
    let rulePath = rule.path;
    if (!nonEmptyString(rulePath)) throw new Conflict("select.path must be a nonempty string; correct it in workers.yml");
    if (rulePath === "~" || rulePath.startsWith("~/")) rulePath = String(home || os.homedir()) + rulePath.slice(1);
    resolvedRules.push({ path: resolvePath(rulePath), profile: rule.profile });
  }
  return { base: resolveWorkerConfig(base), profiles, profile: selected, select: resolvedRules };
}

export function effectiveWorkers(bundle, cwd) {
  const directory = resolvePath(cwd);
  let profile = bundle.profile;
  for (const rule of bundle.select) {
    if (isRelativeTo(directory, rule.path)) {
      profile = rule.profile;
      break;
    }
  }
  return { ...clone(profile ? bundle.profiles[profile] : bundle.base), profile };
}

const digest = (data) => crypto.createHash("sha256").update(data).digest("hex");
// Codex 0.170.0 trust identity (codex-rs hooks/src/engine/discovery.rs hook_hash and
// config/src/fingerprint.rs version_for_toml): sha256 of the compact JSON of the sorted-key
// {event_name, hooks: [normalized handler], matcher}, with the command timeout defaulting to 600.
const CODEX_EVENT_LABELS = { PreToolUse: "pre_tool_use", PostToolUse: "post_tool_use", Stop: "stop" };
const sortedJson = (value) => (Array.isArray(value) ? value.map(sortedJson)
  : isDict(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedJson(value[key])])) : value);

export function codexHookHash(event, matcher, handler) {
  const identity = {
    event_name: CODEX_EVENT_LABELS[event],
    hooks: [{ type: "command", command: handler.command, timeout: Math.max(1, handler.timeout ?? 600), async: handler.async === true }],
  };
  // Codex ignores matchers on Stop.
  if (event !== "Stop" && matcher != null) identity.matcher = matcher;
  return "sha256:" + digest(Buffer.from(JSON.stringify(sortedJson(identity)), "utf8"));
}

export const codexHookKey = (file, event, group, handler = 0) => `${file}:${CODEX_EVENT_LABELS[event]}:${group}:${handler}`;

const present = (target) => {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
};
const isSymlink = (target) => {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
};
const isFile = (target) => {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
};
const read = (target) => (present(target) ? fs.readFileSync(target) : Buffer.alloc(0));

function isRelativeTo(child, parent) {
  const base = path.resolve(parent);
  return child === base || child.startsWith(base === "/" ? "/" : base + "/");
}

// Like Python Path.resolve(): follow symlinks for the part that exists.
function resolvePath(target) {
  const absolute = path.resolve(target);
  let existing = absolute;
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(existing), ...rest);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return absolute;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

function which(name) {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    const candidate = path.join(directory || ".", name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

// Never traverse symlink parents or read a foreign-owned entry.
function inspect(target, home, { link = false, directory = false } = {}) {
  if (!isRelativeTo(target, home)) throw new Conflict(`path escapes selected home: ${target}; choose a path within the selected home`);
  let homeInfo = null;
  try {
    homeInfo = fs.lstatSync(home);
  } catch {}
  if (!homeInfo || homeInfo.isSymbolicLink() || !homeInfo.isDirectory() || homeInfo.uid !== process.getuid()) {
    throw new Conflict(`home must be an owned directory: ${home}; select an existing directory owned by the current user`);
  }
  for (let parent = path.dirname(home); ; parent = path.dirname(parent)) {
    if (isSymlink(parent)) throw new Conflict(`selected home has a symlink ancestor: ${home}; choose a path without symlinked parents`);
    if (parent === path.dirname(parent)) break;
  }
  let current = home;
  const parts = path.relative(home, target).split("/").filter(Boolean);
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    if (present(current)) {
      const info = fs.lstatSync(current);
      if (!info.isDirectory() || info.uid !== process.getuid()) throw new Conflict(`unsafe parent directory: ${current}; replace it with a directory owned by the current user`);
    }
  }
  if (!present(target)) return;
  const info = fs.lstatSync(target);
  if (info.uid !== process.getuid()) throw new Conflict(`entry owned by another user: ${target}; have its owner resolve it or choose another home`);
  let allowed = directory ? info.isDirectory() : info.isFile();
  if (link && info.isSymbolicLink()) allowed = true;
  if (!allowed) throw new Conflict(`unexpected file type or symlink: ${target}; replace it with a regular ${directory ? "directory" : "file"} and retry`);
  if (!directory && info.isFile() && info.size > LIMIT) throw new Conflict(`file too large for bounded inspection: ${target}; reduce its size below 10 MiB and retry`);
}

const count = (data, needle) => {
  let total = 0;
  for (let at = data.indexOf(needle); at !== -1; at = data.indexOf(needle, at + needle.length)) total++;
  return total;
};

function splitBlock(data, begin = BEGIN, finish = END) {
  if (!count(data, begin) && !count(data, finish)) return [null, data];
  if (count(data, begin) !== 1 || count(data, finish) !== 1) {
    throw new Conflict("duplicate or unbalanced managed markers; repair the markers manually, then rerun the command");
  }
  const start = data.indexOf(begin);
  let end = data.indexOf(finish);
  if (end < start) throw new Conflict("managed markers are reversed; reorder the markers manually, then rerun the command");
  const inside = data.subarray(start + begin.length, end);
  if (MARKERS.some((marker) => inside.includes(marker))) throw new Conflict("managed markers are nested or overlapping; repair the markers manually, then rerun the command");
  end += finish.length;
  if (data[end] === 0x0a) end += 1;
  return [data.subarray(start, end), Buffer.concat([data.subarray(0, start), data.subarray(end)])];
}

// Python bytes.splitlines(keepends=True): split on \n, \r and \r\n.
function splitByteLines(data) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < data.length; index++) {
    if (data[index] === 0x0a || data[index] === 0x0d) {
      if (data[index] === 0x0d && data[index + 1] === 0x0a) index++;
      lines.push(data.subarray(start, index + 1));
      start = index + 1;
    }
  }
  if (start < data.length) lines.push(data.subarray(start));
  return lines;
}

// Return import lines resolving lexically to the shared instructions.
function importLines(data, home, claudeParent, shared) {
  const matches = [];
  const sharedPath = path.resolve(shared);
  for (const line of splitByteLines(data)) {
    const stripped = line.toString("latin1").replace(/^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/g, "");
    if (!stripped.startsWith("@")) continue;
    const token = Buffer.from(stripped.slice(1), "latin1");
    if (!token.length || token.toString("latin1").split(/[ \t\n\r\v\f]+/).filter(Boolean).length !== 1) continue;
    let target = token.toString("utf8");
    if (target.startsWith("~/")) target = path.join(home, target.slice(2));
    else if (!path.isAbsolute(target)) target = path.join(claudeParent, target);
    if (path.resolve(target) === sharedPath) matches.push(line);
  }
  return matches;
}

function removeExactLine(data, line) {
  const lines = splitByteLines(data);
  const index = lines.findIndex((current) => current.equals(line));
  if (index === -1) throw new Conflict("managed Claude import missing or modified; left unchanged; restore the import line recorded in state.json, then rerun");
  lines.splice(index, 1);
  return Buffer.concat(lines);
}

function syncDir(directory) {
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

const temporaryName = (directory) => path.join(directory, `.agent-workbench-${crypto.randomBytes(6).toString("hex")}`);

function atomic(target, data, mode = 0o600) {
  if (present(target) && !isSymlink(target) && read(target).equals(data)) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const name = temporaryName(path.dirname(target));
  try {
    const descriptor = fs.openSync(name, "wx", 0o600);
    try {
      fs.fchmodSync(descriptor, mode);
      for (let written = 0; written < data.length;) written += fs.writeSync(descriptor, data, written);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(name, target);
    syncDir(path.dirname(target));
  } finally {
    if (present(name)) fs.unlinkSync(name);
  }
  return true;
}

function atomicLink(target, destination) {
  if (isSymlink(target) && fs.readlinkSync(target) === destination) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const name = temporaryName(path.dirname(target));
  try {
    fs.symlinkSync(destination, name);
    fs.renameSync(name, target);
    syncDir(path.dirname(target));
  } finally {
    if (present(name)) fs.unlinkSync(name);
  }
  return true;
}

function snapshot(target) {
  if (isSymlink(target)) return ["link", fs.readlinkSync(target), null];
  if (present(target)) return ["file", read(target), fs.statSync(target).mode & 0o7777];
  return ["absent", null, null];
}

const sameValue = (a, b) => (Buffer.isBuffer(a) && Buffer.isBuffer(b) ? a.equals(b) : a === b);

// Roll back this operation's writes, retaining independently changed entries.
function transaction(plans, action) {
  const before = new Map([...plans.keys()].map((target) => [target, snapshot(target)]));
  try {
    return action();
  } catch (original) {
    const problems = [];
    for (const target of [...plans.keys()].reverse()) {
      try {
        const current = snapshot(target);
        const old = before.get(target);
        if (current[0] === old[0] && sameValue(current[1], old[1]) && current[2] === old[2]) continue;
        const planned = plans.get(target);
        if (current[0] !== planned[0] || !sameValue(current[1], planned[1])) {
          problems.push(`changed foreign entry retained: ${target}`);
          continue;
        }
        const [kind, value, mode] = old;
        if (kind === "absent") fs.unlinkSync(target);
        else if (kind === "link") atomicLink(target, value);
        else atomic(target, value, mode);
      } catch (error) {
        problems.push(`rollback could not restore ${target}: ${error.message}`);
      }
    }
    if (problems.length) throw new Conflict("operation failed; inspect retained backups and state: " + problems.join("; ") + "; resolve each listed file, then retry the operation");
    throw original;
  }
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
};

// A lock is stale when its owner pid is dead. A lock without a readable pid is only stale once its
// creator has had time to write one.
function lockStale(lock) {
  let pid = NaN;
  try {
    pid = Number(fs.readFileSync(path.join(lock, "pid"), "utf8"));
  } catch {}
  try {
    return pid ? !pidAlive(pid) : Date.now() - fs.statSync(lock).mtimeMs > 10000;
  } catch {
    return false;
  }
}

const uniqueName = (lock, label) => `${lock}.${label}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;

// Move a stale lock aside before deleting it, then re-check what was moved: another process may
// have replaced the stale lock with a live one between the check and the rename.
function reclaimStaleLock(lock) {
  if (!lockStale(lock)) return false;
  const aside = uniqueName(lock, "stale");
  try {
    fs.renameSync(lock, aside);
  } catch {
    return true;
  }
  if (lockStale(aside)) {
    fs.rmSync(aside, { recursive: true, force: true });
    return true;
  }
  try {
    fs.renameSync(aside, lock);
  } catch {
    fs.rmSync(aside, { recursive: true, force: true });
  }
  return false;
}

// Only the owner (the pid file names this process) removes a lock.
function releaseLock(lock) {
  try {
    if (Number(fs.readFileSync(path.join(lock, "pid"), "utf8")) !== process.pid) return;
    const aside = uniqueName(lock, "done");
    fs.renameSync(lock, aside);
    fs.rmSync(aside, { recursive: true, force: true });
  } catch {}
}

// Create a directory with default modes for parents and the given mode only on the leaf.
function mkdirLeaf(directory, mode) {
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  try {
    fs.mkdirSync(directory, { mode });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  fs.chmodSync(directory, mode);
}

function utf8(data) {
  return new TextDecoder("utf-8", { fatal: true }).decode(data);
}

function splitTextLines(text) {
  return text.match(/[^\n\r\v\f\x1c-\x1e\x85\u2028\u2029]*(?:\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029])|[^\n\r\v\f\x1c-\x1e\x85\u2028\u2029]+/g) ?? [];
}

function strictBase64(text) {
  const decoded = Buffer.from(text, "base64");
  if (decoded.toString("base64") !== text) throw new TypeError("invalid base64");
  return decoded;
}

const need = (object, key) => {
  if (!isDict(object) || !has(object, key)) throw new TypeError(`missing ${key}`);
  return object[key];
};

const NATIVE_TYPES = {
  claude: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "string", CLAUDE_CODE_MAX_CONTEXT_TOKENS: "string" },
  codex: { model_auto_compact_token_limit: "int", model_context_window: "int" },
};
const nativeTypeOk = (type, value) => (type === "string" ? typeof value === "string" : isInt(value));
const MODEL_SETTINGS_PREFIX = "modelSettings.";
const AUTO_COMPACT_SUFFIX = ".autoCompactWindow";
const claudeModelWindow = (key) => key.startsWith(MODEL_SETTINGS_PREFIX) && key.endsWith(AUTO_COMPACT_SUFFIX) &&
  key.length > MODEL_SETTINGS_PREFIX.length + AUTO_COMPACT_SUFFIX.length;
const claudeWindow = (key) => key === "autoCompactWindow" || claudeModelWindow(key);

function claudeSettingPath(key) {
  if (key === "autoCompactWindow") return [key];
  if (claudeModelWindow(key)) {
    return ["modelSettings", key.slice(MODEL_SETTINGS_PREFIX.length, -AUTO_COMPACT_SUFFIX.length), "autoCompactWindow"];
  }
  return ["env", key];
}

function claudeSettingParent(settings, segments, { create = false } = {}) {
  let parent = settings;
  for (const segment of segments.slice(0, -1)) {
    if (!has(parent, segment)) {
      if (!create) return undefined;
      // Model IDs are literal JSON keys, including names inherited from Object.prototype.
      Object.defineProperty(parent, segment, { value: {}, enumerable: true, configurable: true, writable: true });
    }
    parent = parent[segment];
    if (!isDict(parent)) return null;
  }
  return parent;
}

export class Setup {
  constructor(home) {
    this.home = path.resolve(home);
    const at = (...parts) => path.join(this.home, ...parts);
    this.shared = at(".agents/AGENTS.md");
    this.codex = at(".codex/AGENTS.md");
    this.claude = at(".claude/CLAUDE.md");
    this.launcher = at(".local/bin/agent-workbench");
    this.root = at(".local/state/agent-workbench");
    this.statePath = path.join(this.root, "state.json");
    this.script = at(".agents/skills/workbench-setup/scripts/workbench.mjs");
    this.template = path.join(path.dirname(this.script), "../assets/AGENTS.md");
    this.target = "../.agents/AGENTS.md";
    this.agents = at(".claude/agents");
    const orchestration = at(".agents/skills/orchestrate-harnesses");
    this.claudeSettings = at(".claude/settings.json");
    this.codexSettings = at(".codex/config.toml");
    this.codexHooks = at(".codex/hooks.json");
    this.models = path.join(orchestration, "workers.yml");
    this.personal = at(".agents/skills/workbench-personal");
    this.personalWorkers = path.join(this.personal, "workers.yml");
    this.personalInstructions = path.join(this.personal, "AGENTS.md");
    this.workersPath = path.join(this.root, "workers.json");
    this.worker = path.join(orchestration, "references/worker.md");
    this.policyHook = path.join(orchestration, "scripts/policy-hook");
    this.lockPath = path.join(this.root, "lock.d");
    this.isRealHome = this.home === path.resolve(os.homedir());
    const xdg = process.env.XDG_CONFIG_HOME ?? "";
    const config = this.isRealHome && xdg && path.isAbsolute(xdg) ? xdg : at(".config");
    this.override = path.join(config, "agent-workbench/workers.yml");
  }

  launcherBytes() {
    return Buffer.from("#!/bin/sh\n" +
      "# Managed by agent-workbench; ownership is recorded in state.json.\n" +
      `exec node ${shellQuote(this.script)} --home ${shellQuote(this.home)} "$@"\n`);
  }

  agentPath(name) {
    return path.join(this.agents, name + ".md");
  }

  workersBundle() {
    inspect(this.models, this.home);
    inspect(this.personalWorkers, this.home);
    if (present(this.override)) {
      inspect(this.override, isRelativeTo(this.override, this.home) ? this.home : path.dirname(this.override));
    }
    if (!present(this.models)) return null;
    return workerBundle(this.models, [this.personalWorkers, this.override], this.home);
  }

  workers(cwd) {
    const bundle = this.workersBundle();
    if (bundle === null) throw new Conflict("missing workers.yml; distribute orchestrate-harnesses first, then rerun agent-workbench workers");
    console.log(dumps(effectiveWorkers(bundle, cwd), { indent: 2 }));
  }

  warnCatalog(targets) {
    const magpie = which("magpie");
    if (!magpie || !Object.keys(targets).length) return;
    const result = spawnSync(magpie, ["models", "claude"], { encoding: "utf8", timeout: 20000 });
    if (result.error || result.status !== 0) {
      console.error("magpie catalog unavailable; tier validation skipped");
      return;
    }
    const catalog = new Map();
    for (const line of result.stdout.split(/\r?\n/)) {
      const fields = line.trim().split(/\s+/).filter(Boolean);
      const last = fields[fields.length - 1];
      if (fields.length >= 2 && last.includes("/") && /^[a-z/]+$/.test(last)) {
        // Entries carry routing prefixes (auto/, hub/wokey/, claude/); index every suffix.
        const parts = fields[0].split("/");
        for (let i = 0; i < parts.length; i++) {
          const name = parts.slice(i).join("/");
          if (!catalog.has(name)) catalog.set(name, new Set());
          for (const effort of last.split("/")) catalog.get(name).add(effort);
        }
      }
    }
    for (const [name, [model, effort]] of Object.entries(targets)) {
      const efforts = catalog.get(model);
      if (efforts === undefined) {
        console.error(`warning: ${name} tier model '${model}' is absent from magpie models claude`);
      } else if (!efforts.has(effort)) {
        console.error(`warning: ${name} tier effort '${effort}' is not listed for '${model}' by magpie models claude`);
      }
    }
  }

  // Render the union of tiers routable from Claude across all profiles.
  desiredAgents({ warn = true } = {}) {
    const bundle = this.workersBundle();
    inspect(this.worker, this.home);
    if (bundle === null || !present(this.worker)) return {};
    const body = utf8(read(this.worker));
    const agents = {};
    const targets = {};
    const signatures = {};
    for (const config of [bundle.base, ...Object.values(bundle.profiles)]) {
      for (const [name, tier] of Object.entries(config.tiers)) {
        const model = tier.harness === "claude" ? tier.model : tier.claude_route ?? null;
        const signature = JSON.stringify([tier.model, model, tier.effort]);
        if (has(signatures, name) && signatures[name] !== signature) {
          throw new Conflict(`tier ${name} has different model/route/effort across profiles; rename it in workers.yml, then rerun the command`);
        }
        signatures[name] = signature;
        if (model === null) continue;
        const via = tier.harness === "claude" ? "" : " via configured gateway";
        const description = `Agent Workbench Worker (${tier.model}${via})`;
        agents[name] = Buffer.from("---\n" + `name: ${name}\n` + `description: ${dumps(description)}\n` +
          `model: ${dumps(model)}\n` + `effort: ${dumps(tier.effort)}\n---\n` +
          "<!-- Managed by agent-workbench; ownership is recorded in state.json. -->\n\n" + body);
        // A frontmatter alias resolves in the Claude session, so catalog checks use literal IDs only.
        if (!/^(haiku|sonnet|opus|fable)$/.test(model)) targets[name] = [model, tier.effort];
      }
    }
    if (warn) this.warnCatalog(targets);
    return agents;
  }

  contextValues() {
    const bundle = this.workersBundle();
    if (bundle === null) return null;
    const context = bundle.base.policy.context;
    const target = context.max_tokens;
    const values = { claude: { autoCompactWindow: target }, codex: { model_auto_compact_token_limit: target } };
    if (context.manager_window != null) {
      for (const model of context.manager_models) {
        values.claude[`${MODEL_SETTINGS_PREFIX}${model}${AUTO_COMPACT_SUFFIX}`] = context.manager_window;
      }
      const sharedModels = new Map();
      for (const config of [bundle.base, ...Object.values(bundle.profiles)]) {
        for (const [name, tier] of Object.entries(config.tiers)) {
          const model = tier.harness === "claude" ? tier.model : tier.claude_route;
          if (context.manager_models.includes(model)) sharedModels.set(name, model);
        }
      }
      for (const [name, model] of sharedModels) {
        console.error(`warning: ${name} tier uses Claude model '${model}' and shares the Manager's ${context.manager_window}-token compaction window`);
      }
    }
    if (context.gateway_window != null) values.claude.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(context.gateway_window);
    if (context.codex_window != null) values.codex.model_context_window = context.codex_window;
    return values;
  }

  nativeConfig(kind, settingKeys = []) {
    const file = kind === "claude" ? this.claudeSettings : this.codexSettings;
    inspect(path.dirname(file), this.home, { directory: true });
    if (!present(path.dirname(file))) return [null, null];
    inspect(file, this.home);
    const data = read(file);
    try {
      if (kind === "claude") {
        const parsed = present(file) ? JSON.parse(utf8(data)) : {};
        const env = isDict(parsed) && has(parsed, "env") ? parsed.env : {};
        if (!isDict(parsed) || !isDict(env)) throw new TypeError("settings and env must be objects");
        const current = {};
        for (const key of settingKeys) {
          const segments = claudeSettingPath(key);
          const parent = claudeSettingParent(parsed, segments);
          const leaf = segments.at(-1);
          if (parent === null) current[key] = null;
          else if (parent && has(parent, leaf)) current[key] = parent[leaf];
        }
        return [data, current];
      }
      return [data, parseToml(utf8(data))];
    } catch {
      throw new Conflict(`invalid ${kind} configuration: ${file}; correct the configuration, then rerun the command`);
    }
  }

  nativeEdit(kind, data, changes) {
    if (!Object.keys(changes).length) return data;
    if (kind === "claude") {
      const parsed = data.length ? JSON.parse(data.toString("utf8")) : {};
      for (const [key, value] of Object.entries(changes)) {
        const segments = claudeSettingPath(key);
        const parent = claudeSettingParent(parsed, segments, { create: value !== null });
        const leaf = segments.at(-1);
        if (value === null) delete parent[leaf];
        else parent[leaf] = value;
      }
      return Buffer.from(dumps(parsed, { indent: 2, ascii: false }) + "\n");
    }
    const lines = splitTextLines(data.toString("utf8"));
    let firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
    if (firstTable === -1) firstTable = lines.length;
    const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const [key, value] of Object.entries(changes)) {
      const pattern = new RegExp("^([ \\t]*(?:" + escape(key) + "|\"" + escape(key) + "\"|'" + escape(key) +
        "')[ \\t]*=[ \\t]*)([^#\\r\\n]*?)([ \\t]*(?:#[^\\r\\n]*)?)(\\r?\\n)?$");
      let found = -1;
      let match = null;
      for (let i = 0; i < firstTable && found === -1; i++) {
        match = pattern.exec(lines[i]);
        if (match) found = i;
      }
      if (found !== -1) {
        if (value === null) {
          const comment = match[3].trimStart();
          lines[found] = comment ? comment + (match[4] ?? "") : "";
        } else {
          lines[found] = match[1] + String(value) + match[3] + (match[4] ?? "");
        }
      } else if (value !== null) {
        const prefix = firstTable === 0 || lines[firstTable - 1].endsWith("\n") ? "" : "\n";
        lines.splice(firstTable, 0, prefix + key + " = " + String(value) + "\n");
        firstTable += 1;
      } else {
        throw new Conflict(`cannot safely edit ${kind} key: ${key}; edit the key manually, then rerun the command`);
      }
    }
    const result = Buffer.from(lines.join(""), "utf8");
    try {
      parseToml(result.toString("utf8"));
    } catch {
      throw new Conflict("invalid Codex configuration after edit; restore config.toml and retry the command");
    }
    return result;
  }

  nativePlans(state, desired, { uninstall = false, status = false } = {}) {
    const owned = state?.native ?? {};
    const plans = new Map();
    const record = {};
    const report = {};
    for (const kind of ["claude", "codex"]) {
      const old = owned[kind] ?? {};
      const wanted = uninstall || desired === null ? {} : desired[kind];
      const settingKeys = [...new Set([...Object.keys(old), ...Object.keys(wanted)])].sort();
      const [data, current] = this.nativeConfig(kind, settingKeys);
      if (data === null) {
        report[kind] = "skipped: config directory missing";
        if (has(owned, kind)) record[kind] = owned[kind];
        continue;
      }
      if (status && !has(owned, kind) && (kind !== "claude" || !settingKeys.length)) {
        report[kind] = "skipped: not applied; run install if config directory is available";
        continue;
      }
      const changes = {};
      const entries = {};
      report[kind] = {};
      for (const key of settingKeys) {
        const exists = has(current, key);
        const value = current[key];
        const expected = has(old, key) ? old[key] : wanted[key];
        const conflict = exists && value !== expected;
        report[kind][key] = conflict ? "conflict" : exists ? "applied" : "missing";
        if (status) continue;
        if (conflict) {
          if (uninstall) continue;
          throw new Conflict(`foreign or edited ${kind} setting: ${key}; resolve that value, then run agent-workbench install`);
        }
        if (has(wanted, key)) {
          // An identical user-set window already works and remains user-owned.
          if (kind === "claude" && claudeWindow(key) && exists && !has(old, key)) continue;
          entries[key] = wanted[key];
          if (!exists || value !== wanted[key]) changes[key] = wanted[key];
        } else if (exists && has(old, key)) {
          changes[key] = null;
        }
      }
      if (Object.keys(entries).length) record[kind] = entries;
      if (Object.keys(changes).length) {
        plans.set(kind === "claude" ? this.claudeSettings : this.codexSettings,
          ["file", this.nativeEdit(kind, data, changes), 0o600]);
      }
    }
    return [plans, record, report];
  }

  // Own complete entries, never a matcher or another hook's command.
  hookPlans(state, plans, { uninstall = false, status = false } = {}) {
    const owned = state?.hooks ?? [];
    let [data] = this.nativeConfig("claude");
    if (data === null) {
      if (owned.length) throw new Conflict("owned Claude hooks are missing; restore settings.json, then rerun agent-workbench install");
      data = Buffer.alloc(0);
    }
    if (plans.has(this.claudeSettings)) data = plans.get(this.claudeSettings)[1];
    const parsed = data.length ? JSON.parse(data.toString("utf8")) : {};
    const hooks = has(parsed, "hooks") ? parsed.hooks : {};
    const events = Object.entries(CLAUDE_HOOK_MATCHERS);
    if (!isDict(hooks) || events.some(([event]) => has(hooks, event) && !Array.isArray(hooks[event]))) {
      throw new Conflict("invalid Claude hooks.PreToolUse, hooks.PostToolUse, or hooks.Stop configuration; correct settings.json, then rerun agent-workbench install");
    }
    let command = null;
    if (!uninstall && present(this.models) && present(this.worker)) {
      inspect(this.policyHook, this.home);
      if (!isFile(this.policyHook)) {
        throw new Conflict("missing canonical policy hook; distribute orchestrate-harnesses first, then rerun agent-workbench install");
      }
      command = [this.policyHook, "--workers", this.workersPath].map(shellQuote).join(" ");
    }
    const contains = (list, entry) => list.some((item) => isDeepStrictEqual(item, entry));
    const report = {};
    const record = [];
    const changes = {};
    for (const [event, matchers] of events) {
      const current = hooks[event] ?? [];
      const previous = owned.filter(({ key, matcher }) => key === claudeHookKey(event, matcher));
      const desired = command === null ? [] : matchers.map((matcher) => ({
        ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: "command", command }],
      }));
      const updated = [...current];
      for (const { key, ...entry } of previous) {
        const matches = current.filter((item) => isDeepStrictEqual(item, entry));
        if (matches.length > 1) throw new Conflict("owned Claude hook is duplicated; remove the duplicate entry, then rerun agent-workbench install");
        const label = event === "PreToolUse" ? entry.matcher : key;
        report[label] = matches.length ? "applied" : "missing";
        if (!status && matches.length && !contains(desired, entry)) {
          updated.splice(updated.indexOf(matches[0]), 1);
        }
      }
      if (status) continue;
      for (const entry of desired) {
        const key = claudeHookKey(event, entry.matcher);
        const exists = contains(updated, entry);
        if (!exists || contains(previous, { ...entry, key })) record.push({ ...entry, key });
        if (!exists) updated.push(entry);
      }
      if (!isDeepStrictEqual(updated, current)) changes[event] = updated;
    }
    if (Object.keys(changes).length) {
      parsed.hooks = { ...hooks, ...changes };
      plans.set(this.claudeSettings, ["file", Buffer.from(dumps(parsed, { indent: 2, ascii: false }) + "\n"), 0o600]);
    }
    return [status ? owned : record, report];
  }

  // Codex user hooks live in ~/.codex/hooks.json with the same ownership rules as the Claude entries.
  codexHookPlans(state, plans, { uninstall = false, status = false } = {}) {
    const owned = state?.codex_hooks ?? [];
    const directory = path.dirname(this.codexHooks);
    inspect(directory, this.home, { directory: true });
    inspect(this.codexHooks, this.home);
    const available = present(directory);
    if (!available && owned.length) throw new Conflict("owned Codex hooks are missing; restore hooks.json, then rerun agent-workbench install");
    const data = read(this.codexHooks);
    let parsed;
    try {
      parsed = data.length ? JSON.parse(utf8(data)) : {};
    } catch {
      throw new Conflict(`invalid Codex hooks configuration: ${this.codexHooks}; correct hooks.json, then rerun agent-workbench install`);
    }
    const hooks = isDict(parsed) && has(parsed, "hooks") ? parsed.hooks : {};
    const current = isDict(hooks) && has(hooks, "PreToolUse") ? hooks.PreToolUse : [];
    const currentStop = isDict(hooks) && has(hooks, "Stop") ? hooks.Stop : [];
    if (!isDict(parsed) || !isDict(hooks) || !Array.isArray(current) || !Array.isArray(currentStop)) {
      throw new Conflict("invalid Codex hooks.PreToolUse or hooks.Stop configuration; correct hooks.json, then rerun agent-workbench install");
    }
    const contains = (list, entry) => list.some((item) => isDeepStrictEqual(item, entry));
    for (const entry of owned) {
      const collection = has(entry, "matcher") ? current : currentStop;
      if (collection.filter((item) => isDeepStrictEqual(item, entry)).length > 1) {
        throw new Conflict("owned Codex hook is duplicated; remove the duplicate entry, then rerun agent-workbench install");
      }
    }
    let desired = [];
    let desiredStop = [];
    if (!uninstall && available && present(this.models) && present(this.worker)) {
      inspect(this.policyHook, this.home);
      if (!isFile(this.policyHook)) {
        throw new Conflict("missing canonical policy hook; distribute orchestrate-harnesses first, then rerun agent-workbench install");
      }
      const command = [this.policyHook, "--host", "codex", "--workers", this.workersPath].map(shellQuote).join(" ");
      const handler = { type: "command", command, timeout: CODEX_HOOK_TIMEOUT };
      desired = CODEX_HOOK_MATCHERS.map((matcher) => ({ matcher, hooks: [{ ...handler }] }));
      desiredStop = [{ hooks: [{ ...handler }] }];
    }
    const report = {};
    for (const entry of owned) if (has(entry, "matcher")) report[entry.matcher] = contains(current, entry) ? "applied" : "missing";
    for (const entry of owned) if (!has(entry, "matcher")) report.Stop = contains(currentStop, entry) ? "applied" : "missing";
    if (status) return [owned, report, { PreToolUse: current, Stop: currentStop }];
    const updated = [...current];
    const updatedStop = [...currentStop];
    const remove = (list, entry) => {
      const index = list.findIndex((item) => isDeepStrictEqual(item, entry));
      if (index !== -1) list.splice(index, 1);
    };
    for (const entry of owned) {
      const collection = has(entry, "matcher") ? updated : updatedStop;
      if (!contains(has(entry, "matcher") ? desired : desiredStop, entry)) remove(collection, entry);
    }
    const record = [];
    for (const entry of desired) {
      if (contains(owned, entry) || !contains(updated, entry)) record.push(entry);
      if (!contains(updated, entry)) updated.push(entry);
    }
    for (const entry of desiredStop) {
      if (contains(owned, entry) || !contains(updatedStop, entry)) record.push(entry);
      if (!contains(updatedStop, entry)) updatedStop.push(entry);
    }
    if (!isDeepStrictEqual(updated, current) || !isDeepStrictEqual(updatedStop, currentStop)) {
      if (!has(parsed, "hooks")) parsed.hooks = {};
      parsed.hooks.PreToolUse = updated;
      parsed.hooks.Stop = updatedStop;
      plans.set(this.codexHooks, ["file", Buffer.from(dumps(parsed, { indent: 2, ascii: false }) + "\n"), 0o600]);
    }
    return [record, report, { PreToolUse: updated, Stop: updatedStop }];
  }

  // Trust key and hash for each owned hook entry at its position in the hooks.json lists.
  codexTrustItems(entries, lists) {
    const items = [];
    for (const entry of entries) {
      const event = has(entry, "matcher") ? "PreToolUse" : "Stop";
      const index = lists[event].findIndex((item) => isDeepStrictEqual(item, entry));
      if (index === -1) continue;
      items.push({
        label: entry.matcher ?? "Stop", key: codexHookKey(this.codexHooks, event, index),
        hash: codexHookHash(event, entry.matcher, entry.hooks[0]),
      });
    }
    return items;
  }

  codexHookStates(text) {
    const state = parseToml(text).hooks?.state;
    return isDict(state) ? state : {};
  }

  confirmCodexTrust() {
    // tty.isatty, not process.stdin.isTTY: creating the stdin stream makes fd 0 non-blocking, so readSync gets EAGAIN.
    if (!tty.isatty(0) || !tty.isatty(1)) return false;
    process.stdout.write("Trust agent-workbench's Codex hooks now? [y/N] ");
    const buffer = Buffer.alloc(256);
    let answer = "";
    try {
      answer = buffer.toString("utf8", 0, fs.readSync(0, buffer, 0, buffer.length, null));
    } catch {}
    return /^\s*y(es)?\s*$/i.test(answer);
  }

  // Append whole owned hooks.state tables to config.toml and remove only unmodified owned ones.
  codexTrustPlans(state, plans, items, { uninstall = false } = {}) {
    const owned = state?.codex_trust ?? [];
    const [data] = this.nativeConfig("codex");
    if (data === null) {
      if (owned.length) throw new Conflict("owned Codex trust entries are missing; restore config.toml, then rerun agent-workbench trust");
      return [[], []];
    }
    const original = (plans.has(this.codexSettings) ? plans.get(this.codexSettings)[1] : data).toString("utf8");
    let text = original;
    const wanted = new Map(uninstall ? [] : items.map((item) => [item.key, item]));
    const record = [];
    for (const entry of owned) {
      const item = wanted.get(entry.key);
      const at = text.lastIndexOf(entry.text);
      if (at === -1) continue;
      if (item && item.hash === entry.hash) record.push(entry);
      else text = text.slice(0, at) + text.slice(at + entry.text.length);
    }
    const messages = [];
    if (uninstall) {
      if (text !== original) plans.set(this.codexSettings, ["file", Buffer.from(text, "utf8"), 0o600]);
      return [record, messages];
    }
    const states = this.codexHookStates(text);
    const pending = [];
    for (const item of items) {
      const existing = states[item.key];
      if (existing === undefined) pending.push(item);
      else if (!isDict(existing) || existing.trusted_hash !== item.hash) {
        messages.push(`left foreign or changed Codex hooks.state entry unchanged: ${item.key}`);
      }
    }
    if (pending.length) {
      if (this.confirmCodexTrust()) {
        let edited = text;
        const added = [];
        for (const item of pending) {
          const chunk = (edited.length && !edited.endsWith("\n") ? "\n" : "") + (edited.length ? "\n" : "") +
            `[hooks.state.${JSON.stringify(item.key)}]\ntrusted_hash = ${JSON.stringify(item.hash)}\n`;
          edited += chunk;
          added.push({ key: item.key, hash: item.hash, text: chunk });
        }
        try {
          this.codexHookStates(edited);
          text = edited;
          record.push(...added);
        } catch {
          messages.push("could not add Codex hook trust safely; run /hooks in Codex to trust agent-workbench's hooks.");
        }
      } else {
        messages.push("Run /hooks in Codex once to trust agent-workbench's hooks.");
      }
    }
    if (text !== original) plans.set(this.codexSettings, ["file", Buffer.from(text, "utf8"), 0o600]);
    return [record, messages];
  }

  // Report trust per owned hook: trusted, untrusted (no state entry) or modified (state names another hash).
  codexTrustStatus(items) {
    const [data] = this.nativeConfig("codex");
    const states = data === null ? {} : this.codexHookStates(data.toString("utf8"));
    return Object.fromEntries(items.map((item) => {
      const existing = states[item.key];
      return [item.label, existing === undefined ? "untrusted" : isDict(existing) && existing.trusted_hash === item.hash ? "trusted" : "modified"];
    }));
  }

  backupName(file) {
    return { [this.claudeSettings]: "claude_settings", [this.codexSettings]: "codex_settings", [this.codexHooks]: "codex_hooks" }[file];
  }

  checkAgents(state, desired = []) {
    const owned = state ? state.agents : {};
    for (const name of [...new Set([...Object.keys(owned), ...desired])].sort()) {
      const file = this.agentPath(name);
      inspect(file, this.home);
      if (!present(file)) continue;
      if (!has(owned, name)) throw new Conflict(`foreign Claude agent file; left unchanged: ${file}; move it aside or remove it before rerunning agent-workbench install`);
      if (digest(read(file)) !== owned[name].hash) throw new Conflict(`owned Claude agent file was edited; left unchanged: ${file}; restore its generated contents or move it aside, then rerun agent-workbench install`);
    }
  }

  load() {
    inspect(this.root, this.home, { directory: true });
    inspect(this.statePath, this.home);
    if (!present(this.statePath)) return null;
    try {
      const state = JSON.parse(utf8(read(this.statePath)));
      const invalid = (message) => new TypeError(message);
      const importText = IMPORT.toString();
      if (need(state, "schema") !== 2 || typeof need(state, "block_hash") !== "string"
          || !isDict(need(state, "native")) || !Array.isArray(need(state, "hooks"))
          || (has(state, "post_hooks") && !Array.isArray(state.post_hooks))
          || !isDict(need(state, "agents")) || need(state, "target") !== this.target
          || typeof need(state, "launcher_hash") !== "string" || typeof need(state, "version") !== "string"
          || typeof need(state, "template_hash") !== "string"
          || digest(Buffer.from(need(state, "block_text"), "utf8")) !== state.block_hash
          || typeof need(state, "import_added") !== "boolean"
          || !["", importText + "\n", "\n" + importText + "\n"].includes(need(state, "import_suffix"))) {
        throw invalid("invalid ownership metadata");
      }
      const personal = need(state, "personal_block");
      if (personal !== null && (!isDict(personal) || typeof need(personal, "text") !== "string"
          || digest(Buffer.from(personal.text, "utf8")) !== need(personal, "hash"))) {
        throw invalid("invalid personal block ownership metadata");
      }
      if (!Array.isArray(need(state, "personal_files"))
          || state.personal_files.some((name) => !["workers.yml", "AGENTS.md"].includes(name))) {
        throw invalid("invalid personal file metadata");
      }
      const imported = need(state, "claude_import");
      if (!isDict(imported) || typeof imported.owned !== "boolean" || typeof imported.line !== "string") {
        throw invalid("invalid Claude import ownership metadata");
      }
      strictBase64(imported.line);
      if (need(state, "workers_hash") !== null && typeof state.workers_hash !== "string") {
        throw invalid("invalid Worker ownership metadata");
      }
      for (const [kind, entries] of Object.entries(state.native)) {
        if (!has(NATIVE_TYPES, kind) || !isDict(entries)) throw invalid("invalid native ownership metadata");
        for (const [key, value] of Object.entries(entries)) {
          const type = kind === "claude" && claudeWindow(key) ? "int" :
            has(NATIVE_TYPES[kind], key) ? NATIVE_TYPES[kind][key] : null;
          if (type === null || !nativeTypeOk(type, value)) {
            throw invalid("invalid native ownership metadata");
          }
        }
      }
      const hookKeys = new Set();
      const normalizeHook = (saved, legacyEvent) => {
        if (!isDict(saved)) throw invalid("invalid hook ownership metadata");
        const { key, ...entry } = saved;
        const names = Object.keys(entry).sort().join(",");
        const { matcher, hooks } = entry;
        const event = legacyEvent ?? (typeof key === "string" && key.startsWith("PostToolUse:")
          ? "PostToolUse" : has(entry, "matcher") ? "PreToolUse" : "Stop");
        const expectedKey = claudeHookKey(event, matcher);
        const bareKey = event === "PreToolUse" && key === matcher;
        if (names !== (event === "Stop" ? "hooks" : "hooks,matcher") ||
            !CLAUDE_HOOK_MATCHERS[event].includes(matcher) || hookKeys.has(expectedKey) ||
            (has(saved, "key") && key !== expectedKey && !bareKey) ||
            !Array.isArray(hooks) || hooks.length !== 1 || !isDict(hooks[0]) ||
            Object.keys(hooks[0]).sort().join(",") !== "command,type" ||
            hooks[0].type !== "command" || typeof hooks[0].command !== "string") {
          throw invalid("invalid hook ownership metadata");
        }
        hookKeys.add(expectedKey);
        return { ...entry, key: expectedKey };
      };
      state.hooks = [
        ...state.hooks.map((entry) => normalizeHook(entry)),
        ...(state.post_hooks ?? []).map((entry) => normalizeHook(entry, "PostToolUse")),
      ];
      if (has(state, "codex_hooks") && !Array.isArray(state.codex_hooks)) throw invalid("invalid Codex hook ownership metadata");
      for (const entry of state.codex_hooks ?? []) {
        const names = isDict(entry) ? Object.keys(entry).sort().join(",") : "";
        const inner = isDict(entry) ? entry.hooks : null;
        if (!["hooks,matcher", "hooks"].includes(names)
            || (has(entry, "matcher") && !CODEX_HOOK_MATCHERS.includes(entry.matcher))
            || !Array.isArray(inner) || inner.length !== 1 || !isDict(inner[0])
            || Object.keys(inner[0]).sort().join(",") !== "command,timeout,type"
            || inner[0].type !== "command" || typeof inner[0].command !== "string"
            || !isInt(inner[0].timeout)) {
          throw invalid("invalid Codex hook ownership metadata");
        }
      }
      if (has(state, "codex_trust") && !Array.isArray(state.codex_trust)) throw invalid("invalid Codex trust ownership metadata");
      for (const entry of state.codex_trust ?? []) {
        if (!isDict(entry) || Object.keys(entry).sort().join(",") !== "hash,key,text"
            || Object.values(entry).some((value) => typeof value !== "string")) {
          throw invalid("invalid Codex trust ownership metadata");
        }
      }
      for (const [name, entry] of Object.entries(state.agents)) {
        if (!ROLE.test(name) || typeof need(entry, "hash") !== "string") throw invalid("invalid agent ownership metadata");
      }
      return state;
    } catch {
      throw new Conflict("invalid setup state; retain backups, repair state, then rerun agent-workbench install");
    }
  }

  static claudeImportRecord(state) {
    const saved = state.claude_import;
    return { owned: saved.owned, line: strictBase64(saved.line) };
  }

  static encodeClaudeImport(owned, line) {
    return { owned: Boolean(owned), line: line.toString("base64") };
  }

  preflight({ uninstall = false, status = false } = {}) {
    const state = this.load();
    for (const file of [this.shared, this.claude, this.launcher]) inspect(file, this.home);
    inspect(this.codex, this.home, { link: true });
    inspect(this.lockPath, this.home, { directory: true });
    inspect(path.join(this.root, "backups"), this.home, { directory: true });
    for (const name of ["shared", "codex", "claude", "launcher", "claude_settings", "codex_settings", "codex_hooks"]) {
      inspect(path.join(this.root, "backups", name + ".json"), this.home);
    }
    const override = path.join(this.home, ".codex/AGENTS.override.md");
    inspect(override, this.home, { link: true });
    if (present(override)) throw new Conflict("Codex AGENTS.override.md masks AGENTS.md; remove or update the override, then rerun the command");
    if (this.isRealHome) {
      const command = which("agent-workbench");
      if (command && path.resolve(command) !== this.launcher) {
        throw new Conflict("another agent-workbench command is on PATH; remove it from PATH or resolve the collision, then rerun the command");
      }
      for (const [variable, expected] of [["CODEX_HOME", path.join(this.home, ".codex")],
        ["CLAUDE_CONFIG_DIR", path.join(this.home, ".claude")]]) {
        let configured = process.env[variable];
        if (configured) {
          if (configured === "~" || configured.startsWith("~/")) configured = os.homedir() + configured.slice(1);
          if (path.resolve(configured) !== expected) {
            throw new Conflict(`${variable} selects another instruction location; unset it or select the intended home, then rerun the command`);
          }
        }
      }
    }
    if (isSymlink(this.codex) && fs.readlinkSync(this.codex) !== this.target) {
      throw new Conflict("foreign Codex link; left unchanged; restore the managed link target, then rerun agent-workbench install");
    }
    if (!state && isSymlink(this.codex)) throw new Conflict("unowned Codex link; remove it or restore the original file, then rerun agent-workbench install");
    if (state && !isSymlink(this.codex)) throw new Conflict("owned Codex link is missing or replaced; restore the managed link target, then rerun agent-workbench install");
    // A launcher whose bytes match the recorded hash is owned, including a pre-Node Python launcher.
    if (present(this.launcher)) {
      if (!state || digest(read(this.launcher)) !== state.launcher_hash) {
        throw new Conflict("foreign or edited agent-workbench command; leave it unchanged or move it aside, then rerun agent-workbench install");
      }
      if (!(fs.statSync(this.launcher).mode & 0o100)) throw new Conflict("owned launcher is not executable; restore its executable mode, then rerun agent-workbench install");
    } else if (state) {
      throw new Conflict("owned launcher is missing; restore it from backup, then rerun agent-workbench install");
    }
    const data = read(this.shared);
    const [block, afterBlock] = splitBlock(data);
    const [personalBlock, private_] = splitBlock(afterBlock, PERSONAL_BEGIN, PERSONAL_END);
    if (state) {
      if (block === null || digest(block) !== state.block_hash) {
        throw new Conflict("managed block drift; restore the public block recorded in state.json, then rerun agent-workbench install");
      }
      const ownedPersonal = state.personal_block;
      if (ownedPersonal !== null) {
        if (personalBlock === null || digest(personalBlock) !== ownedPersonal.hash) {
          throw new Conflict("personal managed block drift; restore the personal block recorded in state.json, then rerun agent-workbench install");
        }
      } else if (personalBlock !== null) {
        throw new Conflict("personal managed markers have no ownership record; remove them or repair setup state, then rerun agent-workbench install");
      }
    } else if (block !== null || personalBlock !== null) {
      throw new Conflict("managed markers have no ownership record; remove them or restore setup state, then rerun agent-workbench install");
    }
    const claude = read(this.claude);
    const lines = importLines(claude, this.home, path.dirname(this.claude), this.shared);
    if (lines.length > 1) throw new Conflict("duplicate Claude imports; keep one import, then rerun agent-workbench install");
    if (state && lines.length !== 1) throw new Conflict("managed Claude import is missing or modified; restore the import line from state.json, then rerun agent-workbench install");
    if (state) {
      const imported = Setup.claudeImportRecord(state);
      if (imported.owned && !lines[0].equals(imported.line)) {
        throw new Conflict("managed Claude import missing or modified; restore the import line recorded in state.json, then rerun agent-workbench install");
      }
    }
    if (!status) this.checkAgents(state);
    inspect(this.workersPath, this.home);
    const ownedWorkers = state ? state.workers_hash : null;
    if (present(this.workersPath)) {
      if (!ownedWorkers || digest(read(this.workersPath)) !== ownedWorkers) {
        throw new Conflict(`foreign or edited resolved Worker configuration: ${this.workersPath}; move it aside, then rerun agent-workbench install`);
      }
    } else if (ownedWorkers) {
      throw new Conflict(`owned resolved Worker configuration is missing: ${this.workersPath}; restore it with agent-workbench install`);
    }
    if (!uninstall) {
      this.workersBundle();
      this.desiredAgents({ warn: false });
      inspect(this.script, this.home);
      inspect(this.template, this.home);
      if (!isFile(this.script) || !isFile(this.template)) {
        throw new Conflict("missing canonical setup resources; distribute workbench-setup globally first, then rerun agent-workbench install");
      }
      const template = read(this.template);
      utf8(template);
      if (MARKERS.some((marker) => template.includes(marker))) throw new Conflict("template must not contain managed markers; remove those markers from the distributed template");
      inspect(this.personal, this.home, { directory: true });
      inspect(this.personalInstructions, this.home);
      const personal = read(this.personalInstructions);
      utf8(personal);
      if (MARKERS.some((marker) => personal.includes(marker))) throw new Conflict("personal instructions must not contain managed markers; remove those markers from the personal instructions file");
    }
    return [state, block, private_];
  }

  // Atomic mkdir lock holding the owner pid. A lock whose owner is gone is stale and removed.
  withLock(action) {
    mkdirLeaf(this.root, 0o700);
    for (let attempt = 0; ; attempt++) {
      try {
        fs.mkdirSync(this.lockPath, { mode: 0o700 });
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (attempt > 0 || !reclaimStaleLock(this.lockPath)) {
          throw new Conflict("another agent-workbench operation holds the lock; wait for it to finish, then rerun the command");
        }
      }
    }
    try {
      fs.writeFileSync(path.join(this.lockPath, "pid"), String(process.pid));
      return action();
    } finally {
      releaseLock(this.lockPath);
    }
  }

  backup(name, target) {
    const backups = path.join(this.root, "backups");
    mkdirLeaf(backups, 0o700);
    const destination = path.join(backups, name + ".json");
    if (!present(destination)) {
      let entry = { type: "absent" };
      if (isSymlink(target)) entry = { type: "symlink", target: fs.readlinkSync(target) };
      else if (present(target)) {
        entry = { type: "file", base64: read(target).toString("base64"), mode: fs.statSync(target).mode & 0o7777 };
      }
      atomic(destination, Buffer.from(dumps(entry, { sortKeys: true }) + "\n"));
    }
  }

  trust() {
    let trusted = false;
    this.withLock(() => {
      const [state] = this.preflight({ status: true });
      if (!state) throw new Conflict("not installed; run agent-workbench install first");
      const [owned, , lists] = this.codexHookPlans(state, new Map(), { status: true });
      const plans = new Map();
      const [record, messages] = this.codexTrustPlans(state, plans, this.codexTrustItems(owned, lists));
      trusted = messages.length === 0 && record.length > 0;
      if (plans.has(this.codexSettings)) this.backup("codex_settings", this.codexSettings);
      if (plans.size) {
        const updated = { ...state, codex_trust: record };
        plans.set(this.statePath, ["file", Buffer.from(dumps(updated, { indent: 2, sortKeys: true }) + "\n"), 0o600]);
        transaction(plans, () => { for (const [file, plan] of plans) atomic(file, plan[1]); });
      }
      for (const message of messages) console.log(message);
      if (trusted) console.log("Codex hooks trusted");
      else if (!messages.length) console.log("No Codex hooks need trust");
    });
  }

  install() {
    this.preflight();
    let changed = false;
    let desired;
    let trustMessages = [];
    this.withLock(() => {
      const [state, oldBlock, private_] = this.preflight();
      let privateText = private_;
      const template = read(this.template);
      const block = Buffer.concat([BEGIN, Buffer.from("\n"), stripTrailingNewlines(template), Buffer.from("\n"), END, Buffer.from("\n")]);
      let personalBlock = null;
      if (present(this.personalInstructions)) {
        personalBlock = Buffer.concat([PERSONAL_BEGIN, Buffer.from("\n"), stripTrailingNewlines(read(this.personalInstructions)),
          Buffer.from("\n"), PERSONAL_END, Buffer.from("\n")]);
      }
      if (!state && present(this.codex)) {
        const codexPrivate = read(this.codex);
        if (!codexPrivate.equals(privateText)) privateText = Buffer.concat([privateText, codexPrivate]);
      }
      let claude = read(this.claude);
      const lines = importLines(claude, this.home, path.dirname(this.claude), this.shared);
      let imported;
      let added;
      let suffix;
      if (state) {
        imported = Setup.claudeImportRecord(state);
        added = state.import_added;
        suffix = state.import_suffix;
      } else {
        added = !lines.length;
        suffix = "";
        imported = lines.length ? { owned: false, line: lines[0] } : { owned: true, line: Buffer.concat([IMPORT, Buffer.from("\n")]) };
      }
      if (!lines.length) {
        suffix = (claude.length && claude[claude.length - 1] !== 0x0a ? "\n" : "") + IMPORT.toString() + "\n";
        claude = Buffer.concat([claude, Buffer.from(suffix)]);
        imported = { owned: true, line: Buffer.concat([IMPORT, Buffer.from("\n")]) };
      }
      const [nativePlans, nativeRecord] = this.nativePlans(state, this.contextValues());
      const [hookRecord] = this.hookPlans(state, nativePlans);
      const [codexHookRecord, , codexLists] = this.codexHookPlans(state, nativePlans);
      const codexTrustRecord = (state?.codex_trust ?? []).filter((entry) =>
        this.codexTrustItems(codexHookRecord, codexLists).some((item) => item.key === entry.key && item.hash === entry.hash));
      trustMessages = this.codexTrustItems(codexHookRecord, codexLists)
        .filter((item) => !codexTrustRecord.some((entry) => entry.key === item.key && entry.hash === item.hash))
        .map((item) => `Run /hooks in Codex once to trust agent-workbench's hooks: ${item.label}`);
      desired = this.desiredAgents();
      this.checkAgents(state, Object.keys(desired));
      for (const name of ["shared", "codex", "claude", "launcher"]) this.backup(name, this[name]);
      for (const file of nativePlans.keys()) this.backup(this.backupName(file), file);
      const bundle = this.workersBundle();
      const workersBytes = bundle ? Buffer.from(dumps(bundle, { indent: 2 }) + "\n") : null;
      const launcher = this.launcherBytes();
      const record = {
        workers_hash: workersBytes ? digest(workersBytes) : null,
        native: nativeRecord, hooks: hookRecord, codex_hooks: codexHookRecord, codex_trust: codexTrustRecord,
        schema: 2, version: VERSION, template_hash: digest(template),
        personal_block: personalBlock !== null ? { hash: digest(personalBlock), text: personalBlock.toString("utf8") } : null,
        personal_files: [...(bundle && present(this.personalWorkers) ? ["workers.yml"] : []),
          ...(personalBlock !== null ? ["AGENTS.md"] : [])],
        block_hash: digest(block), block_text: block.toString("utf8"), target: this.target,
        launcher_hash: digest(launcher), import_added: Boolean(added),
        import_suffix: suffix,
        claude_import: Setup.encodeClaudeImport(imported.owned, imported.line),
        owned: { shared: "managed-block", codex: "symlink", claude: "import-line", launcher: "file" },
        agents: Object.fromEntries(Object.entries(desired).map(([name, data]) =>
          [name, { path: path.relative(this.home, this.agentPath(name)), hash: digest(data) }])),
      };
      let shared = read(this.shared);
      shared = splitBlock(shared, PERSONAL_BEGIN, PERSONAL_END)[1];
      const replacement = Buffer.concat([block, personalBlock ?? Buffer.alloc(0)]);
      if (oldBlock) {
        const at = shared.indexOf(oldBlock);
        shared = at === -1 ? shared : Buffer.concat([shared.subarray(0, at), replacement, shared.subarray(at + oldBlock.length)]);
      } else {
        shared = Buffer.concat([replacement, privateText]);
      }
      const stateBytes = Buffer.from(dumps(record, { indent: 2, sortKeys: true }) + "\n");
      const plans = new Map([[this.shared, ["file", shared, 0o600]], [this.codex, ["link", this.target, null]],
        [this.claude, ["file", claude, 0o600]], [this.launcher, ["file", launcher, 0o700]],
        [this.statePath, ["file", stateBytes, 0o600]]]);
      const agents = new Map();
      for (const name of new Set([...Object.keys(state ? state.agents : {}), ...Object.keys(desired)])) {
        agents.set(this.agentPath(name), has(desired, name) ? ["file", desired[name], 0o600] : ["absent", null, null]);
      }
      if (workersBytes !== null) agents.set(this.workersPath, ["file", workersBytes, 0o600]);
      else if (state && state.workers_hash) agents.set(this.workersPath, ["absent", null, null]);
      for (const [file, plan] of agents) plans.set(file, plan);
      for (const [file, plan] of nativePlans) plans.set(file, plan);
      transaction(plans, () => {
        changed = atomic(this.shared, shared);
        changed = atomicLink(this.codex, this.target) || changed;
        changed = atomic(this.claude, claude) || changed;
        changed = atomic(this.launcher, launcher, 0o700) || changed;
        for (const [file, plan] of agents) {
          if (plan[0] === "absent") {
            if (present(file)) {
              fs.unlinkSync(file);
              changed = true;
            }
          } else {
            changed = atomic(file, plan[1]) || changed;
          }
        }
        for (const [file, plan] of nativePlans) changed = atomic(file, plan[1]) || changed;
        changed = atomic(this.statePath, stateBytes) || changed;
      });
    });
    console.log(changed ? "installed" : "no-op: already installed");
    const names = Object.keys(desired).sort();
    console.log(`claude agents: ${names.join(", ") || "none"}`);
    if (!names.length) console.log("no Claude agents generated: orchestrate-harnesses is not installed");
    for (const message of trustMessages) console.log(message);
  }

  status({ json = false } = {}) {
    const [state, , private_] = this.preflight({ status: true });
    if (!state) throw new Conflict("not installed; run agent-workbench install first");
    const template = read(this.template);
    let nativeStatus = {};
    try { [, , nativeStatus] = this.nativePlans(state, this.contextValues(), { status: true }); }
    catch (error) { nativeStatus = { error: error.message }; }
    let hookStatus = {};
    try { [, hookStatus] = this.hookPlans(state, new Map(), { status: true }); }
    catch (error) { hookStatus = { error: error.message }; }
    let codexOwned = [];
    let codexHookStatus = {};
    let codexLists = { PreToolUse: [], Stop: [] };
    try { [codexOwned, codexHookStatus, codexLists] = this.codexHookPlans(state, new Map(), { status: true }); }
    catch (error) { codexHookStatus = { error: error.message }; }
    const report = {
      installed_version: state.version, available_version: VERSION,
      installed_template_hash: state.template_hash,
      available_template_hash: digest(template),
      native_settings: nativeStatus, hooks: hookStatus, codex_hooks: codexHookStatus,
      codex_trust: {},
      personal_package: { present: present(this.personal), applied_files: state.personal_files },
      private_bytes: private_.length, shared: this.shared,
      codex: this.codex, claude: this.claude,
      launcher: this.launcher,
      agents: Object.fromEntries(Object.keys(state.agents).sort().map((name) => [name, this.agentPath(name)])),
    };
    const errors = [];
    for (const [name, result] of [["native_settings", nativeStatus], ["hooks", hookStatus], ["codex_hooks", codexHookStatus]]) {
      if (Object.hasOwn(result, "error")) errors.push(new Conflict(`${result.error}; run agent-workbench install after resolving the configuration`));
    }
    if (!Object.hasOwn(codexHookStatus, "error")) {
      try { report.codex_trust = this.codexTrustStatus(this.codexTrustItems(codexOwned, codexLists)); }
      catch (error) { report.codex_trust_error = error.message; errors.push(new Conflict(`${error.message}; resolve Codex config.toml, then run agent-workbench status --json`)); }
    } else report.codex_trust_error = codexHookStatus.error;
    try { this.checkAgents(state, Object.keys(this.desiredAgents())); }
    catch (error) { report.agents_error = error.message; errors.push(error); }
    if (state.template_hash !== digest(template) || state.version !== VERSION) {
      report.update_error = "instruction update is available; run agent-workbench install to apply distributed assets";
      errors.push(new Conflict(report.update_error));
    }
    if (json) console.log(dumps(report, { sortKeys: true }));
    else {
      const line = (name, status, fix) => {
        const label = status === "applied" || status === "trusted" || status === "not installed" || status.startsWith("skipped:") ? "ok" : status === "missing" || status === "untrusted" ? "missing" : "conflict";
        console.log(`${label}  ${name}: ${status}${label === "ok" ? "" : `; ${fix}`}`);
      };
      line("setup", state.version === VERSION ? "applied" : "missing", "run agent-workbench install to apply update");
      for (const [kind, settings] of Object.entries(nativeStatus)) {
        if (kind === "error") line("configuration", "conflict", `resolve: ${settings}; run agent-workbench install`);
        else if (typeof settings === "string") line(`${kind} settings`, settings, "run agent-workbench install if needed");
        else for (const [key, status] of Object.entries(settings)) line(`${kind} setting ${key}`, status, status === "conflict" ? "resolve the value, then run agent-workbench install" : "run agent-workbench install to apply");
      }
      for (const [name, status] of Object.entries(hookStatus)) line(`Claude hook ${name}`, status, "run agent-workbench install to restore");
      for (const [name, status] of Object.entries(codexHookStatus)) line(`Codex hook ${name}`, status, "run agent-workbench install to restore");
      for (const [name, status] of Object.entries(report.codex_trust)) line(`Codex trust ${name}`, status, status === "trusted" ? "" : "run /hooks in Codex once");
      line("personal package", report.personal_package.present ? "applied" : "not installed", "install workbench-personal if needed");
      line("instruction template", state.template_hash === report.available_template_hash && state.version === VERSION ? "applied" : "missing", "run agent-workbench install to apply update");
      line(`private instructions (${private_.length} bytes)`, "applied", "");
      for (const [name, file] of Object.entries(report.agents)) line(`Claude agent ${name}`, fs.existsSync(file) ? "applied" : "missing", "run agent-workbench install to restore");
      if (report.agents_error) console.log(`conflict  Claude agents: ${report.agents_error}; resolve the file conflict, then run agent-workbench install`);
      if (report.codex_trust_error) console.log(`conflict  Codex trust: ${report.codex_trust_error}; resolve Codex config.toml, then run agent-workbench status --json`);
    }
    if (errors.length) {
      if (!json) for (const error of errors) console.log(`conflict  status: ${error.message}`);
      throw errors[0];
    }
  }

  uninstall() {
    const [first] = this.preflight({ uninstall: true });
    if (!first) {
      console.log("no-op: not installed");
      return;
    }
    this.withLock(() => {
      const [state, , private_] = this.preflight({ uninstall: true });
      let claude = read(this.claude);
      const imported = Setup.claudeImportRecord(state);
      if (imported.owned) {
        const suffix = state.import_added ? Buffer.from(state.import_suffix) : Buffer.alloc(0);
        if (suffix.length && claude.subarray(claude.length - suffix.length).equals(suffix) &&
            imported.line.equals(Buffer.concat([IMPORT, Buffer.from("\n")]))) {
          claude = claude.subarray(0, claude.length - suffix.length);
        } else {
          claude = removeExactLine(claude, imported.line);
        }
      }
      const [nativePlans] = this.nativePlans(state, null, { uninstall: true });
      this.hookPlans(state, nativePlans, { uninstall: true });
      this.codexHookPlans(state, nativePlans, { uninstall: true });
      this.codexTrustPlans(state, nativePlans, [], { uninstall: true });
      for (const file of nativePlans.keys()) this.backup(this.backupName(file), file);
      // Keep current personal bytes, never restore an old snapshot over them.
      const agents = new Map(Object.keys(state.agents).map((name) => [this.agentPath(name), ["absent", null, null]]));
      if (state.workers_hash) agents.set(this.workersPath, ["absent", null, null]);
      const plans = new Map([...agents, [this.shared, ["file", private_, 0o600]], [this.codex, ["file", private_, 0o600]],
        [this.claude, ["file", claude, 0o600]], [this.launcher, ["absent", null, null]],
        [this.statePath, ["absent", null, null]], ...nativePlans]);
      transaction(plans, () => {
        for (const [file, plan] of nativePlans) atomic(file, plan[1]);
        atomic(this.shared, private_);
        atomic(this.codex, private_);
        atomic(this.claude, claude);
        for (const file of agents.keys()) if (present(file)) fs.unlinkSync(file);
        fs.unlinkSync(this.launcher);
        fs.unlinkSync(this.statePath);
        syncDir(this.root);
      });
    });
    console.log("uninstalled; current private instructions and private backups retained");
  }

  update(command) {
    this.preflight();
    if (!this.isRealHome && !command) throw new Conflict("alternate --home requires --skills-cmd; real-user npx was not invoked; rerun with --skills-cmd COMMAND");
    let lockFile = path.join(this.home, ".agents/.skill-lock.json");
    if (this.isRealHome && process.env.XDG_STATE_HOME) {
      lockFile = path.join(process.env.XDG_STATE_HOME, "skills/.skill-lock.json");
      // XDG_STATE_HOME may be outside home, but reject symlink traversal there too.
      inspect(path.resolve(lockFile), path.resolve(process.env.XDG_STATE_HOME));
    } else {
      inspect(lockFile, this.home);
    }
    if (!present(lockFile)) throw new Conflict("native skills lock is missing; install global skills first, then rerun agent-workbench update");
    let names;
    let native;
    try {
      native = JSON.parse(utf8(read(lockFile)));
      const skills = native.skills;
      if (native.version !== 3 || !isDict(skills)) throw new TypeError("unsupported lock");
      names = Object.entries(skills).filter(([name, item]) => {
        if (name === "workbench-personal") return true;
        if (!isDict(item)) throw new TypeError("invalid skill entry");
        return item.source === SOURCE && item.sourceType === "github";
      }).map(([name]) => name).sort();
      if (!names.includes("workbench-setup") || names.some((name) => !name || name.startsWith("-") || name.includes("/"))) {
        throw new TypeError("setup ownership is missing or names are invalid");
      }
    } catch {
      throw new Conflict("unsupported native skills lock or missing repository ownership; restore a supported native skills lock, then rerun agent-workbench update");
    }
    // Skills removed upstream and already deleted locally would make the native update warn every run.
    const stale = names.filter((name) => name !== "workbench-setup" && !present(path.join(this.home, ".agents/skills", name)));
    const args = command ? shellSplit(command) : ["npx", "--yes", "skills@1.7.4"];
    if (!args.length) throw new Conflict("empty skills command; provide an executable command with --skills-cmd");
    this.withLock(() => {
      this.preflight();
      if (stale.length) {
        for (const name of stale) delete native.skills[name];
        const temporary = `${lockFile}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(native, null, 2) + "\n", { mode: fs.statSync(lockFile).mode & 0o777 });
        fs.renameSync(temporary, lockFile);
        console.log(`dropped stale skills lock entries: ${stale.join(", ")}`);
        names = names.filter((name) => !stale.includes(name));
      }
      const result = spawnSync(args[0], [...args.slice(1), "update", ...names, "-g", "-y"], { stdio: "inherit" });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Conflict(`native skills update failed (${result.status ?? result.signal}); global instructions unchanged; correct the skills update error, then rerun agent-workbench update`);
      }
      // Revalidate updated canonical resource paths without executing replaced symlinks.
      this.preflight();
    });
    // Fresh process loads the newly distributed code, after releasing our lock.
    const installed = spawnSync(process.execPath, [this.script, "--home", this.home, "install"], { stdio: "inherit" });
    if (installed.error) throw installed.error;
    return installed.status ?? 1;
  }
}

function stripTrailingNewlines(data) {
  let end = data.length;
  while (end > 0 && data[end - 1] === 0x0a) end--;
  return data.subarray(0, end);
}

const COMMANDS = {
  install: "Apply shared instructions, hooks and settings",
  update: "Update distributed skills, then apply them",
  status: "Check installed files and settings (supports --json)",
  trust: "Trust installed Codex policy hooks",
  uninstall: "Remove managed setup while keeping private files",
  workers: "Show effective worker configuration",
  ops: "Run host operations",
  version: "Print the installed Agent Workbench version",
};
const USAGE = "usage: workbench.mjs [--home HOME] [--skills-cmd SKILLS_CMD] [--cwd CWD] " +
  `{${Object.keys(COMMANDS).join(",")}}`;

function parseArguments(argv) {
  const options = { home: os.homedir(), skillsCmd: undefined, cwd: process.cwd(), command: undefined, json: false, help: false, helpCommand: undefined };
  const fail = (message) => {
    console.error(`${USAGE}\nworkbench.mjs: error: ${message}`);
    process.exit(2);
  };
  const flags = { "--home": "home", "--skills-cmd": "skillsCmd", "--cwd": "cwd" };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--help" || argv[index] === "-h") {
      options.help = true;
      if (options.command) options.helpCommand = options.command;
      continue;
    }
    if (argv[index] === "--json") { options.json = true; continue; }
    if (argv[index] === "--version" && options.command === undefined) { options.command = "version"; continue; }
    const [flag, inline] = argv[index].startsWith("--") && argv[index].includes("=") ?
      [argv[index].slice(0, argv[index].indexOf("=")), argv[index].slice(argv[index].indexOf("=") + 1)] : [argv[index]];
    if (has(flags, flag)) {
      const value = inline ?? argv[++index];
      if (value === undefined) fail(`argument ${flag}: expected one argument`);
      options[flags[flag]] = value;
    } else if (flag.startsWith("-")) {
      fail(`unrecognized arguments: ${argv[index]}`);
    } else if (options.command === undefined) {
      options.command = flag;
      if (flag === "ops") {
        options.ops = argv.slice(index + 1);
        break;
      }
    } else if (options.command === "help") {
      options.helpCommand = flag;
    } else {
      fail(`unrecognized arguments: ${flag}`);
    }
  }
  if (options.command === undefined && options.help) return options;
  if (options.command === undefined) fail("the following arguments are required: command");
  if (options.command === "help") {
    options.command = undefined;
    options.help = true;
    if (options.helpCommand !== undefined && !has(COMMANDS, options.helpCommand)) fail(`unknown command '${options.helpCommand}'`);
    return options;
  }
  if (!has(COMMANDS, options.command)) {
    fail(`argument command: invalid choice: '${options.command}' (choose from ${Object.keys(COMMANDS).map((item) => `'${item}'`).join(", ")})`);
  }
  return options;
}

function printHelp(command) {
  if (command === "ops") {
    console.log(opsHelp);
  } else if (!command) {
    console.log(`${USAGE}\n\nCommands:`);
    for (const [name, description] of Object.entries(COMMANDS)) console.log(`  ${name.padEnd(10)} ${description}`);
    console.log("\nUse workbench.mjs help <command> for command options.");
  } else {
    const args = command === "workers" ? " [--cwd CWD]" : command === "update" ? " [--skills-cmd SKILLS_CMD]" : command === "status" ? " [--json]" : "";
    console.log(`usage: workbench.mjs [--home HOME]${args} ${command}\n\n${COMMANDS[command]}`);
  }
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (args.help) { printHelp(args.helpCommand ?? (args.command === "help" ? undefined : args.command)); return 0; }
  try {
    if (args.command === "version") { console.log(RELEASE); return 0; }
    if (args.command === "ops") return runOps(args.ops, path.resolve(args.home));
    const setup = new Setup(args.home);
    if (args.command === "workers") setup.workers(args.cwd);
    else if (args.command === "update") return setup.update(args.skillsCmd);
    else if (args.command === "status") setup.status({ json: args.json });
    else setup[args.command]();
    return 0;
  } catch (error) {
    console.error(`agent-workbench: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
