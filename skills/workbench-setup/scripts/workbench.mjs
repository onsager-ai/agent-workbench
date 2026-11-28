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
import { runOnceCommand, validOneShotJob } from "./run-once.mjs";
import { showLanes } from "./lanes.mjs";

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 20)) {
  console.error(`agent-workbench: Node 22.20 or newer is required (found ${process.versions.node}).`);
  process.exit(1);
}
const { isScalar, parseDocument, visit } = await import("../vendor/yaml/index.js");
const { parse: parseToml } = await import("../vendor/smol-toml/index.js");

export const VERSION = "1";
// Agent Workbench release; tests keep it equal to package.json.
export const RELEASE = "0.2.47";
const SOURCE = "onsager-ai/agent-workbench";
const WORKERS_SOURCE_MISSING = "regeneration needs workers.yml restored";
const BEGIN = Buffer.from("<!-- BEGIN agent-workbench -->");
const END = Buffer.from("<!-- END agent-workbench -->");
const PERSONAL_BEGIN = Buffer.from("<!-- BEGIN agent-workbench personal -->");
const PERSONAL_END = Buffer.from("<!-- END agent-workbench personal -->");
const MARKERS = [BEGIN, END, PERSONAL_BEGIN, PERSONAL_END];
const IMPORT = Buffer.from("@~/.agents/AGENTS.md");
const AGY_IMPORT = Buffer.from("@[Work instructions](~/.agents/AGENTS.md)");
const LIMIT = 10 * 1024 * 1024;
const ROLE = /^[a-z][a-z0-9-]*$/;
const LEGACY_PRETOOLUSE_MATCHERS = new Set(["Agent|Task", "Bash", "mcp__t3-code__delegate_task", "mcp__t3-code__t3_thread_send"]);
const CLAUDE_HOOK_MATCHERS = {
  PreToolUse: [".*"],
  UserPromptSubmit: [undefined],
  PostToolUse: ["Agent|Task"],
  Stop: [undefined],
};
const claudeHookKey = (event, matcher) => matcher === undefined ? event : `${event}:${matcher}`;
const CODEX_HOOK_MATCHERS = ["Agent|spawn_agent", "Bash", "mcp__t3_code__delegate_task", "mcp__t3_code__t3_thread_send", "mcp__t3_code__t3_thread_launch", "mcp__t3_code__t3_thread_configure", "mcp__t3_code__schedule_task", "mcp__t3_code__create_threads", "mcp__t3_code__watch_pull_request", "mcp__t3_code__preview_.*", "mcp__t3_code__t3_preview_.*", "mcp__t3_code_direct__(preview_|t3_preview_).*", "^apply_patch$",
  "^mcp__t3_code_direct__(delegate_task|t3_thread_launch|t3_thread_configure|create_threads|schedule_task)$",
  "^mcp__t3_code_direct__watch_pull_request$", "^exec_command$"];
const CODEX_POLICY_EVENTS = ["PreToolUse", "Stop", "UserPromptSubmit"];
// Existing ownership records have no event field: a matcher identifies PreToolUse, otherwise Stop.
const codexPolicyEvent = (entry) => entry.event ?? (has(entry, "matcher") ? "PreToolUse" : "Stop");
const CODEX_HOOK_TIMEOUT = 30;

export class Conflict extends Error {}

const CONTEXT_INTEGER_KEYS = ["max_tokens", "gateway_window", "codex_window", "manager_window", "worker_window"];
const INTEGER_KEYS = new Set(["version", "timeout_s", "max_auto_rework", "everyMs", "cpu_quota_percent", ...CONTEXT_INTEGER_KEYS]);

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
  keys(config, profile ? ["defaults", "tiers", "ladder", "policy", "routing"] :
    ["version", "defaults", "tiers", "ladder", "policy", "routing", "profiles", "profile", "select"], "workers");
  if (has(config, "defaults")) keys(config.defaults, ["effort", "timeout_s", "budget_usd"], "defaults");
  if (has(config, "tiers")) {
    keys(config.tiers, config.tiers, "tiers");
    for (const [name, tier] of Object.entries(config.tiers)) {
      if (!ROLE.test(name)) throw new Conflict(`invalid tier name: ${name}; rename it to lowercase letters, numbers or hyphens in workers.yml`);
      if (tier !== null) {
        keys(tier, ["harness", "model", "effort", "timeout_s", "budget_usd", "claude_route", "weekly_brake_percent", "opt_in",
          "provider", "options", "access", "isolation", "stamp"], `tier ${name}`);
      }
    }
  }
  if (has(config, "policy")) {
    keys(config.policy, ["max_auto_rework", "context", "stop_classifier", "browser", "schedules", "manager_models",
      "manager_threads", "manager_model_pairs", "one_shot_jobs"], "policy");
    if (has(config.policy, "one_shot_jobs")) {
      const { one_shot_jobs } = config.policy;
      if (!Array.isArray(one_shot_jobs)) {
        throw new Conflict("policy.one_shot_jobs must be a list; correct it in workers.yml");
      }
      const ids = new Set();
      for (const [index, job] of one_shot_jobs.entries()) {
        const where = `policy.one_shot_jobs[${index}]`;
        keys(job, ["id", "host", "parent_thread", "argv", "cwd", "cpu_quota_percent", "timeout_s", "expires_at"], where);
        if (!validOneShotJob(job)) throw new Conflict(`${where} does not describe a valid registered one-shot job`);
        if (ids.has(job.id)) throw new Conflict(`${where} repeats job ID ${job.id}`);
        ids.add(job.id);
      }
    }
    if (has(config.policy, "manager_models")) {
      const { manager_models } = config.policy;
      if (!Array.isArray(manager_models) || manager_models.some((model) => typeof model !== "string" || !model.trim())) {
        throw new Conflict("policy.manager_models must be a list of nonblank model strings; correct it in workers.yml");
      }
    }
    if (has(config.policy, "manager_threads")) {
      const { manager_threads } = config.policy;
      if (!Array.isArray(manager_threads) || manager_threads.some((id) => typeof id !== "string" || !id.trim())) {
        throw new Conflict("policy.manager_threads must be a list of nonblank T3 thread ID strings; correct it in workers.yml");
      }
    }
    if (has(config.policy, "manager_model_pairs")) {
      const { manager_model_pairs } = config.policy;
      if (!Array.isArray(manager_model_pairs)) throw new Conflict("policy.manager_model_pairs must be a list; correct it in workers.yml");
      for (const [index, pair] of manager_model_pairs.entries()) {
        const where = `policy.manager_model_pairs[${index}]`;
        keys(pair, ["thread", "model"], where);
        if (![pair.thread, pair.model].every((value) => nonEmptyString(value) && value === value.trim())) {
          throw new Conflict(`${where} must contain nonblank thread and model IDs without surrounding whitespace`);
        }
      }
    }
    if (has(config.policy, "browser")) {
      const { browser } = config.policy;
      keys(browser, ["profiles"], "policy.browser");
      if (has(browser, "profiles")) {
        keys(browser.profiles, browser.profiles, "policy.browser.profiles");
        for (const [id, profile] of Object.entries(browser.profiles)) {
          if (!/^\S+$/.test(id) || ["default", "incognito", "__proto__"].includes(id)) {
            throw new Conflict(`invalid bot profile ID ${id}; correct it in policy.browser.profiles`);
          }
          const where = `policy.browser.profiles.${id}`;
          keys(profile, ["urls"], where);
          if (!Array.isArray(profile.urls) || profile.urls.some((url) => {
            if (typeof url !== "string" || !/^https:\/\/[^/?#@\\\s]+(?=[/?#]|$)/i.test(url)) return true;
            try {
              const parsed = new URL(url);
              return parsed.protocol !== "https:" || parsed.username || parsed.password;
            } catch {
              return true;
            }
          })) throw new Conflict(`${where}.urls must be a list of absolute HTTPS URLs without credentials`);
        }
      }
    }
    if (has(config.policy, "schedules")) {
      const { schedules } = config.policy;
      if (!Array.isArray(schedules)) throw new Conflict("policy.schedules must be a list; correct it in workers.yml");
      for (const [index, entry] of schedules.entries()) {
        const where = `policy.schedules[${index}]`;
        keys(entry, ["name", "thread", "schedule", "task_id", "fresh_session"], where);
        const stringKeys = has(entry, "task_id") ? ["name", "thread", "task_id"] : ["name", "thread"];
        for (const key of stringKeys) {
          if (typeof entry[key] !== "string" || !entry[key].trim()) {
            throw new Conflict(`${where}.${key} must be a nonblank string; correct it in workers.yml`);
          }
        }
        if (has(entry, "fresh_session") && typeof entry.fresh_session !== "boolean") {
          throw new Conflict(`${where}.fresh_session must be a boolean; correct it in workers.yml`);
        }
        const { schedule } = entry;
        if (schedule?.type === "interval") {
          keys(schedule, ["type", "everyMs"], `${where}.schedule`);
          if (!Number.isSafeInteger(schedule.everyMs) || schedule.everyMs < 60000) {
            throw new Conflict(`${where}.schedule.everyMs must be a safe integer of at least 60000; correct it in workers.yml`);
          }
        } else if (schedule?.type === "fixed_time") {
          keys(schedule, ["type", "timeOfDay", "weekdays"], `${where}.schedule`);
          if (typeof schedule.timeOfDay !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.timeOfDay)) {
            throw new Conflict(`${where}.schedule.timeOfDay must be a 24-hour HH:MM string; correct it in workers.yml`);
          }
          if (has(schedule, "weekdays") && (!Array.isArray(schedule.weekdays) ||
              schedule.weekdays.some((day) => !isInt(day) || day < 0 || day > 6))) {
            throw new Conflict(`${where}.schedule.weekdays must be a list of integers from 0 to 6; correct it in workers.yml`);
          }
        } else if (schedule?.type === "once") {
          keys(schedule, ["type", "runAt"], `${where}.schedule`);
          const timestamp = typeof schedule.runAt === "string" &&
            /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(schedule.runAt);
          // Date can normalize impossible dates, so check the original day in UTC.
          if (!timestamp || timestamp[0] !== schedule.runAt ||
              new Date(`${timestamp[1]}T00:00:00Z`).getUTCDate() !== Number(timestamp[1].slice(-2))) {
            throw new Conflict(`${where}.schedule.runAt must be an ISO 8601 timestamp with a timezone; correct it in workers.yml`);
          }
        } else {
          throw new Conflict(`${where}.schedule.type must be interval, fixed_time, or once; correct it in workers.yml`);
        }
      }
    }
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
    const hasProvider = has(tier, "provider");
    if (hasProvider && (!nonEmptyString(tier.provider) || !tier.provider.trim())) {
      throw new Conflict(`tier ${name}: provider must be a nonblank string; correct it in workers.yml`);
    }
    if (!nonEmptyString(tier.model) || ((!hasProvider || has(tier, "harness")) && !["codex", "claude"].includes(harness))) {
      throw new Conflict(`tier ${name} needs a model string and, unless provider is set, a harness; correct its entry in workers.yml`);
    }
    if (has(tier, "options") && (!isDict(tier.options) ||
        Object.values(tier.options).some((value) => typeof value !== "string" && typeof value !== "boolean"))) {
      throw new Conflict(`tier ${name}: options must be a mapping of strings or booleans; correct it in workers.yml`);
    }
    if (has(tier, "access") && !["write", "read-only"].includes(tier.access)) {
      throw new Conflict(`tier ${name}: access must be write or read-only; correct it in workers.yml`);
    }
    if (has(tier, "isolation")) {
      if (!Array.isArray(tier.isolation) || !tier.isolation.length ||
          tier.isolation.some((value) => !["shared", "worktree"].includes(value))) {
        throw new Conflict(`tier ${name}: isolation must be a nonempty list of shared or worktree; correct it in workers.yml`);
      }
      if (tier.access === "read-only" && tier.isolation.includes("worktree")) {
        throw new Conflict(`tier ${name}: read-only tiers cannot list worktree in isolation; correct it in workers.yml`);
      }
    }
    if (has(tier, "stamp") && (typeof tier.stamp !== "string" || !tier.stamp.trim())) {
      throw new Conflict(`tier ${name}: stamp must be a nonblank string; correct it in workers.yml`);
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
  if (has(result, "routing")) {
    keys(result.routing, result.routing, "routing");
    for (const [kind, names] of Object.entries(result.routing)) {
      if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || !has(tiers, name))) {
        throw new Conflict(`routing for ${kind} must be a list of configured tier names; correct it in workers.yml`);
      }
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
  if (context.worker_window != null && context.worker_window < 100000) {
    throw new Conflict("policy.context.worker_window must be at least 100000 or null; correct it in workers.yml");
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
      if (profile.policy && has(profile.policy, "one_shot_jobs")) {
        throw new Conflict("policy.one_shot_jobs belongs in the base policy; move it out of the profile in workers.yml");
      }
    }
    return config;
  };
  let config = load(distributed);
  for (const overlay of overlays) if (present(overlay)) config = mergeWorkers(config, load(overlay));
  if (config.version !== 2) throw new Conflict("workers version must be 2; update workers.yml");
  const base = {};
  for (const key of ["defaults", "tiers", "ladder", "policy", "routing"]) if (has(config, key)) base[key] = config[key];
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
const CODEX_EVENT_LABELS = { PreToolUse: "pre_tool_use", PostToolUse: "post_tool_use", Stop: "stop", UserPromptSubmit: "user_prompt_submit" };
const sortedJson = (value) => (Array.isArray(value) ? value.map(sortedJson)
  : isDict(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedJson(value[key])])) : value);

export function codexHookHash(event, matcher, handler) {
  const identity = {
    event_name: CODEX_EVENT_LABELS[event],
    hooks: [{ type: "command", command: handler.command, timeout: Math.max(1, handler.timeout ?? 600), async: handler.async === true }],
  };
  // Codex ignores matchers on Stop and UserPromptSubmit.
  if (event !== "Stop" && event !== "UserPromptSubmit" && matcher != null) identity.matcher = matcher;
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

const isAgyIncludeLine = (line) => {
  let end = line.length;
  if (end && line[end - 1] === 0x0a) end--;
  if (end && line[end - 1] === 0x0d) end--;
  return line.subarray(0, end).equals(AGY_IMPORT);
};

function removeAgyInclude(data, separator) {
  const lines = splitByteLines(data);
  const index = lines.findIndex(isAgyIncludeLine);
  if (index === -1) throw new Conflict("managed Antigravity include missing or modified; left unchanged; restore it in ~/.gemini/AGENTS.md, then rerun agent-workbench install");
  const start = lines.slice(0, index).reduce((total, line) => total + line.length, 0);
  const end = start + lines[index].length;
  const removeStart = separator && end === data.length && start > 0 && data[start - 1] === 0x0a ? start - 1 : start;
  return Buffer.concat([data.subarray(0, removeStart), data.subarray(end)]);
};

function syncDir(directory) {
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

const temporaryName = (directory) => path.join(directory, `.agent-workbench-${crypto.randomBytes(6).toString("hex")}`);

function atomic(target, data, mode = 0o600, publish = null) {
  if (!publish && present(target) && !isSymlink(target) && read(target).equals(data)) return false;
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
    if (publish) publish(name, target);
    else fs.renameSync(name, target);
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

function unchangedSnapshot(target, expected) {
  const current = snapshot(target);
  return current[0] === expected[0] && sameValue(current[1], expected[1]) && current[2] === expected[2];
}

// Roll back this operation's writes, retaining independently changed entries.
// An exclusively created file supplies a predicate confirming the write belongs to this transaction.
function transaction(plans, action) {
  const before = new Map([...plans].map(([target, [, , , ownsNewFile]]) =>
    [target, ownsNewFile ? ["absent", null, null] : snapshot(target)]));
  try {
    return action();
  } catch (original) {
    const problems = [];
    for (const target of [...plans.keys()].reverse()) {
      try {
        const planned = plans.get(target);
        const ownsNewFile = planned[3];
        if (ownsNewFile && !ownsNewFile()) continue;
        const current = snapshot(target);
        const old = before.get(target);
        if (current[0] === old[0] && sameValue(current[1], old[1]) && current[2] === old[2]) continue;
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
  constructor(home, { antigravity = false } = {}) {
    this.home = path.resolve(home);
    this.antigravity = antigravity;
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
    this.gemini = at(".gemini/AGENTS.md");
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

  workersBundle({ config = true } = {}) {
    inspect(this.models, this.home);
    inspect(this.personalWorkers, this.home);
    if (present(this.override)) {
      inspect(this.override, isRelativeTo(this.override, this.home) ? this.home : path.dirname(this.override));
    }
    if (!config || !present(this.models)) return null;
    return workerBundle(this.models, [this.personalWorkers, this.override], this.home);
  }

  resolvedWorkersDrift(state, current) {
    const ownedHash = state?.workers_hash;
    if (current === null) return ownedHash ? "missing" : null;
    return digest(current) === ownedHash ? null : "edited";
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
  desiredAgents({ warn = true, config = true } = {}) {
    const bundle = this.workersBundle({ config });
    inspect(this.worker, this.home);
    if (bundle === null || !present(this.worker)) return {};
    const body = utf8(read(this.worker));
    const workerWindow = bundle.base.policy.context.worker_window;
    const agents = {};
    const targets = {};
    const signatures = {};
    for (const config of [bundle.base, ...Object.values(bundle.profiles)]) {
      for (const [name, tier] of Object.entries(config.tiers)) {
        const model = tier.provider ? null : tier.harness === "claude" ? tier.model : tier.claude_route ?? null;
        const signature = JSON.stringify([tier.model, model, tier.effort]);
        if (has(signatures, name) && signatures[name] !== signature) {
          throw new Conflict(`tier ${name} has different model/route/effort across profiles; rename it in workers.yml, then rerun the command`);
        }
        signatures[name] = signature;
        if (model === null) continue;
        const via = tier.harness === "claude" ? "" : " via configured gateway";
        const description = `Agent Workbench Worker (${tier.model}${via})`;
        agents[name] = Buffer.from("---\n" + `name: ${name}\n` + `description: ${dumps(description)}\n` +
          `model: ${dumps(model)}\n` + `effort: ${dumps(tier.effort)}\n` +
          "disallowedTools: AskUserQuestion\n" +
          (workerWindow == null ? "" : `autoCompactWindow: ${workerWindow}\n`) +
          "---\n" + "<!-- Managed by agent-workbench; ownership is recorded in state.json. -->\n\n" + body);
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
          if (tier.provider) continue;
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
    if (!isDict(parsed) || !isDict(hooks) || CODEX_POLICY_EVENTS.some((event) => has(hooks, event) && !Array.isArray(hooks[event]))) {
      throw new Conflict("invalid Codex hooks.PreToolUse, hooks.Stop or hooks.UserPromptSubmit configuration; correct hooks.json, then rerun agent-workbench install");
    }
    let handler = null;
    if (!uninstall && available && present(this.models) && present(this.worker)) {
      inspect(this.policyHook, this.home);
      if (!isFile(this.policyHook)) {
        throw new Conflict("missing canonical policy hook; distribute orchestrate-harnesses first, then rerun agent-workbench install");
      }
      const command = [this.policyHook, "--host", "codex", "--workers", this.workersPath].map(shellQuote).join(" ");
      handler = { type: "command", command, timeout: CODEX_HOOK_TIMEOUT };
    }
    const contains = (list, entry) => list.some((item) => isDeepStrictEqual(item, entry));
    const report = {};
    const record = [];
    const lists = {};
    const changes = {};
    for (const event of CODEX_POLICY_EVENTS) {
      const current = hooks[event] ?? [];
      const previous = owned.filter((entry) => codexPolicyEvent(entry) === event);
      const desired = handler === null ? [] : (event === "PreToolUse" ? CODEX_HOOK_MATCHERS : [undefined])
        .map((matcher) => ({ ...(matcher === undefined ? {} : { matcher }), hooks: [{ ...handler }] }));
      const updated = [...current];
      for (const { event: _event, ...entry } of previous) {
        const matches = current.filter((item) => isDeepStrictEqual(item, entry));
        if (matches.length > 1) throw new Conflict("owned Codex hook is duplicated; remove the duplicate entry, then rerun agent-workbench install");
        report[entry.matcher ?? event] = matches.length ? "applied" : "missing";
        if (!status && matches.length && !contains(desired, entry)) {
          updated.splice(updated.indexOf(matches[0]), 1);
        }
      }
      if (!status) {
        for (const entry of desired) {
          const ownership = event === "UserPromptSubmit" ? { ...entry, event } : entry;
          const exists = contains(updated, entry);
          if (!exists || contains(previous, ownership)) record.push(ownership);
          if (!exists) updated.push(entry);
        }
        if (!isDeepStrictEqual(updated, current)) changes[event] = updated;
      }
      lists[event] = updated;
    }
    if (Object.keys(changes).length) {
      parsed.hooks = { ...hooks, ...changes };
      plans.set(this.codexHooks, ["file", Buffer.from(dumps(parsed, { indent: 2, ascii: false }) + "\n"), 0o600]);
    }
    return [status ? owned : record, report, lists];
  }

  // Trust key and hash for each owned hook entry at its position in the hooks.json lists.
  codexTrustItems(entries, lists) {
    const items = [];
    for (const owned of entries) {
      const event = codexPolicyEvent(owned);
      const { event: _event, ...entry } = owned;
      const index = lists[event].findIndex((item) => isDeepStrictEqual(item, entry));
      if (index === -1) continue;
      items.push({
        label: entry.matcher ?? event, key: codexHookKey(this.codexHooks, event, index),
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
          || (has(state, "antigravity_import") && state.antigravity_import !== null &&
            (!isDict(state.antigravity_import) || Object.keys(state.antigravity_import).sort().join(",") !== "created,owned,selected,separator" ||
              typeof need(state.antigravity_import, "created") !== "boolean" || typeof need(state.antigravity_import, "owned") !== "boolean" || typeof need(state.antigravity_import, "selected") !== "boolean" ||
              typeof need(state.antigravity_import, "separator") !== "boolean"))
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
          ? "PostToolUse" : typeof key === "string" && (key === "UserPromptSubmit" || key.startsWith("UserPromptSubmit:"))
            ? "UserPromptSubmit" : has(entry, "matcher") ? "PreToolUse" : "Stop");
        const expectedKey = claudeHookKey(event, matcher);
        const bareKey = event === "PreToolUse" && key === matcher;
        if (names !== (["Stop", "UserPromptSubmit"].includes(event) ? "hooks" : "hooks,matcher") ||
            !(CLAUDE_HOOK_MATCHERS[event]?.includes(matcher) ||
              (event === "PreToolUse" && LEGACY_PRETOOLUSE_MATCHERS.has(matcher)) ||
              (event === "PostToolUse" && matcher === "mcp__t3[-_]code__preview_open")) || hookKeys.has(expectedKey) ||
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
        if (!(names === "hooks,matcher" || names === "hooks" || (names === "event,hooks" && entry.event === "UserPromptSubmit"))
            || (has(entry, "matcher") && !CODEX_HOOK_MATCHERS.includes(entry.matcher) && entry.matcher !== "Read|Grep|Glob")
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

  preflight({ uninstall = false, status = false, config = true } = {}) {
    const state = this.load();
    for (const file of [this.shared, this.claude, this.launcher]) inspect(file, this.home);
    inspect(this.codex, this.home, { link: true });
    if (this.antigravity || state?.antigravity_import?.selected || state?.antigravity_import?.owned) inspect(this.gemini, this.home);
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
    if (state?.antigravity_import?.owned && splitByteLines(read(this.gemini)).filter(isAgyIncludeLine).length !== 1) {
      throw new Conflict("managed Antigravity include missing or modified; restore it in ~/.gemini/AGENTS.md, then rerun agent-workbench install");
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
    if (uninstall) {
      const current = present(this.workersPath) ? read(this.workersPath) : null;
      const drift = this.resolvedWorkersDrift(state, current);
      if (drift) throw new Conflict(`resolved Worker configuration is ${drift}: ${this.workersPath}; run agent-workbench install to regenerate it, then retry uninstall`);
    }
    if (!uninstall) {
      this.desiredAgents({ warn: false, config });
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
    let workersAside;
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
      const agySelected = this.antigravity || state?.antigravity_import?.selected === true;
      let gemini = null;
      let agyOwned = Boolean(state?.antigravity_import?.owned);
      let agySeparator = Boolean(state?.antigravity_import?.separator);
      let agyCreated = Boolean(state?.antigravity_import?.created);
      if (agySelected || agyOwned) {
        if (!state?.antigravity_import?.selected && !state?.antigravity_import?.owned) agyCreated = !present(this.gemini);
        gemini = read(this.gemini);
        const agyLine = Buffer.concat([AGY_IMPORT, Buffer.from("\n")]);
        const hasAgyLine = splitByteLines(gemini).some(isAgyIncludeLine);
        if (agySelected && !hasAgyLine) {
          agySeparator = gemini.length > 0 && gemini[gemini.length - 1] !== 0x0a;
          gemini = Buffer.concat([gemini, agySeparator ? Buffer.from("\n") : Buffer.alloc(0), agyLine]);
          agyOwned = true;
        } else if (!agySelected && agyOwned) {
          gemini = removeAgyInclude(gemini, agySeparator);
          agyOwned = false;
          agySeparator = false;
        }
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
      const bundle = this.workersBundle();
      const workersBytes = bundle ? Buffer.from(dumps(bundle, { indent: 2 }) + "\n") : null;
      const currentWorkers = present(this.workersPath) ? read(this.workersPath) : null;
      const workersDrift = this.resolvedWorkersDrift(state, currentWorkers);
      if (workersDrift && workersBytes === null) {
        throw new Conflict(`resolved Worker configuration is ${workersDrift}: ${this.workersPath}; ${WORKERS_SOURCE_MISSING}`);
      }
      if (workersDrift === "edited") workersAside = `${this.workersPath}.edited-${new Date().toISOString()}`;
      for (const name of ["shared", "codex", "claude", "launcher"]) this.backup(name, this[name]);
      for (const file of nativePlans.keys()) this.backup(this.backupName(file), file);
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
        antigravity_import: { created: agyCreated, owned: agyOwned, selected: agySelected, separator: agySeparator },
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
      if (agySelected || agyOwned || state?.antigravity_import?.owned) plans.set(this.gemini, ["file", gemini, 0o600]);
      const agents = new Map();
      for (const name of new Set([...Object.keys(state ? state.agents : {}), ...Object.keys(desired)])) {
        agents.set(this.agentPath(name), has(desired, name) ? ["file", desired[name], 0o600] : ["absent", null, null]);
      }
      if (workersBytes !== null) agents.set(this.workersPath, ["file", workersBytes, 0o600]);
      else if (state && state.workers_hash) agents.set(this.workersPath, ["absent", null, null]);
      for (const [file, plan] of agents) plans.set(file, plan);
      for (const [file, plan] of nativePlans) plans.set(file, plan);
      let publishedAside;
      if (workersAside) plans.set(workersAside, ["file", currentWorkers, 0o600, () => {
        if (!publishedAside) return false;
        const current = fs.lstatSync(workersAside, { throwIfNoEntry: false });
        return current?.dev === publishedAside.dev && current.ino === publishedAside.ino;
      }]);
      transaction(plans, () => {
        if (workersAside) atomic(workersAside, currentWorkers, 0o600, (temporary, aside) => {
          const info = fs.lstatSync(temporary);
          try { fs.linkSync(temporary, aside); }
          catch (error) {
            if (error.code !== "EEXIST") throw error;
            throw new Conflict(`resolved Worker configuration backup already exists: ${aside}; rerun agent-workbench install`);
          }
          publishedAside = info;
        });
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
        if (agySelected || agyOwned || state?.antigravity_import?.owned) changed = atomic(this.gemini, gemini) || changed;
        changed = atomic(this.statePath, stateBytes) || changed;
      });
    });
    if (workersAside) console.log(`Regenerated resolved Worker configuration and saved the previous file to ${workersAside}`);
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
    const currentWorkers = present(this.workersPath) ? read(this.workersPath) : null;
    const workersDrift = this.resolvedWorkersDrift(state, currentWorkers);
    const workersRecovery = present(this.models) ? "install will regenerate" : WORKERS_SOURCE_MISSING;
    const workersStatus = workersDrift ? `${workersDrift} (${workersRecovery})` : state.workers_hash ? "applied" : "not installed";
    const report = {
      installed_version: state.version, available_version: VERSION,
      installed_template_hash: state.template_hash,
      available_template_hash: digest(template),
      native_settings: nativeStatus, hooks: hookStatus, codex_hooks: codexHookStatus,
      codex_trust: {},
      resolved_workers: workersStatus,
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
        const label = status === "applied" || status === "trusted" || status === "not installed" || status.startsWith("skipped:") ? "ok" : status === "missing" || status.startsWith("missing (") || status === "untrusted" ? "missing" : "conflict";
        console.log(`${label}  ${name}: ${status}${label === "ok" || !fix ? "" : `; ${fix}`}`);
      };
      line("setup", state.version === VERSION ? "applied" : "missing", "run agent-workbench install to apply update");
      line("resolved Worker configuration", workersStatus);
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
      let gemini = null;
      if (state.antigravity_import?.owned) gemini = removeAgyInclude(read(this.gemini), state.antigravity_import.separator);
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
      if (state.antigravity_import?.owned) plans.set(this.gemini,
        state.antigravity_import.created && gemini.length === 0 ? ["absent", null, null] : ["file", gemini, 0o600]);
      transaction(plans, () => {
        for (const [file, plan] of nativePlans) atomic(file, plan[1]);
        if (state.antigravity_import?.owned) {
          if (state.antigravity_import.created && gemini.length === 0) {
            fs.unlinkSync(this.gemini);
            syncDir(path.dirname(this.gemini));
          } else atomic(this.gemini, gemini);
        }
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
    // The installed config may need the refresh before it can be validated.
    this.preflight({ config: false });
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
    const personalName = path.basename(this.personal);
    try {
      native = JSON.parse(utf8(read(lockFile)));
      const skills = native.skills;
      if (native.version !== 3 || !isDict(skills)) throw new TypeError("unsupported lock");
      names = Object.entries(skills).filter(([name, item]) => {
        if (!isDict(item)) throw new TypeError("invalid skill entry");
        return name === personalName || (item.source === SOURCE && item.sourceType === "github");
      }).map(([name]) => name).sort();
      if (!names.includes("workbench-setup") || names.some((name) => !name || name.startsWith("-") || name.includes("/"))) {
        throw new TypeError("setup ownership is missing or names are invalid");
      }
    } catch {
      throw new Conflict("unsupported native skills lock or missing repository ownership; restore a supported native skills lock, then rerun agent-workbench update");
    }
    // Skills removed upstream and already deleted locally would make the native update warn every run.
    const stale = names.filter((name) => name !== "workbench-setup" && name !== personalName &&
      !present(path.join(this.home, ".agents/skills", name)));
    const args = command ? shellSplit(command) : ["npx", "--yes", "skills@1.7.4"];
    if (!args.length) throw new Conflict("empty skills command; provide an executable command with --skills-cmd");
    this.withLock(() => {
      this.preflight({ config: false });
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
      // Config is left to the fresh install process: this process may predate new keys.
      this.preflight({ config: false });
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

const LEGACY_ANTIGRAVITY_MATCHER = "^(run_command|mcp_t3-code_(delegate_task|t3_thread_send)|invoke_subagent|define_subagent|swarm|run_workflow)$";
const ANTIGRAVITY_MANAGER_TOOLS = "run_command|write_to_file|replace_file_content|multi_replace_file_content|generate_image|" +
  "view_file|list_dir|find_by_name|grep_search|read_url_content|" +
  "mcp_t3-code_(delegate_task|t3_thread_(send|launch|configure)|create_threads|schedule_task|watch_pull_request|(t3_)?preview_.+)|" +
  "invoke_subagent|define_subagent|swarm|run_workflow";
const LEGACY_ANTIGRAVITY_MANAGER_MATCHER = `^(${ANTIGRAVITY_MANAGER_TOOLS})$`;
const ANTIGRAVITY_MATCHER = "^(write_file|edit_file|create_file|delete_file|file_delete|client_edit_file|" +
  `schedule|manage_task|manage_subagents|${ANTIGRAVITY_MANAGER_TOOLS})$`;

function validAntigravityGroup(group) {
  if (!isDict(group) || Object.keys(group).sort().join(",") !== "PreToolUse,enabled" || group.enabled !== true ||
      !Array.isArray(group.PreToolUse) || group.PreToolUse.length !== 1) return false;
  const [entry] = group.PreToolUse;
  if (!isDict(entry) || Object.keys(entry).sort().join(",") !== "hooks,matcher" ||
      !["run_command", LEGACY_ANTIGRAVITY_MATCHER, LEGACY_ANTIGRAVITY_MANAGER_MATCHER, ANTIGRAVITY_MATCHER].includes(entry.matcher) ||
      !Array.isArray(entry.hooks) || entry.hooks.length !== 1) return false;
  const [handler] = entry.hooks;
  if (!isDict(handler) || Object.keys(handler).sort().join(",") !== "command,type" || handler.type !== "command" ||
      typeof handler.command !== "string") return false;
  try {
    const parts = shellSplit(handler.command);
    const validArgs = entry.matcher === "run_command" ? parts.length === 4
      : parts.length === 6 && parts[4] === "--workers" && path.isAbsolute(parts[5]);
    return validArgs && path.isAbsolute(parts[0]) && path.isAbsolute(parts[1]) &&
      parts[2] === "--host" && parts[3] === "antigravity" && parts.map(shellQuote).join(" ") === handler.command;
  } catch {
    return false;
  }
}

function antigravityWorkspace(workspace, setup, remove = false) {
  const root = path.resolve(workspace);
  const hooksFile = path.join(root, ".agents/hooks.json");
  const ownershipDir = path.join(setup.root, "antigravity-workspaces");
  const ownershipFile = path.join(ownershipDir, `${digest(Buffer.from(root))}.json`);
  inspect(hooksFile, root);
  inspect(ownershipFile, setup.home);

  return setup.withLock(() => {
    const hooksBefore = snapshot(hooksFile);
    const ownershipBefore = snapshot(ownershipFile);
    if (!["absent", "file"].includes(hooksBefore[0]) || !["absent", "file"].includes(ownershipBefore[0])) {
      throw new Conflict("Antigravity hook or ownership path changed to an unsafe file type; resolve it manually before retrying");
    }
    let owned;
    if (ownershipBefore[0] === "file") {
      let record;
      try { record = JSON.parse(utf8(ownershipBefore[1])); }
      catch { throw new Conflict(`invalid Antigravity workspace ownership record: ${ownershipFile}; preserve it and resolve it manually`); }
      if (!isDict(record) || Object.keys(record).sort().join(",") !== "group,schema,workspace" ||
          record.schema !== 1 || record.workspace !== root || !validAntigravityGroup(record.group)) {
        throw new Conflict(`invalid Antigravity workspace ownership record: ${ownershipFile}; preserve it and resolve it manually`);
      }
      owned = record.group;
    }

    let config = {};
    if (hooksBefore[0] === "file") {
      try { config = JSON.parse(utf8(hooksBefore[1])); }
      catch { throw new Conflict(`invalid Antigravity hooks configuration: ${hooksFile}; correct hooks.json, then retry`); }
      if (!isDict(config)) throw new Conflict(`invalid Antigravity hooks configuration: ${hooksFile}; correct hooks.json, then retry`);
    }
    const hasGroup = has(config, "agent-workbench");
    const current = config["agent-workbench"];

    if (remove) {
      if (!owned) return;
      if (hasGroup && !isDeepStrictEqual(current, owned)) {
        throw new Conflict(`Agent Workbench Antigravity hook was changed: ${hooksFile}; restore the recorded group or resolve it manually before uninstalling`);
      }
      const { ["agent-workbench"]: ignored, ...remaining } = config;
      const plans = new Map([[ownershipFile, ["absent", null, null]]]);
      if (hasGroup) plans.set(hooksFile, ["file", Buffer.from(JSON.stringify(remaining, null, 2) + "\n"), 0o600]);
      return transaction(plans, () => {
        if (!unchangedSnapshot(hooksFile, hooksBefore) || !unchangedSnapshot(ownershipFile, ownershipBefore)) {
          throw new Conflict("Antigravity hooks or ownership changed during removal; no further changes were made");
        }
        if (hasGroup) atomic(hooksFile, plans.get(hooksFile)[1], 0o600);
        fs.unlinkSync(ownershipFile);
        syncDir(path.dirname(ownershipFile));
      });
    }

    if (hasGroup && !owned) {
      throw new Conflict(`hooks.json already contains an unowned agent-workbench group: ${hooksFile}; resolve it manually; the existing hook was not adopted`);
    }
    if (hasGroup && !isDeepStrictEqual(current, owned)) {
      throw new Conflict(`Agent Workbench Antigravity hook conflicts with its ownership record: ${hooksFile}; changed configuration was left untouched`);
    }

    let group = owned;
    if (owned?.PreToolUse[0].matcher !== ANTIGRAVITY_MATCHER) {
      const adapter = path.resolve(setup.policyHook);
      let info;
      try { info = fs.statSync(adapter); } catch {}
      if (!info?.isFile() || !(info.mode & 0o111)) {
        throw new Conflict(`Antigravity policy adapter is not installed or executable: ${adapter}; install orchestrate-harnesses, then retry`);
      }
      const command = [path.resolve(process.execPath), adapter, "--host", "antigravity", "--workers", setup.workersPath].map(shellQuote).join(" ");
      group = { enabled: true, PreToolUse: [{ matcher: ANTIGRAVITY_MATCHER, hooks: [{ type: "command", command }] }] };
    } else if (hasGroup) return;

    mkdirLeaf(ownershipDir, 0o700);
    const record = Buffer.from(JSON.stringify({ schema: 1, workspace: root, group }, null, 2) + "\n");
    const hookBytes = Buffer.from(JSON.stringify({ ...config, "agent-workbench": group }, null, 2) + "\n");
    const plans = new Map([[hooksFile, ["file", hookBytes, 0o600]], [ownershipFile, ["file", record, 0o600]]]);
    return transaction(plans, () => {
      if (!unchangedSnapshot(hooksFile, hooksBefore) || !unchangedSnapshot(ownershipFile, ownershipBefore)) {
        throw new Conflict("Antigravity hooks or ownership changed during installation; no further changes were made");
      }
      atomic(hooksFile, hookBytes, 0o600);
      atomic(ownershipFile, record, 0o600);
    });
  });
}

const COMMANDS = {
  install: "Apply shared instructions, hooks and settings and regenerate missing or edited workers.json (use --antigravity to include instructions in Antigravity)",
  update: "Update distributed skills, then apply them and regenerate missing or edited workers.json",
  status: "Check installed files and settings, including whether workers.json needs regeneration (supports --json)",
  lanes: "Show open PRs and local worktrees (supports --cwd and --json)",
  trust: "Trust installed Codex policy hooks",
  uninstall: "Remove managed setup while keeping private files",
  workers: "Show effective worker configuration",
  ops: "Run host operations",
  version: "Print the installed Agent Workbench version",
};
const USAGE = "usage: workbench.mjs [--home HOME] [--skills-cmd SKILLS_CMD] [--cwd CWD] " +
  `{${Object.keys(COMMANDS).join(",")}}`;

function parseArguments(argv) {
  const options = { home: os.homedir(), skillsCmd: undefined, cwd: process.cwd(), workspace: undefined, command: undefined, json: false, antigravity: false, help: false, helpCommand: undefined };
  const fail = (message) => {
    console.error(`${USAGE}\nworkbench.mjs: error: ${message}`);
    process.exit(2);
  };
  const flags = { "--home": "home", "--skills-cmd": "skillsCmd", "--cwd": "cwd", "--workspace": "workspace" };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--help" || argv[index] === "-h") {
      options.help = true;
      if (options.command) options.helpCommand = options.command;
      continue;
    }
    if (argv[index] === "--json") { options.json = true; continue; }
    if (argv[index] === "--antigravity") { options.antigravity = true; continue; }
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
  if (options.workspace !== undefined && (!options.antigravity || !["install", "uninstall"].includes(options.command))) {
    fail("--workspace requires install or uninstall with --antigravity");
  }
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
    console.log(`${opsHelp}\n       agent-workbench ops run-once <job-id>`);
  } else if (!command) {
    console.log(`${USAGE}\n\nCommands:`);
    for (const [name, description] of Object.entries(COMMANDS)) console.log(`  ${name.padEnd(10)} ${description}`);
    console.log("\nUse workbench.mjs help <command> for command options.");
  } else {
    const args = command === "lanes" ? " [--cwd CWD] [--json]" : command === "workers" ? " [--cwd CWD]" : command === "update" ? " [--skills-cmd SKILLS_CMD]" : command === "status" ? " [--json]" : command === "install" ? " [--antigravity] [--workspace PATH]" : command === "uninstall" ? " [--antigravity] [--workspace PATH]" : "";
    console.log(`usage: workbench.mjs [--home HOME]${args} ${command}\n\n${COMMANDS[command]}`);
  }
}

export function cliErrorMessage(error, command) {
  const message = error.message;
  if (command === "update" && /^unknown keys in policy: stop_classifier(?:;|$)/.test(message)) {
    return `${message}\nThe installed skills may be on mixed versions; run agent-workbench install to refresh setup. Your settings do not need to be deleted.`;
  }
  return message;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (args.help) { printHelp(args.helpCommand ?? (args.command === "help" ? undefined : args.command)); return 0; }
  try {
    if (args.command === "version") { console.log(RELEASE); return 0; }
    if (args.command === "ops") {
      const home = path.resolve(args.home);
      if (args.ops[0] === "run-once") return runOnceCommand(args.ops.slice(1), home);
      return runOps(args.ops, home);
    }
    if (args.command === "lanes") { showLanes(args); return 0; }
    if (args.workspace !== undefined && args.command === "uninstall") {
      antigravityWorkspace(args.workspace, new Setup(args.home), true);
      return 0;
    }
    const setup = new Setup(args.home, { antigravity: args.antigravity });
    if (args.command === "workers") setup.workers(args.cwd);
    else if (args.command === "update") return setup.update(args.skillsCmd);
    else if (args.command === "status") setup.status({ json: args.json });
    else setup[args.command]();
    if (args.workspace !== undefined) antigravityWorkspace(args.workspace, setup);
    return 0;
  } catch (error) {
    console.error(`agent-workbench: ${cliErrorMessage(error, args.command)}`);
    return 1;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
