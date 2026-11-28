import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_MISSING = "Worker policy configuration is missing or unreadable; rerun agent-workbench install before dispatching Workers.";

export function resolvePath(target) {
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


function isRelativeTo(child, parent) {
  const base = path.normalize(parent).replace(/(.)\/+$/, "$1");
  return child === base || child.startsWith(base === "/" ? "/" : base + "/");
}

export function selectWorkerProfile(bundle, event) {
  const cwd = resolvePath(event.cwd || process.cwd());
  const rule = bundle.select.find((entry) => isRelativeTo(cwd, entry.path));
  const profile = rule?.profile ?? bundle.profile;
  const config = profile ? bundle.profiles[profile] : bundle.base;
  return { config, profile, cwd };
}


export function delegateTier(file, event, { model, providerInstanceId, driverKind }, requireTier) {
  try {
    const { config } = selectWorkerProfile(JSON.parse(fs.readFileSync(file, "utf8")), event);
    const entries = Object.entries(config.tiers);
    const providerTiers = entries.filter(([, tier]) => tier.provider);
    const providers = new Set(providerTiers.map(([, tier]) => tier.provider));
    if (providers.has(providerInstanceId)) {
      const match = providerTiers.find(([, tier]) => tier.provider === providerInstanceId && tier.model === model);
      if (match) return { name: match[0], tier: match[1] };
      return { denial: "For this provider, target.model must exactly match a configured Worker model in the active profile." };
    }
    if (providers.has(driverKind) || (!providerInstanceId && providerTiers.some(([, tier]) => tier.model === model))) {
      return { denial: "Set target.providerInstanceId to the provider of the configured Worker tier in the active profile." };
    }
    // Non-provider tiers match tier names, model IDs and routes, ignoring provider instance IDs and normalizing model strings.
    const full = String(model).replace(/\[[^\]]*\]$/, "");
    const short = full.split("/").pop();
    for (const [name, tier] of entries) {
      if (!tier.provider && (name === full || [tier.model, tier.claude_route].some((value) => value === full || value === short))) {
        return { name, tier };
      }
    }
  } catch {
    if (requireTier) return { denial: CONFIG_MISSING };
  }
  return requireTier
    ? { denial: "Set target.model and target.providerInstanceId (for provider tiers) to match a configured Worker tier in the active profile." }
    : {};
}


export async function t3Thread(id, { byCodexSession = false } = {}) {
  if (!id) return undefined;
  try {
    const home = process.env.T3CODE_HOME || path.join(os.homedir(), ".t3");
    const file = path.join(home, "userdata", "statev2.sqlite");
    if (!fs.existsSync(file)) return undefined;
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return db.prepare(`
        SELECT thread_id AS threadId,
               json_type(payload_json, '$.lineage') AS lineage,
               json_type(payload_json, '$.lineage.relationshipToParent') AS relationshipType,
               json_extract(payload_json, '$.lineage.relationshipToParent') AS relationship,
               json_extract(payload_json, '$.lineage.parentThreadId') AS parentThreadId,
               json_extract(payload_json, '$.providerInstanceId') AS providerInstanceId,
               json_extract(payload_json, '$.modelSelection.model') AS model
        FROM orchestration_v2_projection_threads
        WHERE thread_id = ${byCodexSession ? `(
          SELECT min(thread_id) FROM orchestration_v2_projection_provider_threads
          WHERE driver = 'codex' AND owner_node_id IS NULL
            AND json_extract(payload_json, '$.nativeThreadRef.nativeId') = ?
          HAVING count(DISTINCT thread_id) = 1
        )` : "?"}
        LIMIT 1
      `).get(id);
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

export const topLevelT3Thread = (row) => row?.lineage === "object" && row.relationshipType === "null";

export function t3WorkerTier(workers, event, row) {
  if (row?.relationship !== "subagent" || typeof row.model !== "string" || !row.model.trim()) return undefined;
  return delegateTier(workers, event, row, false).tier;
}
