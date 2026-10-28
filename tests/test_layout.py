from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXPECTED_SKILLS = {
    "disk-cleanup",
    "hapi-runner-setup",
    "manage-lane",
    "orchestrate-harnesses",
    "prompt-for-decisions",
    "review-storybook",
    "workbench-setup",
}


class PublicLayoutTests(unittest.TestCase):
    def test_top_level_contains_only_the_public_package_paths(self) -> None:
        expected = {
            ".github",
            ".gitignore",
            "LICENSE",
            "README.md",
            "skills",
            "tests",
        }
        actual = {path.name for path in ROOT.iterdir() if path.name != ".git"}
        self.assertEqual(actual, expected)

    def test_exact_skill_directories_have_matching_frontmatter(self) -> None:
        skills_root = ROOT / "skills"
        actual = {path.name for path in skills_root.iterdir()}
        self.assertEqual(actual, EXPECTED_SKILLS)
        skill_files = {
            path.relative_to(skills_root)
            for path in skills_root.rglob("SKILL.md")
        }
        self.assertEqual(
            skill_files,
            {Path(name) / "SKILL.md" for name in EXPECTED_SKILLS},
        )

        for name in sorted(EXPECTED_SKILLS):
            with self.subTest(skill=name):
                skill_path = skills_root / name / "SKILL.md"
                self.assertTrue(skill_path.is_file())
                content = skill_path.read_text(encoding="utf-8")
                frontmatter = re.match(
                    r"\A---\s*\n(.*?)\n---(?:\n|\Z)", content, re.DOTALL
                )
                self.assertIsNotNone(frontmatter)
                assert frontmatter is not None
                self.assertRegex(frontmatter.group(1), rf"(?m)^name:\s*{re.escape(name)}\s*$")
                self.assertRegex(frontmatter.group(1), r"(?m)^description:\s*\S")

    def test_bundled_resources_are_present(self) -> None:
        required = (
            "skills/disk-cleanup/references/targets.md",
            "skills/manage-lane/references/handover.md",
            "skills/orchestrate-harnesses/models.json",
            "skills/orchestrate-harnesses/references/manager.md",
            "skills/orchestrate-harnesses/references/worker.md",
            "skills/orchestrate-harnesses/references/hapi-sync.md",
            "skills/workbench-setup/assets/AGENTS.md",
            "skills/workbench-setup/scripts/workbench.py",
        )
        for relative_path in required:
            with self.subTest(path=relative_path):
                self.assertTrue((ROOT / relative_path).is_file())

    def test_symlinks_resolve_within_the_repository(self) -> None:
        for path in ROOT.rglob("*"):
            if ".git" in path.parts or "__pycache__" in path.parts:
                continue
            if path.is_symlink():
                self.assertTrue(
                    path.resolve().is_relative_to(ROOT),
                    f"symlink escapes repository: {path.relative_to(ROOT)}",
                )

    def test_public_files_have_no_absolute_user_home_paths_or_obvious_secrets(self) -> None:
        user_home_path = re.compile(
            r"""(?i)(?:^|[\s"'(])(?:/(?:home|Users)/[^/\s"'()]+|[A-Z]:\\Users\\[^\\\s"'()]+)(?:[/\\]|(?=$|[\s"'()]))"""
        )
        credential_patterns = (
            re.compile(r"(?i)(?:ghp_|gho_|ghu_|ghs_|github_pat_)[A-Za-z0-9_]{24,}"),
            re.compile(r"AKIA[A-Z0-9]{16}"),
            re.compile(r"sk-[A-Za-z0-9]{24,}"),
            re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
            re.compile(
                r"""(?i)\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*['"][^'"]{12,}['"]"""
            ),
        )
        sensitive_names = {
            ".env",
            ".env.local",
            "credentials.json",
            "secrets.json",
            "auth.json",
        }

        for path in ROOT.rglob("*"):
            if ".git" in path.parts or "__pycache__" in path.parts:
                continue
            self.assertNotIn(
                path.name.lower(),
                sensitive_names,
                f"private configuration file in {path.relative_to(ROOT)}",
            )
            if not path.is_file():
                continue
            content = path.read_text(encoding="utf-8", errors="replace")
            self.assertIsNone(
                user_home_path.search(content),
                f"absolute user-home path in {path.relative_to(ROOT)}",
            )
            for pattern in credential_patterns:
                self.assertIsNone(
                    pattern.search(content),
                    f"credential-like value in {path.relative_to(ROOT)}",
                )

    def test_license_and_install_instructions_are_present(self) -> None:
        license_text = (ROOT / "LICENSE").read_text(encoding="utf-8")
        self.assertIn("MIT License", license_text)
        self.assertIn(
            "Copyright (c) 2026 agent-workbench contributors", license_text
        )

        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn(
            "npx skills add onsager-ai/agent-workbench -g -a codex -a claude-code --skill '*' -y",
            readme,
        )
        self.assertIn("npx skills update -g -y", readme)
        self.assertIn("remain separate and private", readme)


if __name__ == "__main__":
    unittest.main()
