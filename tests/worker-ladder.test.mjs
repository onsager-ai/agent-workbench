// Distributed Worker configuration and schema validation contract.
import assert from "node:assert/strict";
import path from "node:path";
import { beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Conflict, resolveWorkerConfig, workerBundle } from "../skills/workbench-setup/scripts/workbench.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKERS = path.join(ROOT, "skills/orchestrate-harnesses/workers.yml");

describe("worker configuration", () => {
  let bundle;
  let config;

  beforeEach(() => {
    bundle = workerBundle(WORKERS);
    config = bundle.base;
  });

  test("distributed ladder and tiers", () => {
    assert.deepEqual(config.ladder.map((entry) => [entry.level, entry.tiers]),
      [["L1", ["haiku"]], ["L2", ["sonnet"]], ["L3", ["opus"]]]);
    assert.deepEqual(config.ladder[1].start_for, ["spike", "research", "architecture"]);
    assert.equal(config.ladder[2].approval, "required");
    const expected = {
      haiku: ["claude", "claude-haiku-5-5", "medium"],
      sonnet: ["claude", "claude-sonnet-5-5", "medium"],
      opus: ["claude", "claude-opus-5-5", "medium"],
    };
    assert.deepEqual(new Set(Object.keys(config.tiers)), new Set(Object.keys(expected)));
    for (const [name, values] of Object.entries(expected)) {
      const tier = config.tiers[name];
      assert.deepEqual(["harness", "model", "effort"].map((key) => tier[key]), values);
      assert.equal(tier.timeout_s, 7200);
      assert.equal(tier.budget_usd, null);
      assert.equal(tier.opt_in, false);
    }
    assert.equal(config.policy.context.gateway_window, null);
    const codex = bundle.profiles.codex;
    assert.deepEqual(new Set(Object.keys(codex.tiers)), new Set(["haiku", "sonnet", "opus", "luna", "sol", "terra"]));
    assert.deepEqual(codex.ladder.map((entry) => entry.tiers), [["luna", "haiku"], ["sol", "sonnet"], ["opus"]]);
    for (const [name, model] of [["luna", "gpt-6-luna"], ["sol", "gpt-6.2-sol"], ["terra", "gpt-6.1-terra"]]) {
      assert.equal(codex.tiers[name].harness, "codex");
      assert.equal(codex.tiers[name].model, model);
      assert.equal(codex.tiers[name].claude_route, null);
      assert.equal(codex.tiers[name].opt_in, name === "terra");
    }
  });

  test("schema rejects bad resolved values", () => {
    const mutations = [
      (c) => { c.tiers.luna.timeout_s = true; },
      (c) => { c.tiers.luna.budget_usd = 1; },
      (c) => { c.tiers.sonnet.budget_usd = Infinity; },
      (c) => { c.tiers.sonnet.claude_route = null; },
      (c) => { c.tiers.sol.weekly_brake_percent = 101; },
      (c) => { c.tiers.sol.opt_in = true; },
      (c) => { c.ladder[0].tiers.push("unknown"); },
      (c) => { c.ladder[1].tiers.push("luna"); },
      (c) => { c.ladder[1].level = "L1"; },
      (c) => { c.ladder[0].approval = "optional"; },
      (c) => { c.policy.context.max_tokens = 0; },
      (c) => { c.policy.max_auto_rework = -1; },
      (c) => { c.tiers.luna.cli = "codex"; },
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(bundle.profiles.codex);
      mutate(candidate);
      assert.throws(() => resolveWorkerConfig(candidate), Conflict, String(mutate));
    }
  });
});
