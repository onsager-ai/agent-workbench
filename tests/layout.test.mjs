import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_SKILLS = [
  "disk-cleanup",
  "manage-lane",
  "orchestrate-harnesses",
  "prompt-for-decisions",
  "review-storybook",
  "thermal-guard",
  "workbench-setup",
];

// Every entry under ROOT outside .git, without following symlinked directories.
function walk(directory = ROOT, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" && directory === ROOT) continue;
    const file = path.join(directory, entry.name);
    found.push({ file, entry });
    if (entry.isDirectory()) walk(file, found);
  }
  return found;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("public layout", () => {
  test("top level contains only the public package paths", () => {
    const expected = [".github", ".gitignore", "LICENSE", "README.md", "bin", "docs", "package.json", "skills", "tests"];
    const actual = fs.readdirSync(ROOT).filter((name) => name !== ".git").sort();
    assert.deepEqual(actual, expected.sort());
  });

  test("exact skill directories have matching frontmatter", () => {
    const skillsRoot = path.join(ROOT, "skills");
    assert.deepEqual(fs.readdirSync(skillsRoot).sort(), [...EXPECTED_SKILLS].sort());
    const skillFiles = walk(skillsRoot).filter(({ entry }) => entry.name === "SKILL.md")
      .map(({ file }) => path.relative(skillsRoot, file)).sort();
    assert.deepEqual(skillFiles, EXPECTED_SKILLS.map((name) => path.join(name, "SKILL.md")).sort());

    for (const name of EXPECTED_SKILLS) {
      const skillPath = path.join(skillsRoot, name, "SKILL.md");
      assert.ok(fs.statSync(skillPath).isFile());
      const content = fs.readFileSync(skillPath, "utf8");
      const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---(?:\n|$)/);
      assert.ok(frontmatter, name);
      assert.match(frontmatter[1], new RegExp(`^name:\\s*${escapeRegExp(name)}\\s*$`, "m"));
      assert.match(frontmatter[1], /^description:\s*\S/m);
    }
  });

  test("bundled resources are present", () => {
    const required = [
      "docs/notes.md",
      "skills/disk-cleanup/references/targets.md",
      "skills/manage-lane/references/handover.md",
      "skills/orchestrate-harnesses/workers.yml",
      "skills/orchestrate-harnesses/references/manager.md",
      "skills/orchestrate-harnesses/references/configuration.md",
      "skills/orchestrate-harnesses/references/worker-ladder.md",
      "skills/orchestrate-harnesses/references/codex-workers.md",
      "skills/orchestrate-harnesses/references/worker.md",
      "skills/orchestrate-harnesses/references/t3-sync.md",
      "skills/orchestrate-harnesses/references/magpie.md",
      "skills/orchestrate-harnesses/scripts/policy-hook",
      "skills/orchestrate-harnesses/scripts/policy-hook.mjs",
      "skills/thermal-guard/scripts/thermal",
      "skills/workbench-setup/assets/AGENTS.md",
      "skills/workbench-setup/scripts/workbench.mjs",
      "skills/workbench-setup/scripts/workbench.py",
      "skills/workbench-setup/vendor/yaml/index.js",
      "skills/workbench-setup/vendor/yaml/LICENSE",
      "skills/workbench-setup/vendor/smol-toml/index.js",
      "skills/workbench-setup/vendor/smol-toml/LICENSE",
      "skills/workbench-setup/vendor/README.md",
    ];
    for (const relativePath of required) {
      assert.ok(fs.statSync(path.join(ROOT, relativePath), { throwIfNoEntry: false })?.isFile(), relativePath);
    }
  });

  test("executable entry points keep their mode", () => {
    for (const relativePath of ["skills/orchestrate-harnesses/scripts/policy-hook", "skills/thermal-guard/scripts/thermal"]) {
      fs.accessSync(path.join(ROOT, relativePath), fs.constants.X_OK);
    }
  });

  test("shared template keeps workflow without personal preferences", () => {
    const template = fs.readFileSync(path.join(ROOT, "skills/workbench-setup/assets/AGENTS.md"), "utf8");
    for (const removed of ["## Writing for the user", "- When you need the user's answer", "- For a device or browser login"]) {
      assert.ok(!template.includes(removed), removed);
    }
    for (const retained of ["preserve unrelated work", "Thermal:", "Worker or reviewer", "native permission settings remain authoritative", "when its tools are available"]) {
      assert.ok(template.includes(retained), retained);
    }
  });

  test("symlinks resolve within the repository", () => {
    for (const { file, entry } of walk()) {
      if (entry.isSymbolicLink()) {
        const resolved = fs.realpathSync(file);
        assert.ok(resolved === ROOT || resolved.startsWith(ROOT + path.sep), `symlink escapes repository: ${path.relative(ROOT, file)}`);
      }
    }
  });

  test("public files have no absolute user home paths or obvious secrets", () => {
    const userHomePath = /(?:^|[\s"'(])(?:\/(?:home|Users)\/[^/\s"'()]+|[A-Z]:\\Users\\[^\\\s"'()]+)(?:[/\\]|(?=$|[\s"'()]))/i;
    const credentialPatterns = [
      /(?:ghp_|gho_|ghu_|ghs_|github_pat_)[A-Za-z0-9_]{24,}/i,
      /AKIA[A-Z0-9]{16}/,
      /sk-[A-Za-z0-9]{24,}/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*['"][^'"]{12,}['"]/i,
    ];
    const sensitiveNames = new Set([".env", ".env.local", "credentials.json", "secrets.json", "auth.json"]);
    for (const { file, entry } of walk()) {
      const relative = path.relative(ROOT, file);
      assert.ok(!sensitiveNames.has(entry.name.toLowerCase()), `private configuration file in ${relative}`);
      if (!fs.statSync(file).isFile()) continue;
      const content = fs.readFileSync(file).toString("utf8");
      assert.equal(userHomePath.test(content), false, `absolute user-home path in ${relative}`);
      for (const pattern of credentialPatterns) assert.equal(pattern.test(content), false, `credential-like value in ${relative}`);
    }
  });

  test("license and install instructions are present", () => {
    const license = fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8");
    assert.ok(license.includes("MIT License"));
    assert.ok(license.includes("Copyright (c) 2026 agent-workbench contributors"));
    const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
    assert.ok(readme.includes("npx skills add onsager-ai/agent-workbench -g -a codex -a claude-code --skill '*' -y"));
    const reference = fs.readFileSync(path.join(ROOT, "docs/reference.md"), "utf8");
    assert.ok(reference.includes("npx skills update -g -y"));
    assert.ok(reference.includes("remain separate and private"));
  });
});
