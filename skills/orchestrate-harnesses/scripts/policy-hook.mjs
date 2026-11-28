// Enforce Worker, GitHub polling, and user-question policies, and stamp WB_MSG footers.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CONFIG_MISSING, delegateTier, resolvePath, selectWorkerProfile, t3Thread, topLevelT3Thread, t3WorkerTier } from "./worker-context.mjs";

const APPROVAL = "L3 Opus Worker needs the user's approval for this task (orchestrate-harnesses Worker ladder).";
const PROTECTED_BRANCH_REASON = "The local main branch is protected. Use a task branch, origin/main, " +
  "or git switch -c <task> origin/main.";
const PROTECTED_BRANCHES = new Set(["main", "master"]);
const POLLING = "Blocking GitHub waits are disabled. Use watch_pull_request for waiting and single-call reads " +
  "for status or logs (see orchestrate-harnesses' GitHub API budget section).";
const SLEEP_LOOP = "Sleep loops are disabled. Use t3_background_wait or Monitor.";
const CI_DOWNLOAD = "Artifact downloads write files. Send this step to the branch Worker.";
const ONE_SHOT_CALL = /^[ \t]*agent-workbench[ \t]+ops[ \t]+run-once[ \t]+([a-z][a-z0-9-]{0,63})[ \t]*(?![\s\S])/;
const ONE_SHOT_LAUNCHERS = new Set(["agent-workbench", "awb", "workbench.mjs", "workbench.py", "awb.mjs"]);
const ONE_SHOT_MENTION = /\b(?:agent-workbench|awb|workbench\.(?:mjs|py))\b[\s\S]*\brun-once\b/;
const RULE = {
  protectedBranch: "protected-branch", polling: "github-polling", sleepLoop: "sleep-loop",
  ciDownload: "ci-download", delegationModel: "delegation-model", delegationTier: "delegation-tier",
  delegationIsolation: "delegation-isolation", dispatchApproval: "dispatch-approval", workerConfig: "worker-config",
  threadLaunch: "thread-launch", schedule: "schedule", browserManager: "browser-manager",
  managerWorkLimit: "manager-work-limit", managerEdit: "manager-edit", managerShellWrite: "manager-shell-write",
  codexShellApproval: "codex-shell-approval", modelOverride: "model-override", inheritedModel: "inherited-model",
  nativeSubagent: "native-subagent", managerTurnReset: "manager-turn-reset", managerTurnUpdate: "manager-turn-update",
  readOnlyWorker: "read-only-worker", prWatchTarget: "pr-watch-target", workerAutomation: "worker-automation",
  unknownAutomation: "unknown-automation", oneShotJob: "one-shot-job", policyError: "policy-error",
};
const T3_MODEL = "Set target.model (and effort in target.options) for the Worker tier you chose " +
  "before dispatching with delegate_task.";
const READ_ONLY_STAMP = "This Worker is read-only: no file edits, commits, pushes, PRs, or state changes.";
const THREAD_LAUNCH = "Managers may launch a top-level T3 thread only when the user requests one; " +
  "set nonblank environmentId and projectId and select an exact configured model. " +
  "For models listed in policy.manager_models, quote the user's approval in the launch text as `L3 approval: <link to the approval>`. " +
  "Model configuration calls require an explicit threadId and are limited to non-opt-in L1/L2, " +
  "except for policy.manager_model_pairs or targets in policy.manager_threads with a model in policy.manager_models. " +
  "Workers must not launch top-level threads or change thread models. Use a Worker or current-thread wakeup for follow-up work.";
const SCHEDULE_TASK = "This schedule_task call does not meet the registered schedule rules. " +
  "Use the personal automation registry before activating automation. A Claude Manager or an enrolled Antigravity or Codex Manager " +
  "can create or re-enable a schedule that matches an entry in policy.schedules for the current T3 thread. " +
  "Codex supports fixed_time and once only. Identified schedules can be paused.";
const BROWSER_TOOL = /^mcp__t3_code(?:_direct)?__(preview_.+|t3_preview_.+)$/;
const BROWSER_MANAGER = "Browser tools other than status require a Claude Manager main loop with valid turn state.";
const NATIVE_EDITS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const AGY_TARGET_FILE_EDITS = new Set(["write_to_file", "replace_file_content", "multi_replace_file_content"]);
const AGY_EDITS = new Set([
  ...AGY_TARGET_FILE_EDITS, "generate_image", "write_file", "edit_file", "create_file", "delete_file", "file_delete", "client_edit_file",
]);
const AGY_SUBAGENTS = new Set(["invoke_subagent", "define_subagent", "swarm", "run_workflow"]);
const MANAGER_APPROVAL = "Manager work approval: <link to a Chief PM or owner message>";
const OBSERVATION_COUNT_EXEMPT = /^mcp__t3[-_]code__(?:t3_thread_list|t3_thread_read|t3_thread_search|t3_environment_links)$/;
const COUNT_EXEMPT = /^(?:mcp__t3[-_]code__)?(?:t3_thread_send|t3_thread_configure|schedule_task|list_scheduled_tasks|delete_scheduled_task|watch_pull_request|t3_queue|send_to_user|t3_pending_request|t3_background_wait|orchestrator_capabilities|task_status|task_cancel|t3_thread_wait|SendMessage|TaskStop|Agent|Task|spawn_agent|delegate_task|AskUserQuestion|ToolSearch|pull_request_merge|pull_request_review|pull_request_respond|link_pull_requests?|unwatch_pull_request|pull_request_create)$/;
const MUTATING_GIT = new Set(["commit", "push", "tag", "merge", "rebase", "reset", "checkout", "switch", "stash", "add"]);
const APPROVAL_LINE = "Get it first (through the Chief PM when one is registered), then add a line " +
  "`L3 approval: <link to the approval>` to the brief and retry.";

const INHERITED_MODEL ="Built-in agents inherit the Manager's model. Use a tier agent " +
  "(subagent_type: <role>) or pass model explicitly.";
const INHERITING_AGENT_TYPES = new Set([undefined, null, "general-purpose", "Plan", "Explore", "claude"]);
const MODEL_OVERRIDE = "model overrides the model in this agent's definition, so a tier agent would run on " +
  "the wrong model. Drop model and let subagent_type select the tier.";
const stopReason = (codex) => `If this asks the user something, re-ask it with ${codex ? "request_user_input" : "AskUserQuestion"}, putting the recommended ` +
  "option first and offering your best guesses as options for open-ended answers. " +
  (codex ? "If a Chief PM is registered, route owner decisions there, and route other questions there if request_user_input is unavailable. "
    : "If it is an owner decision and a Chief PM is registered, send it to the Chief PM instead. ") +
  "If your last message does not ask the user a question, stop now without writing anything more. " +
  "Do not explain or acknowledge this check.";
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

function shlex(text, whitespaceSplit, redirects = false) {
  const punctuation = redirects ? PUNCTUATION + "<>" : PUNCTUATION;
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
  const shellExpansion = (open = read()) => {
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
    let operator = false;
    let leadingTilde = false;
    let escaped = false;
    let substitutionRedirect = false;
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
          leadingTilde = next === "~";
          state = "a";
        } else if (punctuation.includes(next)) {
          token = next;
          state = "c";
          operator = true;
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
        token += shellExpansion();
      } else if (state === "'" || state === '"') {
        quoted = true;
        if (!next) throw new Error("No closing quotation");
        if (redirects && state === '"' && next === "$" && chars[position] === "(" && chars[position + 1] !== "(") {
          const expansion = shellExpansion();
          substitutionRedirect ||= hasOutputRedirect(shlex(expansion.slice(2, -1), true, true), false);
          token += expansion;
        } else if (redirects && state === '"' && next === "`") {
          // Keep this form conservative if the substitution contains a redirect.
          let inner = "";
          for (let char = read(); char && char !== "`"; char = read()) inner += char;
          substitutionRedirect ||= inner.includes(">");
          token += "`" + inner + "`";
        } else if (next === state) state = "a";
        else if (next === "\\" && state === '"') {
          escapedState = state;
          state = next;
        } else token += next;
      } else if (state === "\\") {
        if (!next) throw new Error("No escaped character");
        if ((escapedState === "'" || escapedState === '"') && next !== state && next !== escapedState) token += state;
        escaped = true;
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
          if (punctuation.includes(next)) token += next;
          else {
            pushback.push(next);
            break;
          }
        } else if (next === "'" || next === '"') {
          state = next;
        } else if (next === "\\") {
          escapedState = "a";
          state = next;
        } else if (WORDCHARS.has(next) || (whitespaceSplit && !punctuation.includes(next))) {
          token += next;
        } else {
          pushback.push(next);
          state = " ";
          if (token || quoted) break;
        }
      }
    }
    if (eof && !token && !quoted) return tokens;
    tokens.push(redirects ? { token, operator, leadingTilde, escaped, substitutionRedirect } : token);
    if (eof) return tokens;
  }
}

const punctuationOnly = (token) => [...token].every((char) => PUNCTUATION.includes(char));
const SHELL_WORD_SEPARATOR = /[\s;|&()$`"']/.source;
const shellWords = (pattern) => new RegExp(`(?:^|${SHELL_WORD_SEPARATOR})${pattern}(?=$|${SHELL_WORD_SEPARATOR})`);
const LOOP_WORD = shellWords("(?:while|until)");
const SLEEP_WORD = shellWords("sleep");
const GH_WORD = shellWords("gh");
const GH_RUN_DOWNLOAD = shellWords("gh\\s+run\\s+download");
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
        args.some((word) => word === "-w" || word === "--watch" || word.startsWith("--watch="))) return POLLING;
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
    if (!tier || tier.provider) return null;
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

function endsWithUserQuestion(text) {
  const prose = text
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ `~]*$/gm, "[code]")
    .replace(/^\s*>[^\n]*/gm, "[quote]")
    .replace(/(`+)[^\n]+?\1|"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|(?<!\w)'[^\n]*?'(?!\w)/g, "[quoted text]");
  const tail = prose.replace(/[\s*_`~]+$/, "").split(/[.!?。！？]\s+|\r?\n/).at(-1).trim();
  const sentence = tail.replace(/^(?:(?:[-+*]|\d+\))\s+)?[*_~]*/, "");
  // A third party's request is reported speech, even with a trailing question mark.
  if (/^(?:[Tt]hey ask(?:ed)?|(?:[Tt]he [\w -]+|(?!I\b|We\b|You\b)\p{Lu}[\p{L}'’-]*(?: \p{Lu}[\p{L}'’-]*)*) (?:asks|asked)) you to\b/u.test(sentence)) return false;
  return /[?？]$/.test(sentence) || /^(?:should I|do you want|let me know whether)\b/i.test(sentence);
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

function checkDelegation(workers, event, input, { stampRole, requireTier = false }) {
  const target = dict(input.target);
  if (!target.model) return { decision: "deny", reason: T3_MODEL, rule: RULE.delegationModel };
  const { name, tier, denial } = delegateTier(workers, event, target, requireTier);
  if (denial) return { decision: "deny", reason: denial, rule: denial === CONFIG_MISSING ? RULE.workerConfig : RULE.delegationTier };
  const readOnly = tier?.access === "read-only";
  const isolation = tier?.isolation ?? (readOnly ? ["shared"] : ["shared", "worktree"]);
  const requestedIsolation = input.isolation ?? "shared";
  if ((tier?.provider || tier?.isolation || tier?.access) && !isolation.includes(requestedIsolation)) {
    return { decision: "deny", reason: `Worker ${name} does not allow ${requestedIsolation} isolation; use ${isolation.join(" or ")}.`, rule: RULE.delegationIsolation };
  }
  const [decision, reason, rule] = gate(name && dispatchApproval(workers, event, name), input.task);
  if (decision) return { decision, reason, rule };
  const extra = tier?.stamp ?? (readOnly ? READ_ONLY_STAMP : "");
  if (!stampRole && !extra) return {};
  const task = typeof input.task === "string" ? input.task : "";
  const role = /^Role: Worker$/m;
  let stamped = role.test(task) ? task : `Role: Worker\n${task}`;
  if (extra) {
    const header = `Role: Worker\n${extra}`;
    if (!stamped.includes(`${header}\n`) && !stamped.endsWith(header)) stamped = stamped.replace(role, () => header);
  }
  return stamped === task ? {} : { task: stamped };
}

function hasL3Approval(text) {
  return typeof text === "string" && /^L3 approval: \S/m.test(text);
}

function launchModelAllowed(file, event, model, { approved = false, threadId, provider } = {}) {
  if (typeof model !== "string" || !model.trim()) return false;
  try {
    const { config } = selectWorkerProfile(JSON.parse(fs.readFileSync(file, "utf8")), event);
    const matches = (tier) => tier && !tier.provider && ([tier.model, tier.claude_route].includes(model) ||
      (tier.harness === "codex" && model === `codex/${tier.model}`));
    const l1L2Allowed = config.ladder.some((level) => ["L1", "L2"].includes(level.level) && level.tiers.some((name) => {
      const tier = config.tiers[name];
      return tier && !tier.opt_in && matches(tier);
    }));
    if (l1L2Allowed) return true;
    if (threadId !== undefined && config.policy.manager_model_pairs?.some((pair) =>
      pair.thread === threadId && pair.model === model)) return true;
    const managerThreads = config.policy.manager_threads;
    const listedTarget = Array.isArray(managerThreads) && managerThreads.includes(threadId);
    const codexConfigure = listedTarget && provider === "codex";
    return (approved || listedTarget) && config.policy.manager_models?.some((id) =>
      id === model || (codexConfigure && id.replace(/^codex\//, "") === model.replace(/^codex\//, ""))) === true;
  } catch {
    return false;
  }
}

const SCHEDULE_CREATE_KEYS = new Set(["title", "prompt", "schedule", "bindToCurrentThread", "clientRequestId", "enabled", "freshSession"]);
const SCHEDULE_UPDATE_KEYS = new Set(["scheduledTaskId", "enabled", "freshSession", "environmentId"]);

function registeredScheduleAllowed(file, event, input, { thread, codex }) {
  if (!file || !thread) return false;
  const update = Object.hasOwn(input, "scheduledTaskId");
  if (update) {
    if (typeof input.scheduledTaskId !== "string" || !input.scheduledTaskId.trim() || input.enabled !== true ||
        !Object.keys(input).every((key) => SCHEDULE_UPDATE_KEYS.has(key)) ||
        (input.environmentId !== undefined && (typeof input.environmentId !== "string" || !input.environmentId.trim()))) return false;
  } else if (input.bindToCurrentThread !== true || typeof input.prompt !== "string" || !input.prompt.trim() ||
      (Object.hasOwn(input, "enabled") && input.enabled !== true) ||
      !Object.keys(input).every((key) => SCHEDULE_CREATE_KEYS.has(key)) ||
      !["interval", "fixed_time", "once"].includes(input.schedule?.type)) return false;

  const hasFreshSession = Object.hasOwn(input, "freshSession");
  if (hasFreshSession && typeof input.freshSession !== "boolean") return false;
  try {
    const { config } = selectWorkerProfile(JSON.parse(fs.readFileSync(file, "utf8")), event);
    return config.policy.schedules?.some((entry) => entry.thread === thread &&
      (!codex || ["fixed_time", "once"].includes(entry.schedule?.type)) &&
      (!hasFreshSession || input.freshSession === (entry.fresh_session ?? false)) &&
      (update ? entry.task_id === input.scheduledTaskId :
        entry.name === input.title && isDeepStrictEqual(entry.schedule, input.schedule))) ?? false;
  } catch {
    return false;
  }
}

function isAutomationShellCommand(command) {
  if (/(?:^|[;&|\n]+)\s*(?:sudo\s+)?(?:crontab\b(?!\s+-[lr]\b)|systemctl\s+(?:enable|start|restart|daemon-reload)\b|(?:\S*\/)?systemd-run\b|at\b(?!q\b|rm\b)|nohup\b|daemonize\b|setsid\b)/i.test(command)) return true;
  if (!command.includes("systemd-run")) return false;
  try {
    return shellCommands(command).some((words) => {
      const argv = commandWords(words[0] === "cd" && words[2] === "&&" ? words.slice(3) : words);
      return argv.length > 0 && path.basename(argv[0]) === "systemd-run";
    });
  } catch {
    return true;
  }
}

function mentionsOneShotCall(command) {
  if (!ONE_SHOT_MENTION.test(command)) return false;
  try {
    return shellCommands(command).some((words) => {
      const launcher = words.findIndex((word) => ONE_SHOT_LAUNCHERS.has(path.basename(word)));
      if (launcher !== -1 && words.indexOf("run-once", launcher + 1) !== -1) return true;
      const [program, ...args] = commandWords(words);
      return program && ["bash", "sh", "zsh", "dash", "eval"].includes(path.basename(program)) &&
        args.some((arg) => ONE_SHOT_MENTION.test(arg));
    });
  } catch {
    return true;
  }
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
  if (approval === CONFIG_MISSING) return ["ask", approval, RULE.workerConfig];
  if (hasL3Approval(String(brief ?? ""))) return [undefined, undefined];
  return ["deny", `${approval} ${APPROVAL_LINE}`, RULE.dispatchApproval];
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

function isProfileId(value) {
  return typeof value === "string" && /^\S+$/.test(value) && !["default", "incognito", "__proto__"].includes(value);
}

function browserToolName(tool) {
  return typeof tool === "string" ? BROWSER_TOOL.exec(tool.toLowerCase().replaceAll("-", "_"))?.[1] : undefined;
}

function browserGrants(prompt) {
  const ids = new Set();
  for (const line of prompt.split("\n")) {
    const match = /^Browser task: (\S+) (https:\/\/\S+)\s*$/.exec(line);
    if (match && isProfileId(match[1]) && browserUrl(match[2])) ids.add(match[1]);
  }
  return [...ids];
}

function browserUrl(value) {
  if (typeof value !== "string" || !/^https:\/\/[^/?#@\\\s]+(?=[/?#]|$)/i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password) return url;
  } catch {}
  return null;
}

function matchesBrowserUrl(value, prefixes) {
  const url = browserUrl(value);
  return url !== null && prefixes.some((prefix) => {
    const allowed = browserUrl(prefix);
    if (!allowed || url.origin !== allowed.origin) return false;
    const base = allowed.pathname;
    return url.pathname === base || url.pathname.startsWith(base.endsWith("/") ? base : `${base}/`);
  });
}

function browserProfiles(workers, event) {
  try {
    const bundle = JSON.parse(fs.readFileSync(workers, "utf8"));
    return selectWorkerProfile(bundle, event).config.policy.browser?.profiles ?? {};
  } catch {
    return {};
  }
}

function previewDecision(tool, input, state, stateFile, workers, event) {
  const open = tool === "preview_open";
  const { profileId = "default", url } = input;
  const personal = profileId === "default" || profileId === "incognito";
  const profile = state.botProfile ?? (open && !personal ? profileId : undefined);
  if (profile === undefined) return null;

  const profiles = browserProfiles(workers, event);
  const urls = isProfileId(profile) && Object.hasOwn(profiles, profile) ? profiles[profile]?.urls : null;
  if (!Array.isArray(urls)) return ["This bot browser profile is not configured.", "browser-profile"];
  if (!state.approved || !state.browser?.includes(profile)) {
    return ["This bot browser profile needs a Browser task grant in the current approved Manager turn.", "browser-grant"];
  }
  if (tool === "preview_evaluate") return ["Script evaluation is blocked in a bot browser session.", "browser-evaluate"];
  if (open && (input.reuseExistingTab !== false || Object.hasOwn(input, "tabId") || Object.hasOwn(input, "target"))) {
    return ["Bot session opens require reuseExistingTab: false with no tabId or target.", "browser-tab"];
  }
  if ((tool === "preview_navigate" || (open && url !== undefined)) && !matchesBrowserUrl(url, urls)) {
    return ["The URL is outside this bot browser profile’s allowed HTTPS prefixes.", "browser-url"];
  }
  if (open && !personal) {
    if (state.botProfile && state.botProfile !== profileId) return ["Use a fresh session to open a different bot browser profile.", "browser-profile-switch"];
    try {
      updateManagerState(stateFile, (current) => {
        if (current.turn !== state.turn || current.invalidBrowser || (current.botProfile && current.botProfile !== profile)) {
          throw new Error("browser session changed");
        }
        return current.botProfile === profile ? current : { ...current, botProfile: profile };
      });
    } catch {
      return ["Could not record the bot browser profile for this session.", "browser-state"];
    }
  }
  return null;
}

function auditBrowserCall(stateFile, event, input, profile, tool, decision, worker) {
  if (!stateFile || !isProfileId(profile)) return;
  try {
    const directory = path.dirname(path.dirname(stateFile));
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const entry = {
      ts: new Date().toISOString(), session_id: event.session_id, agent_id: event.agent_id ?? null,
      role: worker ? "worker" : "manager", cwd: event.cwd ?? process.cwd(), profile,
      tool, decision: decision ? "deny" : "allow",
    };
    for (const field of ["url", "tabId", "locator", "action", "key"]) {
      if (typeof input[field] === "string") entry[field] = input[field];
    }
    // A denied URL can contain credentials; don't write them to disk.
    if (entry.url) entry.url = entry.url.replace(/^(\s*[a-z][a-z0-9+.-]*:[/\\]*)([^/?#\\]*@)/i, "$1[redacted]@");
    // A single printable key can insert literal text, unlike a named key such as Enter.
    if (entry.action === "press" && entry.key && [...entry.key].length === 1) entry.key = "[redacted]";
    const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW;
    const fd = fs.openSync(path.join(directory, "browser-audit.jsonl"), flags, 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, JSON.stringify(entry) + "\n");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Audit is best-effort and cannot change the policy decision.
  }
}

function policyStateDirectory() {
  const root = process.env.AGENT_WORKBENCH_STATE_HOME || process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(root, "agent-workbench");
}

const isSessionId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
const isT3ThreadId = (value) => typeof value === "string" && value.length > 0 && value === value.trim();

function appendDenial(host, tool, rule, role, cwd) {
  try {
    const time = new Date().toISOString();
    const lane = process.env.T3CODE_THREAD_ID?.trim() || path.basename(cwd || process.cwd());
    const directory = path.join(policyStateDirectory(), "denials");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const entry = { time, host, tool: typeof tool === "string" ? tool : "unknown", rule, role, lane };
    fs.appendFileSync(path.join(directory, `${time.slice(0, 10)}.jsonl`), JSON.stringify(entry) + "\n", {
      mode: 0o600,
      flag: fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
    });
  } catch {
    // A logging failure must never affect a tool decision.
  }
}

function managerStatePath(event) {
  return isSessionId(event.session_id) ? path.join(policyStateDirectory(), "manager-turns", `${event.session_id}.json`) : null;
}

// Codex 0.172 includes these markers on UserPromptSubmit and PreToolUse for spawned agents.
const topLevelCodex = (event) => isSessionId(event.session_id) && event.agent_id == null && event.agent_type == null;

function codexManagerEnrolment() {
  try {
    return JSON.parse(fs.readFileSync(path.join(policyStateDirectory(), "codex-managers.json"), "utf8"));
  } catch {
    return undefined;
  }
}

function antigravityManager(thread, row) {
  if (!topLevelT3Thread(row)) return false;
  try {
    const { threads } = JSON.parse(fs.readFileSync(path.join(policyStateDirectory(), "antigravity-managers.json"), "utf8"));
    return Array.isArray(threads) && threads.every(isT3ThreadId) &&
      threads.includes(thread);
  } catch {
    return false;
  }
}

async function readOnlyWorker(workers, event, agy, agyManager, agyThread) {
  if (agy) {
    if (agyManager) return false;
    const tier = t3WorkerTier(workers, event, agyThread);
    return !tier || tier.access === "read-only";
  }
  if (event.agent_type != null || event.agent_id != null) {
    if (typeof event.agent_type !== "string") return false;
    try {
      const { config } = selectWorkerProfile(JSON.parse(fs.readFileSync(workers, "utf8")), event);
      const tier = config.tiers[event.agent_type];
      return !tier?.provider && tier?.access === "read-only";
    } catch {
      return false;
    }
  }
  const row = await t3Thread(process.env.T3CODE_THREAD_ID?.trim());
  return t3WorkerTier(workers, event, row)?.access === "read-only";
}

function resetManagerTurn(previous, prompt, turn, worker = previous.worker || /^Role: Worker\r?$/m.test(prompt)) {
  const approved = /^Manager work approval: \S/m.test(prompt);
  const browser = approved && !worker ? browserGrants(prompt) : [];
  return {
    worker, count: 0, approved, turn,
    ...(browser.length ? { browser } : {}),
    ...(isProfileId(previous.botProfile) ? { botProfile: previous.botProfile } : {}),
    ...(previous.invalidBrowser && !isProfileId(previous.botProfile) ? { invalidBrowser: true } : {}),
  };
}

function readManagerState(file) {
  const fresh = { worker: false, count: 0, approved: false };
  if (!file) return fresh;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isDict(value) || typeof value.worker !== "boolean" || !Number.isSafeInteger(value.count) ||
        value.count < 0 || typeof value.approved !== "boolean") throw new Error("invalid state");
    if ((value.browser !== undefined && (!Array.isArray(value.browser) || !value.browser.every(isProfileId))) ||
        (value.botProfile !== undefined && !isProfileId(value.botProfile)) ||
        (value.turn !== undefined && (typeof value.turn !== "string" || !value.turn))) {
      return { ...value, invalidBrowser: true };
    }
    return value;
  } catch (error) {
    return error.code === "ENOENT" ? fresh : { ...fresh, invalidBrowser: true };
  }
}

function writeManagerState(file, state) {
  if (!file) return;
  const temporary = uniqueName(file, "turn");
  try {
    fs.writeFileSync(temporary, JSON.stringify(state) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function updateManagerState(file, update) {
  if (!file) return update(readManagerState(file));
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return withLock(`${file}.lock`, () => {
    const current = readManagerState(file);
    const state = update(current);
    if (state !== current) writeManagerState(file, state);
    return state;
  });
}

function managerGateReason(what, file) {
  return `${what} is blocked. Send this step to an L1/L2 Worker (luna first, then sol). ` +
    `A turn whose first message has \`${MANAGER_APPROVAL}\` passes the gate. State file: ${file ?? "invalid session_id"}.`;
}

function isMemoryEdit(file, cwd) {
  if (typeof file !== "string" || !file.trim() || file.includes("\0")) return false;
  const resolved = path.resolve(cwd, file);
  const relative = path.relative(path.join(os.homedir(), ".claude", "projects"), resolved);
  const parts = relative.split(path.sep);
  return !path.isAbsolute(relative) && parts.length >= 3 && parts[0] !== ".." && parts[1] === "memory";
}

function isMemoryPatch(command, cwd) {
  if (typeof command !== "string") return false;
  const lines = command.trim().split(/\r?\n/);
  if (lines.shift() !== "*** Begin Patch" || lines.pop() !== "*** End Patch") return false;
  let operation;
  let canMove = false;
  for (const line of lines) {
    const header = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(line);
    if (header) {
      const [, kind, file] = header;
      if (!isMemoryEdit(file, cwd)) return false;
      operation = kind;
      canMove = kind === "Update";
      continue;
    }
    if (canMove && line.startsWith("*** Move to: ")) {
      if (!isMemoryEdit(line.slice("*** Move to: ".length), cwd)) return false;
    } else if (operation === "Add" ? !line.startsWith("+") : operation !== "Update" ||
        !/^(?:[ +\-]|@@(?: |$)|\*\*\* End of File$)/.test(line)) {
      return false;
    }
    canMove = false;
  }
  return operation !== undefined;
}

function hasOutputRedirect(tokens, allowMemoryRedirect) {
  return tokens.some(({ token, operator, substitutionRedirect }, index) => {
    if (substitutionRedirect) return true;
    if (!operator) return false;
    const redirect = /(?:&>>?|<>|>>?[&|]?)/.exec(token);
    if (!redirect) return false;
    const target = tokens[index + 1];
    if (redirect.index + redirect[0].length !== token.length || !target || target.operator) return true;
    const output = target.token;
    if (redirect[0] === ">&" && /^(?:[0-9]+-?|-)$/.test(output)) return false;
    if (output === "/dev/null") return false;
    if (!allowMemoryRedirect || !output || /[$`*?{}\[\]]/.test(output) || output.split("/").includes("..")) return true;
    // Absolute and ~/ targets cannot be redirected by a preceding cd.
    const file = target.leadingTilde && !target.escaped && output.startsWith("~/")
      ? path.join(os.homedir(), output.slice(2)) : output;
    return !path.isAbsolute(file) || !isMemoryEdit(file, process.cwd()) || !isMemoryEdit(resolvePath(file), process.cwd());
  });
}

function readOnlyGithubApi(args) {
  let method;
  let hasFields = false;
  for (let index = 0; index < args.length && args[index] !== "--"; index++) {
    const word = args[index];
    if (word === "-X" || word === "--method") method = args[++index] ?? "";
    else if (word.startsWith("--method=")) method = word.slice(9);
    else if (word.startsWith("-X") && word.length > 2) method = word.slice(2).replace(/^=/, "");
    else if (/^(?:--(?:raw-)?field|-[fF])$/.test(word)) { hasFields = true; index++; }
    else if (/^(?:--(?:raw-)?field=|-[fF])/.test(word)) hasFields = true;
    else if (word === "--input" || word.startsWith("--input=")) return false;
    else if (/^(?:--(?:header|cache|hostname|jq|template)|-[Hqt])$/.test(word)) index++;
    else if (/^-[i]+[XfF]/.test(word)) return false;
  }
  return method === undefined ? !hasFields : method === "GET";
}

function isOneShotGithubRead(command) {
  // Codex's shell exception accepts a single gh invocation with no shell expansions or operators.
  if (/[\n\r$`\\<>;&|()*?\[\]{}]/.test(command) || !/^\s*gh\s/.test(command)) return false;
  try {
    const [, group, operation, ...args] = shlex(command, true);
    if (group === "api") return readOnlyGithubApi([operation, ...args].filter((word) => word !== undefined));
    if (args.some((word) => /^(?:--(?:watch|web)(?:=|$)|-w)/.test(word))) return false;
    return (group === "pr" && ["view", "checks"].includes(operation)) ||
      (group === "run" && ["view", "list"].includes(operation));
  } catch {
    return false;
  }
}

// A single argv-style command. Quoted text may contain shell punctuation, but
// the shell must not be able to run another command or change its redirections.
const STANDALONE_SHELL_WORD = String.raw`(?:[^ \t\r\n'"\\$\x60<>;&|()*?\[\]{}#!]|\\[^\r\n]|'[^']*'|"(?:[^"\\$\x60]|\\[^\r\n])*")`;
const STANDALONE_SHELL = new RegExp(String.raw`^[ \t]*([a-z-]+)(?:[ \t]+${STANDALONE_SHELL_WORD}+)*[ \t]*(?![\s\S])`);
// Git and ripgrep can run helpers configured outside the command line.
const LOCAL_READS = new Set(["cat", "grep", "head", "ls", "pwd", "tail", "wc"]);

function mutatingBash(command, allowMemoryRedirect = false) {
  let commands;
  try {
    if (hasOutputRedirect(shlex(command, true, true), allowMemoryRedirect)) return true;
    commands = shellCommands(command);
  } catch {
    return true; // A parse failure cannot establish that the command is read-only.
  }
  for (const words of commands) {
    const [argv] = gitCommand(words);
    if (argv && MUTATING_GIT.has(argv[0])) return true;
    const [program, operation, ...args] = commandWords(words[0] === "cd" && words[2] === "&&" ? words.slice(3) : words);
    if (["tee", "rm", "mv", "cp", "mkdir", "touch", "chmod"].includes(program) ||
        (program && path.basename(program) === "ostrom-goal") ||
        (program === "sed" && words.some((word) => word === "-i" || word.startsWith("-i"))) ||
        (["npm", "pnpm", "yarn"].includes(program) && ["install", "publish"].includes(operation)) ||
        (program === "pip" && operation === "install") ||
        (program === "gh" && ((operation === "api" && !readOnlyGithubApi(args)) ||
          (operation === "run" && args[0] === "download"))) ||
        (program === "ssh" && words.length > 2)) return true;
  }
  return false;
}

function classifyBash(command, event, manager) {
  try {
    const branch = protectedBranchGit(command, event);
    if (branch) return [branch, RULE.protectedBranch];
    const polling = pollsGithub(command);
    if (polling) return [polling, RULE.polling];
  } catch {
    // A tokenization error leaves the text-based decision in place.
  }
  // Scan the full text for waits and artifact downloads, including shell substitutions.
  if (LOOP_WORD.test(command) && SLEEP_WORD.test(command)) return [`${SLEEP_LOOP} Use watch_pull_request for GitHub waits.`, RULE.sleepLoop];
  if (manager && GH_RUN_DOWNLOAD.test(command.replace(/["']/g, ""))) return [CI_DOWNLOAD, RULE.ciDownload];
  return [];
}

function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

async function shouldBlockQuestion(text, classifier) {
  if (!text) return false;
  if (!classifier) return endsWithUserQuestion(text);
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
          criteria: {
            yes: "The agent directly asks the user to choose, confirm or answer, and waits for that reply. An unpunctuated request like 'Let me know whether' can qualify.",
            no: "The agent reports results or explains. Third-party requests (such as 'It asks you to decide'), quotes, code, and lists describing decisions or follow-ups are not direct asks from the agent to the user.",
          },
        } },
      }),
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return endsWithUserQuestion(text);
    const body = await response.json();
    const answer = body?.answers?.asks;
    const probabilities = answer?.probabilities;
    if (!isDict(answer) || !["yes", "no"].includes(answer.choice) || !Number.isFinite(answer.confidence) ||
        !isDict(probabilities) || !Number.isFinite(probabilities.yes) || !Number.isFinite(probabilities.no) ||
        probabilities.yes < 0 || probabilities.yes > 1 || probabilities.no < 0 || probabilities.no > 1) {
      return endsWithUserQuestion(text);
    }
    if (probabilities.yes >= 0.7) return true;
    if (probabilities.no >= 0.7) return false;
  } catch {}
  return endsWithUserQuestion(text);
}

async function main() {
  const workers = workersArgument(process.argv.slice(2));
  const host = hostArgument(process.argv.slice(2));
  const codex = host === "codex";
  const agy = host === "antigravity";
  let logTool;
  let logCwd;
  let role = "unknown";
  let enrolmentHint;
  const emitPreToolUse = (decision, reason, rule) => {
    // Antigravity and Codex cannot present approval prompts for this hook.
    if ((agy || codex) && decision === "ask") {
      decision = "deny";
      if (codex) reason += " Get the user's approval, then retry.";
    }
    if (decision === "deny") {
      appendDenial(agy || codex ? host : "claude", logTool, rule, role, logCwd);
      if (enrolmentHint) reason += ` ${enrolmentHint}`;
    }
    emit(agy ? { decision, ...(reason ? { reason } : {}) } : {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason },
    });
  };
  const emitUpdate = (input, overwrite) => emit(agy ? { decision: "allow", overwrite } : {
    hookSpecificOutput: { hookEventName: "PreToolUse", ...(codex ? { permissionDecision: "allow" } : {}), updatedInput: input },
  });
  let decision = null;
  let reason = null;
  let rule;
  let agyRoleResolved = false;
  try {
    let event = JSON.parse(fs.readFileSync(0, "utf8"));
    if (!isDict(event)) return;
    logCwd = typeof event.cwd === "string" ? event.cwd : undefined;
    let agyManager = false;
    let agyThread;
    let agyTurn;
    let agyStateFile;
    if (agy) {
      const toolCall = isDict(event.toolCall) ? event.toolCall : {};
      const { toolSummary: ignored, ...args } = isDict(toolCall.args) ? toolCall.args : {};
      const tool = typeof toolCall.name === "string" ? toolCall.name.replace(/^mcp_t3-code_/, "mcp__t3_code__") : undefined;
      logTool = toolCall.name;
      if (tool === "run_command" && typeof args.Cwd === "string") logCwd = args.Cwd;
      if (tool === "mcp__t3_code__delegate_task" && !isDict(args.target)) args.target = {};
      const thread = process.env.T3CODE_THREAD_ID?.trim();
      agyThread = await t3Thread(thread);
      agyManager = antigravityManager(thread, agyThread);
      agyRoleResolved = true;
      if (!agyManager && topLevelT3Thread(agyThread)) {
        enrolmentHint = "This top-level Antigravity thread is not enrolled as a Manager, so Worker rules apply. " +
          `To use Manager rules, ask the harness owner to enrol thread ${thread}.`;
      }
      role = agyManager ? "manager" : agyThread?.relationship ? "worker" : "unknown";
      if (AGY_SUBAGENTS.has(tool)) {
        emitPreToolUse("deny", "Antigravity's own subagent tools skip the Worker ladder; dispatch Workers with T3 delegate_task.", RULE.nativeSubagent);
        return;
      }
      if (agyManager) {
        // Hash the prompt and thread separately; neither raw prompts nor paths from IDs go on disk.
        const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
        agyTurn = hash(typeof event.lastUserInput === "string" ? event.lastUserInput : "");
        agyStateFile = managerStatePath({ session_id: `antigravity-${hash(thread)}` });
      }
      event = {
        hook_event_name: "PreToolUse", tool_name: tool, tool_input: args,
        session_id: thread, cwd: event.cwd, lastUserInput: event.lastUserInput,
      };
    }
    const stateFile = agy ? agyStateFile : managerStatePath(event);
    const codexTopLevel = codex && topLevelCodex(event);
    const enrolment = codexTopLevel ? codexManagerEnrolment() : undefined;
    const sessions = enrolment?.sessions;
    const threads = enrolment?.threads;
    const sessionEnrolled = Array.isArray(sessions) && sessions.every(isSessionId) && sessions.includes(event.session_id);
    const codexThread = codexTopLevel && !sessionEnrolled ? await t3Thread(event.session_id, { byCodexSession: true }) : undefined;
    const threadEnrolled = topLevelT3Thread(codexThread) && Array.isArray(threads) && threads.every(isT3ThreadId) &&
      threads.includes(codexThread.threadId);
    const codexManager = sessionEnrolled || threadEnrolled;
    if (codexTopLevel && !codexManager && (!codexThread || topLevelT3Thread(codexThread))) {
      enrolmentHint = "This top-level Codex session is not enrolled as a Manager. " +
        "To use Manager rules, ask the harness owner to " + (codexThread
          ? `enrol T3 thread ${codexThread.threadId} under threads in codex-managers.json.`
          : `enrol session ${event.session_id}.`);
    }
    if (event.hook_event_name === "UserPromptSubmit") {
      if (codexManager || (host === "claude" && event.agent_id == null)) {
        try {
          updateManagerState(stateFile, (previous) => resetManagerTurn(previous,
            typeof event.prompt === "string" ? event.prompt : "", codexManager ? event.turn_id : crypto.randomUUID()));
        } catch {
          // Block the new prompt if old turn grants may still be on disk.
          emit({ decision: "block", reason: "Could not reset the Manager turn state." });
        }
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
        if (await shouldBlockQuestion(text, classifier)) emit({ decision: "block", reason: stopReason(codex) });
      } catch {
        return;
      }
      return;
    }
    if (event.hook_event_name != null && event.hook_event_name !== "PreToolUse") return;
    const tool = event.tool_name;
    if (!agy) logTool = tool;
    const args = "tool_input" in event ? event.tool_input : {};
    const mainLoop = agy ? agyManager : codex ? codexManager : !event.agent_id;
    // An unenrolled session must not keep using state from its time as a Manager.
    let managerState = readManagerState(codex && !codexManager ? null : stateFile);
    if (agyManager && managerState.turn !== agyTurn) {
      const prompt = typeof event.lastUserInput === "string" ? event.lastUserInput : "";
      try {
        managerState = updateManagerState(stateFile, (current) => current.turn === agyTurn
          ? current : resetManagerTurn(current, prompt, agyTurn, false));
      } catch {
        emitPreToolUse("deny", "Could not reset the Manager turn state.", RULE.managerTurnReset);
        return;
      }
    }
    const workerContext = (agy && !agyManager) || managerState.worker || Boolean(event.agent_id) || (codex && event.agent_type != null);
    if (!agy) role = workerContext ? "worker" : mainLoop ? "manager" : "unknown";
    // Never carry an approval or browser grant over to a different native Codex turn.
    const codexTurnMatches = () => !codexManager || Boolean(managerState.turn && managerState.turn === event.turn_id);
    const workApproved = () => managerState.approved && codexTurnMatches();
    const isShell = agy ? tool === "run_command" : tool === "Bash" || (codexManager && tool === "exec_command");
    const shellTool = isShell || (codex && tool === "exec_command");
    const shellInput = isDict(args) ? args : {};
    const command = agy ? shellInput.CommandLine
      : codex && tool === "exec_command" ? shellInput.command ?? shellInput.cmd : shellInput.command;
    const shellCommand = typeof command === "string" ? command : "";
    const oneShot = shellTool && ONE_SHOT_CALL.exec(shellCommand);
    if (oneShot || (shellTool && mentionsOneShotCall(shellCommand))) {
      try {
        if (oneShot && event.agent_id == null && event.agent_type == null &&
            shellInput.run_in_background !== true && shellInput.Blocking !== false) {
          const { authorizedOneShot } = await import("../../workbench-setup/scripts/run-once.mjs");
          if (await authorizedOneShot(workers, oneShot[1], { cwd: shellInput.workdir ?? shellInput.Cwd ?? event.cwd })) {
            if (agy) emitPreToolUse("allow");
            return;
          }
        }
      } catch {
        // An unavailable runner or missing caller evidence cannot authorize execution.
      }
      emitPreToolUse("deny", "Use a standalone `agent-workbench ops run-once <job-id>` call in the foreground " +
        "from an eligible T3 Worker for an unexpired job registered to this host and parent thread.", RULE.oneShotJob);
      return;
    }
    const standaloneProgram = isShell ? STANDALONE_SHELL.exec(shellCommand)?.[1] : undefined;
    const managerGoalCommand = mainLoop && !workerContext && standaloneProgram === "ostrom-goal";
    if (codexManager && isShell && !managerState.worker && !workApproved() && !managerGoalCommand &&
        !isOneShotGithubRead(shellCommand) && !LOCAL_READS.has(standaloneProgram)) {
      const [shellReason, shellRule] = classifyBash(shellCommand, event, false);
      if (shellReason) emitPreToolUse("deny", shellReason, shellRule);
      else emitPreToolUse("deny", "Enrolled Codex Managers need `Manager work approval: <link>` at the start " +
        "of the turn for shell commands outside the allowed reads; send other shell work to a Worker.", RULE.codexShellApproval);
      return;
    }
    const isEdit = (agy ? AGY_EDITS : NATIVE_EDITS).has(tool);
    const agyManagementTool = agy && (tool === "manage_task" || tool === "manage_subagents");
    const agyActions = agyManagementTool ? [args.Action, args.action].filter((action) => action !== undefined) : [];
    const [agyAction] = agyActions;
    const agyManagementRead = agyActions.length === 1 &&
      (agyAction === "list" || (tool === "manage_task" && agyAction === "status"));
    const agyManagementWrite = agyManagementTool && !agyManagementRead;
    const agyStateWrite = agyManagementWrite || (agy && tool === "schedule");
    const isPatch = codex && tool === "apply_patch";
    const shellWrite = (isShell || (codex && tool === "exec_command")) && mutatingBash(shellCommand);
    if ((isEdit || agyStateWrite || isPatch || shellWrite) &&
        await readOnlyWorker(workers, event, agy, agyManager, agyThread)) {
      emitPreToolUse("deny", "Read-only Workers cannot edit files or run shell commands that change files or state.", RULE.readOnlyWorker);
      return;
    }
    const normalizedTool = typeof tool === "string" ? tool.replaceAll("-", "_") : tool;
    const canonicalTool = codex && typeof normalizedTool === "string"
      ? normalizedTool.replace(/^mcp__t3_code_direct__/, "mcp__t3_code__") : normalizedTool;
    const isDelegateTask = normalizedTool === "mcp__t3_code__delegate_task" ||
      (codexManager && canonicalTool === "mcp__t3_code__delegate_task");
    const previewTool = browserToolName(tool);
    const browserWorker = () => (agy ? !agyManager : !codexManager && (host !== "claude" || event.agent_id != null)) ||
      managerState.worker || !managerState.turn || managerState.invalidBrowser || !codexTurnMatches();
    if (previewTool === "preview_status") {
      auditBrowserCall(stateFile, event, isDict(args) ? args : {}, managerState.botProfile, "status", null, browserWorker());
      if (agy) emitPreToolUse("allow");
      return;
    }
    const isScheduleTask = /^mcp__t3_code(?:_direct)?__schedule_task$/.test(canonicalTool);
    const isThreadLaunch = canonicalTool === "mcp__t3_code__t3_thread_launch";
    const isThreadConfigure = canonicalTool === "mcp__t3_code__t3_thread_configure";
    const isCreateThreads = canonicalTool === "mcp__t3_code__create_threads";
    const isPrWatch = canonicalTool === "watch_pull_request" || canonicalTool === "mcp__t3_code__watch_pull_request";
    const isLocalWakeup = tool === "CronCreate" || (tool === "Skill" && isDict(args) && args.skill === "loop");
    const isLocalAutomation = isLocalWakeup ||
      (shellTool && !managerGoalCommand && isAutomationShellCommand(shellCommand));
    const localAutomationWorker = isLocalAutomation && !workerContext &&
      (agyThread ?? await t3Thread(process.env.T3CODE_THREAD_ID?.trim()))?.relationship === "subagent";
    const configureModelSelection = isThreadConfigure && isDict(args) && Object.hasOwn(args, "modelSelection");
    if (isScheduleTask) {
      const input = isDict(args) ? args : {};
      const safePauseKeys = new Set(["scheduledTaskId", "enabled", "environmentId"]);
      const pauseOnly = typeof input.scheduledTaskId === "string" && input.scheduledTaskId.trim() &&
        input.enabled === false && Object.keys(input).every((key) => safePauseKeys.has(key)) &&
        (input.environmentId === undefined || (typeof input.environmentId === "string" && input.environmentId.trim()));
      if (!pauseOnly) {
        const scheduleManager = agyManager || codexManager || (host === "claude" && event.agent_id == null);
        let allowed = false;
        if (scheduleManager && managerState.worker === false && managerState.turn &&
            !managerState.invalidBrowser && codexTurnMatches()) {
          let thread;
          if (codex) {
            // Session-enrolled Managers can resolve their role without a thread; schedules cannot.
            const row = codexThread ?? await t3Thread(event.session_id, { byCodexSession: true });
            if (topLevelT3Thread(row)) thread = row.threadId;
          } else {
            thread = process.env.T3CODE_THREAD_ID?.trim();
          }
          allowed = registeredScheduleAllowed(workers, event, input, { thread, codex });
        }
        if (!allowed) [decision, reason, rule] = ["deny", SCHEDULE_TASK, RULE.schedule];
      }
    } else if (isPrWatch && !hasPrWatchTarget(args)) {
      [decision, reason, rule] = ["deny", "Bind a PR watch to a repository and pull request, URL, or explicit threadId.", RULE.prWatchTarget];
    } else if ((isThreadLaunch || isCreateThreads || configureModelSelection || (agy && isThreadConfigure)) && workerContext) [decision, reason, rule] = ["deny", THREAD_LAUNCH, RULE.threadLaunch];
    else if ((isThreadLaunch || isCreateThreads || configureModelSelection) && codex && !codexManager) {
      [decision, reason, rule] = ["deny", "Codex hook events do not expose reliable standalone Manager/Worker role metadata; top-level thread creation and model changes are denied here.", RULE.threadLaunch];
    } else if (isThreadLaunch) {
      const input = isDict(args) ? args : {};
      const selection = isDict(input.modelSelection) ? input.modelSelection : {};
      const model = selection.model;
      const validIds = [input.environmentId, input.projectId].every((value) => typeof value === "string" && value.trim());
      const approved = hasL3Approval(input.message) || hasL3Approval(input.prompt);
      if (!validIds || !launchModelAllowed(workers, event, model, { approved })) [decision, reason, rule] = ["deny", THREAD_LAUNCH, RULE.threadLaunch];
    } else if (configureModelSelection) {
      const selection = isDict(args.modelSelection) ? args.modelSelection : {};
      const { threadId } = args;
      if (!isT3ThreadId(threadId) || !launchModelAllowed(workers, event, selection.model, { threadId, provider: selection.provider })) {
        [decision, reason, rule] = ["deny", THREAD_LAUNCH, RULE.threadLaunch];
      }
    } else if (isCreateThreads) {
      const threads = isDict(args) && Array.isArray(args.threads) ? args.threads : [];
      if (!threads.length || threads.some((thread) => {
        const target = isDict(thread) && isDict(thread.target) ? thread.target : {};
        return ![target.environmentId, target.projectId].every((value) => typeof value === "string" && value.trim()) ||
          !launchModelAllowed(workers, event, target.model, { approved: hasL3Approval(thread?.prompt) });
      })) [decision, reason, rule] = ["deny", THREAD_LAUNCH, RULE.threadLaunch];
    } else if ((workerContext && (isPrWatch || isLocalAutomation)) || localAutomationWorker) {
      [decision, reason, rule] = ["deny", "Workers cannot create automation or initiate new watches. Use the current Manager thread for follow-up work.", RULE.workerAutomation];
    } else if (codex && !codexManager && !event.agent_id && (isPrWatch || isLocalAutomation)) {
      [decision, reason, rule] = ["deny", "Codex hook events do not expose reliable standalone Manager/Worker role metadata; ambiguous automation creation is denied here.", RULE.unknownAutomation];
    }
    if (!decision && mainLoop && !managerState.worker && !workApproved() && typeof tool === "string" &&
        !isScheduleTask && !COUNT_EXEMPT.test(codex ? canonicalTool : tool) &&
        !OBSERVATION_COUNT_EXEMPT.test(tool) && !isLocalWakeup && (!agyManagementTool || agyManagementWrite)) {
      try {
        managerState = updateManagerState(stateFile, (current) => current.turn !== managerState.turn
          ? current : { ...current, count: current.count + 1 });
      } catch (error) {
        if (!previewTool && !agy) throw error;
        [decision, reason, rule] = ["deny", "Could not update the Manager turn state.", RULE.managerTurnUpdate];
      }
      if (!decision && managerState.count > 5) {
        decision = "deny";
        rule = RULE.managerWorkLimit;
        reason = managerGateReason(`The sixth counted work call (${tool})`, stateFile);
      }
    }
    if (previewTool) {
      const input = isDict(args) ? args : {};
      if (!decision) {
        [reason, rule] = browserWorker()
          ? [(agy ? BROWSER_MANAGER.replace("Claude Manager", "enrolled Antigravity Manager")
            : codexManager ? BROWSER_MANAGER.replace("Claude Manager", "enrolled Codex Manager") : BROWSER_MANAGER), RULE.browserManager]
          : previewDecision(previewTool, input, managerState, stateFile, workers, event) ?? [];
        if (reason) decision = "deny";
      }
      const profile = previewTool === "preview_open" && !decision && isProfileId(input.profileId)
        ? input.profileId : managerState.botProfile;
      auditBrowserCall(stateFile, event, input, profile, previewTool.replace(/^preview_/, ""), decision, browserWorker());
    }
    const enforceManager = mainLoop && !managerState.worker && !workApproved();
    if (enforceManager && !decision && codexManager && isPatch &&
        !isMemoryPatch(isDict(args) ? args.command : undefined, typeof event.cwd === "string" ? event.cwd : process.cwd())) {
      [decision, reason, rule] = ["deny", managerGateReason("apply_patch to a file", stateFile), RULE.managerEdit];
    }
    if (enforceManager && !decision && (isEdit || agyStateWrite)) {
      // Only the legacy Antigravity editors document TargetFile as the destination.
      const filePath = agy ? (AGY_TARGET_FILE_EDITS.has(tool) ? args.TargetFile : undefined)
        : dict(args).file_path ?? dict(args).notebook_path;
      if (!isMemoryEdit(filePath, agy ? event.cwd || process.cwd() : process.cwd())) {
        decision = "deny";
        rule = RULE.managerEdit;
        reason = managerGateReason(agyStateWrite ? tool : `${tool} to ${filePath || "a file"}`, stateFile);
      }
    }
    if (enforceManager && !decision && isShell && shellWrite && !managerGoalCommand &&
        (host !== "claude" || mutatingBash(shellCommand, true))) {
      decision = "deny";
      rule = RULE.managerShellWrite;
      reason = managerGateReason("A Bash command that changes files or state", stateFile);
    }
    if (!decision && typeof tool === "string" && tool.endsWith("t3_thread_send")) {
      const stamped = stampFooter(args, workers ? path.dirname(workers) : null);
      if (stamped) emitUpdate(stamped, { message: stamped.message });
      else if (agy) emitPreToolUse("allow");
      return;
    }
    if (!decision && isDelegateTask) {
      const input = dict(args);
      const result = checkDelegation(workers, event, input, { stampRole: agy || mainLoop, requireTier: agy });
      if (result.decision) ({ decision, reason, rule } = result);
      else if (result.task !== undefined) {
        emitUpdate({ ...input, task: result.task }, { task: result.task });
        return;
      }
    } else if (!decision && tool === "spawn_agent") {
      const subagentType = dict(args).agent_type;
      const approval = dispatchApproval(workers, event, subagentType) ?? (args.model === "opus" ? APPROVAL : null);
      [decision, reason, rule] = gate(approval, args.message);
    } else if (!decision && (tool === "Agent" || tool === "Task")) {
      const subagentType = dict(args).subagent_type;
      const approval = dispatchApproval(workers, event, subagentType);
      if (args.model && !INHERITING_AGENT_TYPES.has(subagentType) && subagentType !== "fork") {
        [decision, reason, rule] = ["deny", MODEL_OVERRIDE, RULE.modelOverride];
      } else if (approval || args.model === "opus") [decision, reason, rule] = gate(approval ?? APPROVAL, args.prompt);
      else if (INHERITING_AGENT_TYPES.has(subagentType) && !args.model) [decision, reason, rule] = ["deny", INHERITED_MODEL, RULE.inheritedModel];
    } else if (!decision && isShell && !managerGoalCommand) {
      [reason, rule] = classifyBash(shellCommand, agy ? { cwd: dict(args).Cwd ?? event.cwd } : event, mainLoop);
      if (reason) decision = "deny";
    }
  } catch {
    if (agyRoleResolved) emitPreToolUse("deny", "Could not evaluate the Antigravity tool policy.", RULE.policyError);
    return;
  }
  if (decision || agy) emitPreToolUse(decision ?? "allow", reason, rule);
}

main();
