// Enforce Worker, GitHub polling, and user-question policies, and stamp WB_MSG footers.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APPROVAL = "L3 Opus Worker needs the user's approval for this task (orchestrate-harnesses Worker ladder).";
const PROTECTED_BRANCH_REASON = "The local main branch is protected. Use a task branch, origin/main, " +
  "or git switch -c <task> origin/main.";
const PROTECTED_BRANCHES = new Set(["main", "master"]);
const POLLING = "GitHub polling is disabled. Use watch_pull_request and the single-call status reads " +
  "in orchestrate-harnesses' GitHub API budget section.";
const SLEEP_LOOP = "Sleep loops are disabled. Use t3_background_wait or Monitor.";
const CI_LOGS = "Delegate CI logs. Resume the Worker that owns the branch or dispatch an L1 Worker with the run URL.";
const T3_MODEL = "Set target.model (and effort in target.options) for the Worker tier you chose " +
  "before dispatching with delegate_task.";
const THREAD_LAUNCH = "Managers may launch a top-level T3 thread only when the user requests one; " +
  "set nonblank environmentId and projectId and an exact configured L1/L2 model in modelSelection.model. " +
  "Workers must not launch top-level threads. Use a Worker or current-thread wakeup for follow-up work.";
const SCHEDULE_TASK = "New schedule_task calls are unavailable because the current T3 schema has no model selection field. " +
  "Only disable an identified existing schedule here; use the personal automation registry before other automation activation.";
const MANAGER_APPROVAL = "Manager work approval: <link to a Chief PM or owner message>";
const COUNT_EXEMPT = /^(?:mcp__t3[-_]code__)?(?:t3_thread_send|t3_thread_configure|schedule_task|list_scheduled_tasks|delete_scheduled_task|watch_pull_request|t3_queue|send_to_user|t3_pending_request|t3_background_wait|Agent|Task|spawn_agent|delegate_task|AskUserQuestion|ToolSearch|pull_request_merge|pull_request_review|pull_request_respond|link_pull_requests?|unwatch_pull_request|pull_request_create)$/;
const MUTATING_GIT = new Set(["commit", "push", "tag", "merge", "rebase", "reset", "checkout", "switch", "stash", "add"]);
const APPROVAL_LINE = "Get it first (through the Chief PM when one is registered), then add a line " +
  "`L3 approval: <link to the approval>` to the brief and retry.";
const CONFIG_MISSING = "Worker policy configuration is missing or unreadable; rerun agent-workbench install before dispatching Workers.";
const INHERITED_MODEL ="Built-in agents inherit the Manager's model. Use a tier agent " +
  "(subagent_type: <role>) or pass model explicitly.";
const INHERITING_AGENT_TYPES = new Set([undefined, null, "general-purpose", "Plan", "Explore", "claude"]);
const MODEL_OVERRIDE = "model overrides the model in this agent's definition, so a tier agent would run on " +
  "the wrong model. Drop model and let subagent_type select the tier.";
const STOP_REASON = "If this asks the user something, re-ask it with AskUserQuestion, putting the recommended " +
  "option first and offering your best guesses as options for open-ended answers. " +
  "If it is an owner decision and a Chief PM is registered, send it to the Chief PM instead. " +
  "If it was not a question to the user, end the turn without it.";
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const FOOTER = /(?<![^\n])-- WB_MSG\b[^\n]*/g;
const FOOTER_FIELD = /\b(kind|re)=(\S+)/g;

const isDict = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function dict(value) {
  if (!isDict(value)) throw new TypeError("expected an object");
  return value;
}

function t3Identity() {
  const thread = (process.env.T3CODE_THREAD_ID || "").trim();
  const home = process.env.T3CODE_HOME || path.join(os.homedir(), ".t3");
  let environment;
  try {
    environment = fs.readFileSync(path.join(home, "userdata/environment-id"), "utf8").trim();
  } catch {
    return null;
  }
  return environment && thread ? [environment, thread] : null;
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
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

// Lock directory holding the owner pid. When another process keeps it past the retry budget (the
// critical section takes milliseconds) this throws, and the hook passes the message through unstamped.
function withLock(lock, action) {
  let acquired = false;
  for (let attempt = 0; attempt < 100 && !acquired; attempt++) {
    try {
      fs.mkdirSync(lock);
      acquired = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!reclaimStaleLock(lock)) sleep(10);
    }
  }
  if (!acquired) throw new Error("counter lock is busy");
  try {
    fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
    return action();
  } finally {
    releaseLock(lock);
  }
}

function nextSequence(stateDir, thread) {
  const directory = path.join(stateDir, "wbmsg");
  fs.mkdirSync(directory, { recursive: true });
  const counter = path.join(directory, thread.replaceAll("/", "_") + ".seq");
  return withLock(counter + ".lock", () => {
    let text = "";
    try {
      text = fs.readFileSync(counter, "utf8").trim();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (text && !/^[+-]?\d+$/.test(text)) throw new TypeError("invalid counter");
    const value = Number(text || 0) + 1;
    const temporary = `${counter}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, String(value));
    fs.renameSync(temporary, counter);
    return value;
  });
}

function stampFooter(args, stateDir) {
  const message = dict(args).message;
  if (typeof message !== "string") return null;
  const matches = [...message.matchAll(FOOTER)];
  const identity = t3Identity();
  if (!matches.length || identity === null || stateDir === null) return null;
  const last = matches[matches.length - 1];
  const fields = {};
  for (const [, key, value] of last[0].matchAll(FOOTER_FIELD)) fields[key] = value;
  const [environment, thread] = identity;
  const sent = new Date().toISOString().slice(0, 16) + "Z";
  const footer = `-- WB_MSG from=${environment}/${thread} kind=${fields.kind ?? "decision"} sent=${sent} ` +
    `id=${thread.slice(-8)}:${nextSequence(stateDir, thread)} re=${fields.re ?? "none"}`;
  return { ...args, message: message.slice(0, last.index) + footer + message.slice(last.index + last[0].length) };
}

// Port of Python shlex (posix mode, punctuation_chars=";|&()\n", whitespace " \t\r", commenters "#").
const PUNCTUATION = ";|&()\n";
const WHITESPACE = " \t\r";
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WORDCHARS = new Set(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_" +
  "ßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞ" + "~-./*?=");

function shlex(text, whitespaceSplit) {
  const chars = Array.from(text);
  const pushback = [];
  let position = 0;
  const tokens = [];
  const read = () => (pushback.length ? pushback.pop() : position < chars.length ? chars[position++] : "");
  const skipLine = () => {
    let character;
    while ((character = read()) !== "" && character !== "\n");
    if (character === "\n") pushback.push(character);
  };
  const assignmentExpansion = () => {
    const open = read();
    if (open !== "(" && open !== "{") {
      if (open) pushback.push(open);
      return "$";
    }
    const close = open === "(" ? ")" : "}";
    let expansion = "$" + open;
    let depth = 1;
    let quote = "";
    while (depth) {
      const character = read();
      if (!character) throw new Error("Unclosed assignment expansion");
      expansion += character;
      if (character === "\\" && quote !== "'") expansion += read();
      else if (quote) {
        if (character === quote) quote = "";
      } else if (["'", '"', "`"].includes(character)) quote = character;
      else if (character === open) depth++;
      else if (character === close) depth--;
    }
    return expansion;
  };
  for (;;) {
    let state = " ";
    let escapedState = " ";
    let quoted = false;
    let token = "";
    let eof = false;
    for (;;) {
      const next = read();
      if (state === " ") {
        if (!next) { eof = true; break; }
        if (WHITESPACE.includes(next)) {
          if (token || quoted) break;
        } else if (next === "#") {
          skipLine();
        } else if (next === "\\") {
          escapedState = "a";
          state = next;
        } else if (WORDCHARS.has(next)) {
          token = next;
          state = "a";
        } else if (PUNCTUATION.includes(next)) {
          token = next;
          state = "c";
        } else if (next === "'" || next === '"') {
          state = next;
        } else if (whitespaceSplit) {
          token = next;
          state = "a";
        } else {
          token = next;
          break;
        }
      } else if (!whitespaceSplit && next === "$" && (state === "a" || state === '"') && ASSIGNMENT.test(token)) {
        token += assignmentExpansion();
      } else if (state === "'" || state === '"') {
        quoted = true;
        if (!next) throw new Error("No closing quotation");
        if (next === state) state = "a";
        else if (next === "\\" && state === '"') {
          escapedState = state;
          state = next;
        } else token += next;
      } else if (state === "\\") {
        if (!next) throw new Error("No escaped character");
        if ((escapedState === "'" || escapedState === '"') && next !== state && next !== escapedState) token += state;
        token += next;
        state = escapedState;
      } else {
        if (!next) { eof = true; break; }
        if (WHITESPACE.includes(next)) {
          state = " ";
          if (token || quoted) break;
        } else if (next === "#") {
          skipLine();
          state = " ";
          if (token || quoted) break;
        } else if (state === "c") {
          if (PUNCTUATION.includes(next)) token += next;
          else {
            pushback.push(next);
            break;
          }
        } else if (next === "'" || next === '"') {
          state = next;
        } else if (next === "\\") {
          escapedState = "a";
          state = next;
        } else if (WORDCHARS.has(next) || (whitespaceSplit && !PUNCTUATION.includes(next))) {
          token += next;
        } else {
          pushback.push(next);
          state = " ";
          if (token || quoted) break;
        }
      }
    }
    if (eof && !token && !quoted) return tokens;
    tokens.push(token);
    if (eof) return tokens;
  }
}

const punctuationOnly = (token) => [...token].every((char) => PUNCTUATION.includes(char));
const SHELL_WORD_SEPARATOR = /[\s;|&()$`"']/.source;
const shellWords = (pattern) => new RegExp(`(?:^|${SHELL_WORD_SEPARATOR})${pattern}(?=$|${SHELL_WORD_SEPARATOR})`);
const LOOP_WORD = shellWords("(?:while|until)");
const SLEEP_WORD = shellWords("sleep");
const GH_WORD = shellWords("gh");
const GH_RUN_VIEW = shellWords("gh\\s+run\\s+view");
const GH_RUN_DOWNLOAD = shellWords("gh\\s+run\\s+download");

function textShellPolicy(command, manager) {
  // Scan the full text, including substitutions. Quoted examples and heredocs can also match.
  if (manager) {
    const text = command.replace(/["']/g, "");
    const view = GH_RUN_VIEW.exec(text);
    if ((view && /(?<![\w-])--log(?:-failed)?(?![\w-])/.test(text.slice(view.index + view[0].length))) ||
        GH_RUN_DOWNLOAD.test(text) ||
        /\bactions\/(?:jobs\/[^/\s]+|runs\/[^/\s]+(?:\/attempts\/[^/\s]+)?)\/logs\b/.test(text)) return CI_LOGS;
  }
  if (LOOP_WORD.test(command) && SLEEP_WORD.test(command)) return SLEEP_LOOP;
  return null;
}

function commandWords(words) {
  let start = 0;
  while (start < words.length) {
    const word = words[start];
    if (ASSIGNMENT.test(word) || word === "env" || word === "command") start++;
    else if (word === "timeout" && /^\d+(?:\.\d+)?[smhd]?$/.test(words[start + 1])) start += 2;
    else break;
  }
  return words.slice(start);
}

function pollsGithub(command) {
  if (typeof command !== "string") throw new TypeError("command must be a string");
  const tokens = [];
  for (const token of shlex(command, false)) {
    if (token && punctuationOnly(token)) tokens.push(...token);
    else tokens.push(token);
  }
  const prefixes = new Set(["do", "then", "else", "if", "elif", "!", "while", "until"]);
  const commands = [];
  const loops = [];
  const stack = [];
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index];
    if (["while", "until", "for"].includes(token)) stack.push(index);
    else if (token === "done" && stack.length) loops.push([stack.pop(), index]);
    if (prefixes.has(token) || (token && punctuationOnly(token))) {
      index++;
      continue;
    }
    let end = index + 1;
    while (end < tokens.length && (!tokens[end] || !punctuationOnly(tokens[end]))) end++;
    commands.push([index, commandWords(tokens.slice(index, end))]);
    index = end;
  }
  for (const [, words] of commands) {
    const [program, group, operation, ...args] = words;
    if (program !== "gh") continue;
    if (group === "run" && operation === "watch") return POLLING;
    if (group === "pr" && operation === "checks" &&
        args.some((word) => word === "--watch" || word.startsWith("--watch="))) return POLLING;
  }
  if (SLEEP_WORD.test(command) && GH_WORD.test(command)) {
    for (const [start, end] of loops) {
      const loopTokens = tokens.slice(start, end);
      if (!loopTokens.includes("do")) continue;
      // Assignment tokens can hide commands inside a substitution from the argv check.
      const contains = (program, word) => commands.some(([index, words]) =>
        start < index && index < end && words[0] === program) || loopTokens.some((token) =>
        ASSIGNMENT.test(token) && token.includes("$(") && word.test(token));
      if (contains("sleep", SLEEP_WORD) && contains("gh", GH_WORD)) return `${POLLING} ${SLEEP_LOOP}`;
    }
  }
  return null;
}

function shellCommands(command) {
  if (typeof command !== "string") throw new TypeError("command must be a string");
  const raw = [];
  for (const token of shlex(command, true)) {
    if (token && punctuationOnly(token)) raw.push(...token);
    else raw.push(token);
  }
  const tokens = [];
  for (let index = 0; index < raw.length;) {
    if (raw[index] === "&" && raw[index + 1] === "&") {
      tokens.push("&&");
      index += 2;
    } else if (raw[index] === "|" && raw[index + 1] === "|") {
      tokens.push("||");
      index += 2;
    } else tokens.push(raw[index++]);
  }
  const separators = new Set([";", "|", "&", "&&", "||", "(", ")", "\n", "do", "then", "!", "while", "until"]);
  const commands = [];
  let current = [];
  let cdPrefix = null;
  for (const token of tokens) {
    if (separators.has(token)) {
      if ((token === "&&" || token === "||") && current.length && current[0] === "cd") {
        cdPrefix = [...current, token];
        current = [];
        continue;
      }
      if (current.length) {
        commands.push([...(cdPrefix || []), ...current]);
        cdPrefix = null;
        current = [];
      }
    } else current.push(token);
  }
  if (current.length) commands.push([...(cdPrefix || []), ...current]);
  return commands;
}

// Return git argv, honoring `git -C <directory> ...`.
function gitCommand(words) {
  if (!words.length || words[0] !== "git") return [null, null];
  let argv = words.slice(1);
  let directory = null;
  while (argv.length >= 2 && argv[0] === "-C") {
    directory = argv[1];
    argv = argv.slice(2);
  }
  return [argv, directory];
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

function resolveGitContext(event, gitCwd, cdCwd) {
  const cwd = event.cwd || process.cwd();
  if (gitCwd) return path.isAbsolute(gitCwd) ? gitCwd : resolvePath(path.join(cwd, gitCwd));
  if (cdCwd) return path.isAbsolute(cdCwd) ? cdCwd : resolvePath(path.join(cwd, cdCwd));
  return resolvePath(cwd);
}

function currentBranch(directory) {
  const result = spawnSync("git", ["-C", directory, "symbolic-ref", "--quiet", "--short", "HEAD"],
    { encoding: "utf8", timeout: 2000 });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

function protectedBranchGit(command, event) {
  for (let words of shellCommands(command)) {
    const cdCwd = words.length >= 4 && words[0] === "cd" && (words[2] === "&&" || words[2] === "||") ? words[1] : null;
    if (cdCwd) words = words.slice(3);
    const [argv, gitCwd] = gitCommand(words);
    if (!argv || !argv.length) continue;
    const directory = resolveGitContext(event, gitCwd, cdCwd);
    const operation = argv[0];
    const args = argv.slice(1);
    if ((operation === "checkout" || operation === "switch") && args.length) {
      let branch = null;
      if ((args[0] === "-B" || args[0] === "-C") && args.length > 1) branch = args[1];
      else if (args[0] === "-b" || args[0] === "-c") branch = null;
      else if (args[0] === "-f" && args.length > 1) branch = args[1];
      else if (args[0].startsWith("-")) continue;
      else branch = args[0];
      if (PROTECTED_BRANCHES.has(branch)) {
        // `git checkout <branch> [--] <paths>` restores files, it does not switch branches.
        if (operation === "checkout" && args.length > 1 && !["-B", "-b", "-f"].includes(args[0])) continue;
        return PROTECTED_BRANCH_REASON;
      }
    }
    if (operation === "worktree" && args.length >= 3 && args[0] === "add") {
      const branchArgs = args.slice(1);
      if (branchArgs.includes("-b") || branchArgs.includes("-B")) continue;
      if (PROTECTED_BRANCHES.has(branchArgs[branchArgs.length - 1])) return PROTECTED_BRANCH_REASON;
    }
    if (operation === "push") {
      const refs = args.filter((arg) => !arg.startsWith("-"));
      const refspecs = refs.slice(1).map((ref) => ref.replace(/^\+*/, ""));
      const branchOf = (ref) => (ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref);
      const source = (ref) => ref.split(":")[0];
      const destination = (ref) => (ref.includes(":") ? ref.slice(ref.indexOf(":") + 1) : ref);
      if (refspecs.some((ref) => PROTECTED_BRANCHES.has(branchOf(destination(ref))) ||
          PROTECTED_BRANCHES.has(branchOf(source(ref))))) return PROTECTED_BRANCH_REASON;
      // With no refspec, or a HEAD/@ source, the pushed branch is the current one.
      if (refspecs.length && !refspecs.some((ref) => ["HEAD", "@"].includes(source(ref)))) continue;
    } else if (!["commit", "merge", "rebase", "cherry-pick", "revert", "reset", "am"].includes(operation)) {
      continue;
    }
    if (PROTECTED_BRANCHES.has(currentBranch(directory))) return PROTECTED_BRANCH_REASON;
  }
  return null;
}

function lastAssistantText(event) {
  const message = event.last_assistant_message;
  if (typeof message === "string") return message;
  const file = event.transcript_path;
  if (typeof file !== "string") return "";
  let tail;
  const descriptor = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(descriptor).size;
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    tail = Buffer.alloc(length);
    fs.readSync(descriptor, tail, 0, length, size - length);
  } finally {
    fs.closeSync(descriptor);
  }
  const entries = [];
  for (const line of tail.toString("utf8").split(/\r\n|\r|\n/)) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (isDict(entry) && entry.type === "assistant") entries.push(entry);
  }
  for (const entry of entries.reverse()) {
    const content = entry.message === undefined ? [] : dict(entry.message).content ?? [];
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((block) => isDict(block) && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
    if (text) return text;
  }
  return "";
}

function normalizeModel(model) {
  return model.replace(/\[1m\]$/, "").split("/").at(-1).replace(/^auto-/, "");
}

function postToolModelContext(workers, event) {
  try {
    const response = dict(event.tool_response);
    const launched = response.status === "async_launched";
    if (!launched && (response.status !== "completed" || typeof response.agentId !== "string" ||
        !/^[a-zA-Z0-9_-]+$/.test(response.agentId) || typeof event.transcript_path !== "string")) return null;
    const agentType = launched ? event.tool_input?.subagent_type : response.agentType;
    if (typeof agentType !== "string" || workers === null) return null;
    const bundle = JSON.parse(fs.readFileSync(workers, "utf8"));
    const { config } = selectWorkerProfile(bundle, event);
    const tier = config.tiers[agentType];
    if (!tier) return null;
    const configured = tier.harness === "codex" ? tier.claude_route : tier.model;
    if (configured == null) return null;
    const alias = /^(haiku|sonnet|opus|fable)$/.test(configured);
    const expected = alias ? process.env[`ANTHROPIC_DEFAULT_${configured.toUpperCase()}_MODEL`]?.trim() || null : configured;
    if (launched) {
      const model = response.resolvedModel;
      if (typeof model !== "string" || !model || model === expected) return null;
      if (expected === null) return `The ${agentType} Worker launched with resolved model ${model}.`;
      return `The ${agentType} Worker expected ${expected} but launched with resolved model ${model}; report the resolved model.`;
    }
    const transcript = event.transcript_path.replace(/\.jsonl$/, "") +
      `/subagents/agent-${response.agentId}.jsonl`;
    const descriptor = fs.openSync(transcript, "r");
    let content;
    try {
      const size = fs.fstatSync(descriptor).size;
      const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      fs.readSync(descriptor, buffer, 0, length, size - length);
      content = buffer.toString("utf8");
    } finally {
      fs.closeSync(descriptor);
    }
    const models = new Set();
    for (const line of content.split(/\r\n|\r|\n/)) {
      try {
        const entry = JSON.parse(line);
        if (isDict(entry) && entry.type === "assistant" && isDict(entry.message) &&
            typeof entry.message.model === "string") models.add(entry.message.model);
      } catch {}
    }
    const actual = [...new Set([response.resolvedModel, ...models].filter((model) => typeof model === "string"))];
    if (expected === null) return actual.length ? `The ${agentType} Worker reported model(s) ${actual.join(", ")}.` : null;
    const mismatches = [];
    if (response.resolvedModel !== expected) mismatches.push(response.resolvedModel ?? "unknown requested model");
    for (const model of models) {
      if (normalizeModel(model) !== normalizeModel(expected) && !mismatches.includes(model)) mismatches.push(model);
    }
    if (!mismatches.length) return null;
    return `The ${agentType} Worker expected ${expected} but ran on ${actual.join(", ") || mismatches.join(", ")}; report the real model.`;
  } catch {
    return null;
  }
}

function endsWithQuestion(text) {
  const trimmed = text.replace(/[\s*_`~]+$/, "");
  return trimmed.endsWith("?") || trimmed.endsWith("？");
}

function isRelativeTo(child, parent) {
  const base = path.normalize(parent).replace(/(.)\/+$/, "$1");
  return child === base || child.startsWith(base === "/" ? "/" : base + "/");
}

function selectWorkerProfile(bundle, event) {
  const cwd = resolvePath(event.cwd || process.cwd());
  const rule = bundle.select.find((entry) => isRelativeTo(cwd, entry.path));
  const profile = rule?.profile ?? bundle.profile;
  const config = profile ? bundle.profiles[profile] : bundle.base;
  return { config, profile, cwd };
}

function dispatchApproval(file, event, tier) {
  try {
    if (file === null) throw new Error("missing workers path");
    const bundle = JSON.parse(fs.readFileSync(file, "utf8"));
    const { config, profile, cwd } = selectWorkerProfile(bundle, event);
    const known = new Set([bundle.base, ...Object.values(bundle.profiles)].flatMap((item) => Object.keys(item.tiers)));
    if (!known.has(tier) || config.tiers[tier]?.opt_in) return null;
    for (const level of config.ladder) {
      if (level.tiers.includes(tier)) {
        if (level.approval === "required") {
          return `Worker ${tier} at level ${level.level} needs the user's approval for this task (configured Worker ladder).`;
        }
        return null;
      }
    }
    return `Worker ${tier} is not in the ladder for profile ${profile || "base"} at ${cwd}; ` +
      "dispatch it only with the user's approval.";
  } catch {
    return CONFIG_MISSING;
  }
}

// The configured tier whose model or route a delegate_task model names, ignoring a provider prefix
// such as "onsager/auto/" and a context suffix such as "[1m]".
function modelTier(file, event, model) {
  try {
    const { config } = selectWorkerProfile(JSON.parse(fs.readFileSync(file, "utf8")), event);
    const full = String(model).replace(/\[[^\]]*\]$/, "");
    const short = full.split("/").pop();
    for (const [name, tier] of Object.entries(config.tiers)) {
      if (name === full || [tier.model, tier.claude_route].some((value) => value === full || value === short)) return name;
    }
  } catch {
    // Without readable configuration there is no tier to check.
  }
  return null;
}

function launchModelAllowed(file, event, model) {
  if (typeof model !== "string" || !model.trim()) return false;
  try {
    const { config } = selectWorkerProfile(JSON.parse(fs.readFileSync(file, "utf8")), event);
    return config.ladder.some((level) => ["L1", "L2"].includes(level.level) && level.tiers.some((name) => {
      const tier = config.tiers[name];
      return tier && !tier.opt_in && [tier.model, tier.claude_route].some((candidate) =>
        typeof candidate === "string" && candidate.trim() && candidate === model);
    }));
  } catch {
    return false;
  }
}

function isAutomationShellCommand(command) {
  return /(?:^|[;&|]+\s*)(?:sudo\s+)?(?:crontab\b(?!\s+-[lr]\b)|systemctl\s+(?:enable|start|restart|daemon-reload)\b|systemd-run\b|at\b(?!q\b|rm\b)|nohup\b|daemonize\b|setsid\b)/i.test(command);
}

function hasPrWatchTarget(input) {
  if (!isDict(input)) return false;
  if (typeof input.threadId === "string" && input.threadId.trim()) return true;
  if (typeof input.repository === "string" && input.repository.trim() && Number.isInteger(input.number) && input.number > 0) return true;
  if (typeof input.url === "string") {
    try {
      const url = new URL(input.url);
      return url.hostname && url.pathname.split("/").filter(Boolean).length >= 4 &&
        (input.host === undefined || input.host === url.hostname);
    } catch {}
  }
  return false;
}

// Full-access sessions accept "ask" without showing a prompt, so an approval-gated dispatch is denied
// until its brief records where the approval came from. Missing configuration still asks.
function gate(approval, brief) {
  if (!approval) return [undefined, undefined];
  if (approval === CONFIG_MISSING) return ["ask", approval];
  if (/^L3 approval: \S/m.test(String(brief ?? ""))) return [undefined, undefined];
  return ["deny", `${approval} ${APPROVAL_LINE}`];
}

function workersArgument(argv) {
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--workers" && index + 1 < argv.length) return argv[index + 1];
    if (argv[index].startsWith("--workers=")) return argv[index].slice("--workers=".length);
  }
  return null;
}

function hostArgument(argv) {
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--host" && index + 1 < argv.length) return argv[index + 1];
    if (argv[index].startsWith("--host=")) return argv[index].slice("--host=".length);
  }
  return "claude";
}

function managerStatePath(event) {
  const session = event.session_id;
  if (typeof session !== "string" || !/^[A-Za-z0-9_-]+$/.test(session)) return null;
  const root = process.env.AGENT_WORKBENCH_STATE_HOME || process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(root, "agent-workbench", "manager-turns", `${session}.json`);
}

function readManagerState(file) {
  if (!file) return { worker: false, count: 0, approved: false };
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isDict(value) || typeof value.worker !== "boolean" || !Number.isSafeInteger(value.count) ||
        value.count < 0 || typeof value.approved !== "boolean") throw new Error("invalid state");
    return value;
  } catch {
    return { worker: false, count: 0, approved: false };
  }
}

function writeManagerState(file, state) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(state) + "\n", { mode: 0o600 });
}

function managerGateReason(what, file) {
  return `${what} is blocked. Send this step to an L1/L2 Worker (luna first, then sol). ` +
    `A turn whose first message has \`${MANAGER_APPROVAL}\` passes the gate. State file: ${file ?? "invalid session_id"}.`;
}

function mutatingBash(command) {
  // Exclude the common harmless redirections before checking remaining output redirects.
  const redirects = command.replace(/(?:2>\s*\/dev\/null|>\s*\/dev\/null|>&2)/g, "");
  if (/(?:^|[^<])>>?(?!=|&)(?:\s*[^\s;|&]+)/.test(redirects)) return true;
  let commands;
  try { commands = shellCommands(command); } catch { return false; }
  for (const words of commands) {
    const [argv] = gitCommand(words);
    if (argv && MUTATING_GIT.has(argv[0])) return true;
    const [program, operation] = words;
    if (["tee", "rm", "mv", "cp", "mkdir", "touch", "chmod"].includes(program) ||
        (program === "sed" && words.some((word) => word === "-i" || word.startsWith("-i"))) ||
        (["npm", "pnpm", "yarn"].includes(program) && ["install", "publish"].includes(operation)) ||
        (program === "pip" && operation === "install") ||
        (program === "ssh" && words.length > 2)) return true;
  }
  return false;
}

function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

async function shouldBlockQuestion(text, classifier) {
  if (!text) return false;
  if (!classifier) return endsWithQuestion(text);
  try {
    const response = await fetch(classifier.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: classifier.model,
        state: { message: text },
        questions: { asks: {
          type: "choice",
          instructions: "Does this final agent message end by asking the user for a decision, confirmation or answer before work can continue?",
          criteria: { yes: "It asks the user to choose, confirm or answer, and the agent waits for that reply", no: "It reports results or explains, possibly listing follow-ups the user can do on their own; no reply is needed for work to continue" },
        } },
      }),
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return endsWithQuestion(text);
    const body = await response.json();
    const answer = body?.answers?.asks;
    const probabilities = answer?.probabilities;
    if (!isDict(answer) || !["yes", "no"].includes(answer.choice) || !Number.isFinite(answer.confidence) ||
        !isDict(probabilities) || !Number.isFinite(probabilities.yes) || !Number.isFinite(probabilities.no) ||
        probabilities.yes < 0 || probabilities.yes > 1 || probabilities.no < 0 || probabilities.no > 1) {
      return endsWithQuestion(text);
    }
    if (probabilities.yes >= 0.7) return true;
    if (probabilities.no >= 0.7) return false;
  } catch {}
  return endsWithQuestion(text);
}

async function main() {
  const workers = workersArgument(process.argv.slice(2));
  const codex = hostArgument(process.argv.slice(2)) === "codex";
  let decision = null;
  let reason = null;
  try {
    const event = JSON.parse(fs.readFileSync(0, "utf8"));
    if (!isDict(event)) return;
    const stateFile = managerStatePath(event);
    if (event.hook_event_name === "UserPromptSubmit") {
      if (!codex) {
        const previous = readManagerState(stateFile);
        const prompt = typeof event.prompt === "string" ? event.prompt : "";
        writeManagerState(stateFile, {
          worker: previous.worker || /^Role: Worker$/m.test(prompt), count: 0,
          approved: /^Manager work approval: \S/m.test(prompt),
        });
      }
      return;
    }
    if (event.hook_event_name === "PostToolUse") {
      if (event.tool_name !== "Agent" && event.tool_name !== "Task") return;
      const context = postToolModelContext(workers, event);
      if (context) emit({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } });
      return;
    }
    if (event.hook_event_name === "Stop") {
      if (event.stop_hook_active) return;
      try {
        const text = lastAssistantText(event);
        let classifier = null;
        if (workers) {
          try {
            const bundle = JSON.parse(fs.readFileSync(workers, "utf8"));
            classifier = selectWorkerProfile(bundle, event).config.policy.stop_classifier;
          } catch {}
        }
        if (await shouldBlockQuestion(text, classifier)) emit({ decision: "block", reason: STOP_REASON });
      } catch {
        return;
      }
      return;
    }
    if (event.hook_event_name != null && event.hook_event_name !== "PreToolUse") return;
    const tool = event.tool_name;
    const args = "tool_input" in event ? event.tool_input : {};
    const mainLoop = !codex && !event.agent_id;
    let managerState = readManagerState(stateFile);
    const workerContext = managerState.worker || Boolean(event.agent_id);
    const canonicalTool = typeof tool === "string" ? tool.replaceAll("-", "_") : tool;
    const isScheduleTask = canonicalTool === "mcp__t3_code__schedule_task";
    const isThreadLaunch = canonicalTool === "mcp__t3_code__t3_thread_launch";
    const isThreadConfigure = canonicalTool === "mcp__t3_code__t3_thread_configure";
    const isCreateThreads = canonicalTool === "mcp__t3_code__create_threads";
    const isPrWatch = canonicalTool === "watch_pull_request" || canonicalTool === "mcp__t3_code__watch_pull_request";
    const isLocalWakeup = tool === "CronCreate" || (tool === "Skill" && isDict(args) && args.skill === "loop");
    const isLocalAutomation = isLocalWakeup ||
      (tool === "Bash" && isDict(args) && isAutomationShellCommand(args.command ?? ""));
    const configureModelSelection = isThreadConfigure && isDict(args) && Object.hasOwn(args, "modelSelection");
    if (isScheduleTask) {
      const input = isDict(args) ? args : {};
      const safePauseKeys = new Set(["scheduledTaskId", "enabled", "environmentId"]);
      const pauseOnly = typeof input.scheduledTaskId === "string" && input.scheduledTaskId.trim() &&
        input.enabled === false && Object.keys(input).every((key) => safePauseKeys.has(key)) &&
        (input.environmentId === undefined || (typeof input.environmentId === "string" && input.environmentId.trim()));
      if (!pauseOnly) [decision, reason] = ["deny", SCHEDULE_TASK];
    } else if (isPrWatch && !hasPrWatchTarget(args)) {
      [decision, reason] = ["deny", "Bind a PR watch to a repository and pull request, URL, or explicit threadId."];
    } else if ((isThreadLaunch || isCreateThreads || configureModelSelection) && workerContext) [decision, reason] = ["deny", THREAD_LAUNCH];
    else if ((isThreadLaunch || isCreateThreads || configureModelSelection) && codex) {
      [decision, reason] = ["deny", "Codex hook events do not expose reliable standalone Manager/Worker role metadata; top-level thread creation and model changes are denied here."];
    } else if (isThreadLaunch) {
      const input = isDict(args) ? args : {};
      const selection = isDict(input.modelSelection) ? input.modelSelection : {};
      const model = selection.model;
      const validIds = [input.environmentId, input.projectId].every((value) => typeof value === "string" && value.trim());
      if (!validIds || !launchModelAllowed(workers, event, model)) [decision, reason] = ["deny", THREAD_LAUNCH];
    } else if (configureModelSelection) {
      const selection = isDict(args.modelSelection) ? args.modelSelection : {};
      if (!launchModelAllowed(workers, event, selection.model)) [decision, reason] = ["deny", THREAD_LAUNCH];
    } else if (isCreateThreads) {
      const threads = isDict(args) && Array.isArray(args.threads) ? args.threads : [];
      if (!threads.length || threads.some((thread) => {
        const target = isDict(thread) && isDict(thread.target) ? thread.target : {};
        return ![target.environmentId, target.projectId].every((value) => typeof value === "string" && value.trim()) ||
          !launchModelAllowed(workers, event, target.model);
      })) [decision, reason] = ["deny", THREAD_LAUNCH];
    } else if (workerContext && (isPrWatch || isLocalAutomation)) {
      [decision, reason] = ["deny", "Workers cannot create automation or initiate new watches. Use the current Manager thread for follow-up work."];
    } else if (codex && !event.agent_id && (isPrWatch || isLocalAutomation)) {
      [decision, reason] = ["deny", "Codex hook events do not expose reliable standalone Manager/Worker role metadata; ambiguous automation creation is denied here."];
    }
    if (!decision && mainLoop && !managerState.worker && !managerState.approved && typeof tool === "string" &&
        !COUNT_EXEMPT.test(tool) && !isLocalWakeup) {
      managerState.count++;
      writeManagerState(stateFile, managerState);
      if (managerState.count > 5) {
        decision = "deny";
        reason = managerGateReason(`The sixth counted work call (${tool})`, stateFile);
      }
    }
    const enforceManager = mainLoop && !managerState.worker && !managerState.approved;
    if (enforceManager && !decision && ["Edit", "Write", "NotebookEdit", "MultiEdit"].includes(tool)) {
      const filePath = dict(args).file_path ?? dict(args).notebook_path ?? "";
      const memory = path.join(os.homedir(), ".claude", "projects");
      const resolved = path.resolve(String(filePath));
      const memoryRoot = path.resolve(memory);
      const relative = path.relative(memoryRoot, resolved).split(path.sep);
      const isMemory = !path.isAbsolute(path.relative(memoryRoot, resolved)) && relative.length >= 3 &&
        relative[0] !== ".." && relative[1] === "memory";
      if (!isMemory) {
        decision = "deny";
        reason = managerGateReason(`${tool} to ${filePath || "a file"}`, stateFile);
      }
    }
    if (enforceManager && !decision && tool === "Bash" && mutatingBash(dict(args).command ?? "")) {
      decision = "deny";
      reason = managerGateReason("A Bash command that changes files or state", stateFile);
    }
    if (!decision && typeof tool === "string" && tool.endsWith("t3_thread_send")) {
      const stamped = stampFooter(args, workers ? path.dirname(workers) : null);
      // Codex only honors updatedInput together with permissionDecision:allow.
      if (stamped) {
        emit({ hookSpecificOutput: { hookEventName: "PreToolUse", ...(codex ? { permissionDecision: "allow" } : {}), updatedInput: stamped } });
      }
      return;
    }
    if (!decision && (tool === "mcp__t3-code__delegate_task" || tool === "mcp__t3_code__delegate_task")) {
      const target = "target" in dict(args) ? args.target : {};
      const model = dict(target).model;
      if (!model) [decision, reason] = ["deny", T3_MODEL];
      else {
        const tier = modelTier(workers, event, model);
        [decision, reason] = gate(tier && dispatchApproval(workers, event, tier), dict(args).task);
        if (!decision && mainLoop) {
          const task = typeof dict(args).task === "string" ? dict(args).task : "";
          if (!/^Role: Worker$/m.test(task)) emit({ hookSpecificOutput: { hookEventName: "PreToolUse", ...(codex ? { permissionDecision: "allow" } : {}), updatedInput: { ...dict(args), task: `Role: Worker\n${task}` } } });
          return;
        }
      }
    } else if (tool === "spawn_agent") {
      const subagentType = dict(args).agent_type;
      const approval = dispatchApproval(workers, event, subagentType) ?? (args.model === "opus" ? APPROVAL : null);
      [decision, reason] = gate(approval, args.message);
    } else if (tool === "Agent" || tool === "Task") {
      const subagentType = dict(args).subagent_type;
      const approval = dispatchApproval(workers, event, subagentType);
      if (args.model && !INHERITING_AGENT_TYPES.has(subagentType) && subagentType !== "fork") {
        [decision, reason] = ["deny", MODEL_OVERRIDE];
      } else if (approval || args.model === "opus") [decision, reason] = gate(approval ?? APPROVAL, args.prompt);
      else if (INHERITING_AGENT_TYPES.has(subagentType) && !args.model) [decision, reason] = ["deny", INHERITED_MODEL];
    } else if (!decision && tool === "Bash") {
      const command = dict(args).command ?? "";
      if (typeof command !== "string") return;
      // Claude Code supplies agent_id for subagents. A top-level --agent also sets agent_type.
      const manager = !codex && !event.agent_id;
      reason = textShellPolicy(command, manager);
      try {
        reason = protectedBranchGit(command, event) ?? pollsGithub(command) ?? reason;
      } catch {
        // A tokenization error leaves the text-based decision in place.
      }
      if (reason) decision = "deny";
    }
  } catch {
    return;
  }
  if (decision) {
    // Codex fails open on "ask", so it gets a deny that tells the model to obtain approval first.
    if (codex && decision === "ask") [decision, reason] = ["deny", `${reason} Get the user's approval, then retry.`];
    emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } });
  }
}

main();
