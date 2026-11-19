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
const T3_MODEL = "Set target.model (and effort in target.options) for the Worker tier you chose " +
  "before dispatching with delegate_task.";
const INHERITED_MODEL = "Built-in agents inherit the Manager's model. Use a tier agent " +
  "(subagent_type: <role>) or pass model explicitly.";
const INHERITING_AGENT_TYPES = new Set([undefined, null, "general-purpose", "Plan", "Explore", "claude"]);
const STOP_REASON = "If this asks the user something, re-ask it with AskUserQuestion, putting the recommended " +
  "option first and offering your best guesses as options for open-ended answers. " +
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
  const footer = `-- WB_MSG from=${environment}/${thread} kind=${fields.kind ?? "decision"} ` +
    `id=${thread.slice(-8)}:${nextSequence(stateDir, thread)} re=${fields.re ?? "none"}`;
  return { ...args, message: message.slice(0, last.index) + footer + message.slice(last.index + last[0].length) };
}

// Port of Python shlex (posix mode, punctuation_chars=";|&()\n", whitespace " \t\r", commenters "#").
const PUNCTUATION = ";|&()\n";
const WHITESPACE = " \t\r";
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

function pollsGithub(command) {
  if (typeof command !== "string") throw new TypeError("command must be a string");
  const tokens = [];
  for (const token of shlex(command, false)) {
    if (token && punctuationOnly(token)) tokens.push(...token);
    else tokens.push(token);
  }
  const separators = new Set([";", "|", "&", "(", ")", "\n", "do", "then", "!", "while", "until"]);
  const commands = [];
  const loops = [];
  const stack = [];
  tokens.forEach((token, index) => {
    if (index === 0 || separators.has(tokens[index - 1])) {
      if (["while", "until", "for"].includes(token)) stack.push(index);
      else if (token === "done" && stack.length) loops.push([stack.pop(), index]);
      let end = index + 1;
      while (end < tokens.length && !separators.has(tokens[end])) end++;
      commands.push([index, tokens.slice(index, end)]);
    }
  });
  for (const [, words] of commands) {
    if (words[0] === "gh" && words[1] === "run" && words[2] === "watch") return true;
    if (words[0] === "gh" && words[1] === "pr" && words[2] === "checks" &&
        words.slice(3).some((word) => word === "--watch" || word.startsWith("--watch="))) return true;
  }
  return loops.some(([start, end]) =>
    tokens.slice(start, end).includes("do") &&
    commands.some(([index, words]) => start < index && index < end && words[0] === "sleep") &&
    commands.some(([index, words]) => start < index && index < end && words[0] === "gh"));
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

function endsWithQuestion(text) {
  const trimmed = text.replace(/[\s*_`~]+$/, "");
  return trimmed.endsWith("?") || trimmed.endsWith("？");
}

function isRelativeTo(child, parent) {
  const base = path.normalize(parent).replace(/(.)\/+$/, "$1");
  return child === base || child.startsWith(base === "/" ? "/" : base + "/");
}

function dispatchApproval(file, event, tier) {
  try {
    if (file === null) throw new Error("missing workers path");
    const bundle = JSON.parse(fs.readFileSync(file, "utf8"));
    const cwd = resolvePath(event.cwd || process.cwd());
    let profile = bundle.profile;
    for (const rule of bundle.select) {
      if (isRelativeTo(cwd, rule.path)) {
        profile = rule.profile;
        break;
      }
    }
    const config = profile ? bundle.profiles[profile] : bundle.base;
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
    return "Worker policy configuration is missing or unreadable; rerun agent-workbench install before dispatching Workers.";
  }
}

function workersArgument(argv) {
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--workers" && index + 1 < argv.length) return argv[index + 1];
    if (argv[index].startsWith("--workers=")) return argv[index].slice("--workers=".length);
  }
  return null;
}

function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

function main() {
  const workers = workersArgument(process.argv.slice(2));
  let decision = null;
  let reason = null;
  try {
    const event = JSON.parse(fs.readFileSync(0, "utf8"));
    if (!isDict(event)) return;
    if (event.hook_event_name === "Stop") {
      if (event.stop_hook_active) return;
      try {
        if (endsWithQuestion(lastAssistantText(event))) emit({ decision: "block", reason: STOP_REASON });
      } catch {
        return;
      }
      return;
    }
    if (event.hook_event_name != null && event.hook_event_name !== "PreToolUse") return;
    const tool = event.tool_name;
    const args = "tool_input" in event ? event.tool_input : {};
    if (typeof tool === "string" && tool.endsWith("t3_thread_send")) {
      const stamped = stampFooter(args, workers ? path.dirname(workers) : null);
      if (stamped) emit({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: stamped } });
      return;
    }
    if (tool === "mcp__t3-code__delegate_task") {
      const target = "target" in dict(args) ? args.target : {};
      if (!dict(target).model) [decision, reason] = ["deny", T3_MODEL];
    } else if (tool === "Agent" || tool === "Task") {
      const subagentType = dict(args).subagent_type;
      const approval = dispatchApproval(workers, event, subagentType);
      if (approval) [decision, reason] = ["ask", approval];
      else if (args.model === "opus") [decision, reason] = ["ask", APPROVAL];
      else if (INHERITING_AGENT_TYPES.has(subagentType) && !args.model) [decision, reason] = ["deny", INHERITED_MODEL];
    } else if (tool === "Bash") {
      const command = dict(args).command ?? "";
      const branchReason = protectedBranchGit(command, event);
      if (branchReason) [decision, reason] = ["deny", branchReason];
      else if (pollsGithub(command)) [decision, reason] = ["deny", POLLING];
    }
  } catch {
    return;
  }
  if (decision) {
    emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } });
  }
}

main();
