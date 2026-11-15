import { createHash } from "node:crypto";

/** Stateless deterministic native aliases: keep valid names, else readable stem + SHA-256 suffix. */
export function bridgeToolName(serverName: string, toolName: string, toolPrefix = ""): string {
  const original = `${toolPrefix}${toolName}`;
  const budget = 64 - `mcp_${serverName}_`.length;
  if (budget < 1) {
    throw new Error(`Antigravity CLI server name leaves no room for tool "${toolName}".`);
  }
  if (/^[a-zA-Z0-9_-]+$/.test(original) && original.length <= budget) {
    return original;
  }
  const hash = createHash("sha256").update(original).digest("hex").slice(0, Math.min(24, budget));
  if (budget <= hash.length + 1) {
    return hash.slice(0, budget);
  }
  const stem = original.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "pi_tool";
  const suffix = `_${hash}`;
  return `${stem.slice(0, budget - suffix.length)}${suffix}`;
}

/** Reject any alias collision (including a literal Pi name equal to an alias), never misroute. */
export function bridgeToolNames(
  serverName: string,
  toolNames: readonly string[],
  toolPrefix = "",
): Map<string, string> {
  const names = new Map<string, string>();
  for (const tool of toolNames) {
    const name = bridgeToolName(serverName, tool, toolPrefix);
    const existing = names.get(name);
    if (existing !== undefined && existing !== tool) {
      throw new Error(`Antigravity bridge tool name collision: "${tool}" and "${existing}" -> ${name}`);
    }
    names.set(name, tool);
  }
  return names;
}
