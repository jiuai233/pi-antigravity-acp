/**
 * agy model discovery. Effort variants are presented as one Pi model while
 * retaining the launch constraints agy requires for the normalized base id.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
export type AgyEffort = "low" | "medium" | "high" | "xhigh";

export interface AgyModelInfo {
  id: string;
  name: string;
  supportedEfforts: AgyEffort[];
  defaultEffort?: AgyEffort;
}

const EFFORT_SUFFIX = /-(low|medium|high|xhigh)$/i;
const EFFORT_NAME_SUFFIX = /\s*\((?:low|medium|high|xhigh)\)$/i;

function isAgyEffort(effort: string | undefined): effort is AgyEffort {
  return effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh";
}

function effortFromId(id: string): AgyEffort | undefined {
  const match = id.match(EFFORT_SUFFIX);
  const effort = match?.[1]?.toLowerCase();
  return isAgyEffort(effort) ? effort : undefined;
}

/** Collapse one effort variant while retaining its discovered effort. */
export function normalizeAgyModelId(id: string, name: string): AgyModelInfo {
  const effort = effortFromId(id);
  const baseId = effort ? id.replace(EFFORT_SUFFIX, "") : id;
  const baseName = effort ? name.replace(EFFORT_NAME_SUFFIX, "").trim() : name.trim();
  return {
    id: baseId || id,
    name: baseName || name,
    supportedEfforts: effort ? [effort] : [],
    defaultEffort: effort,
  };
}

/** Merge normalized/cache records without losing effort variants or discovery order. */
export function mergeAgyModels(models: readonly AgyModelInfo[]): AgyModelInfo[] {
  const merged: AgyModelInfo[] = [];
  for (const raw of models) {
    const normalized = normalizeAgyModelId(raw.id, raw.name);
    const efforts = raw.supportedEfforts?.length
      ? raw.supportedEfforts.filter(isAgyEffort)
      : normalized.supportedEfforts;
    const existing = merged.find((model) => model.id === normalized.id);
    if (!existing) {
      merged.push({
        id: normalized.id,
        name: normalized.name,
        supportedEfforts: [...new Set(efforts)],
        defaultEffort: raw.defaultEffort ?? normalized.defaultEffort ?? efforts[0],
      });
      continue;
    }
    for (const effort of efforts) {
      if (!existing.supportedEfforts.includes(effort)) existing.supportedEfforts.push(effort);
    }
    existing.defaultEffort ??= raw.defaultEffort ?? normalized.defaultEffort ?? efforts[0];
  }
  return merged;
}

/** Parse `agy models` output: header/noise lines without a tab are ignored. */
export function parseAgyModels(text: string): AgyModelInfo[] {
  const rows: AgyModelInfo[] = [];
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const rawId = line.slice(0, tab).trim();
    const rawName = line.slice(tab + 1).trim();
    if (!rawId || !rawName) continue;
    if (!/^[a-z0-9][a-z0-9.-]*$/i.test(rawId)) continue;
    rows.push(normalizeAgyModelId(rawId, rawName));
  }
  return mergeAgyModels(rows);
}

export interface ModelCapabilities {
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
}

/** USD per million tokens. */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const ZERO_PRICING: ModelPricing = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

/**
 * Public API list prices, used only as a display estimate because agy itself
 * is subscription-billed. Unknown models deliberately stay at zero rather
 * than inheriting an unrelated vendor's rate.
 */
export function pricingForModel(modelId: string, asOf = Date.now()): ModelPricing {
  if (/^gemini-4-neon$/i.test(modelId)) {
    // https://aistudio.google.com/docs/pricing#gemini-4-neon
    return { input: 3, output: 15, cacheRead: 0.15, cacheWrite: 0 };
  }
  if (/^gemini-4-(?:argon|carbon)$/i.test(modelId)) {
    // Argon and Carbon share the same Standard-tier rates; introductory rates expire after November 30, 2026.
    // https://ai.google.dev/gemini-api/docs/pricing
    const multiplier = asOf < Date.UTC(2026, 11, 1) ? 1 : 2;
    return { input: 2 * multiplier, output: 10 * multiplier, cacheRead: 0.1 * multiplier, cacheWrite: 0 };
  }
  if (/^gemini-4-hydrogen$/i.test(modelId)) {
    // https://ai.google.dev/gemini-api/docs/pricing#gemini-4-hydrogen
    return { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0 };
  }
  // https://platform.claude.com/docs/en/about-claude/pricing
  if (/^claude-sonnet-5-5(?:$|-)/i.test(modelId)) {
    return { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 };
  }
  if (/^claude-opus-5-5(?:$|-)/i.test(modelId)) {
    return { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
  }
  if (/^gemini-3\.(?:8|7|6)-flash$/i.test(modelId)) {
    return { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 };
  }
  if (/^gemini-3\.5-flash$/i.test(modelId)) {
    return { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 1.5 };
  }
  if (/^gemini-3\.1-pro/i.test(modelId)) {
    return { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2 };
  }
  if (/^claude-sonnet-4-6/i.test(modelId)) {
    return { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
  }
  if (/^claude-opus-4-6/i.test(modelId)) {
    return { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
  }
  return { ...ZERO_PRICING };
}

/** Pi scheduling window for Gemini models with the AGY 512K preset. */
export const AGY_PI_SCHEDULING_CONTEXT_WINDOW = 512_000;

export function toProviderModel(model: AgyModelInfo): ProviderModelConfig {
  const capabilities = capabilitiesForModel(model.id);
  return {
    id: model.id,
    name: `${model.name} (ACP)`,
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh" },
    input: capabilities.input,
    cost: pricingForModel(model.id),
    contextWindow: capabilities.contextWindow,
    maxTokens: capabilities.maxTokens,
  };
}

export function capabilitiesForModel(modelId: string): ModelCapabilities {
  let maxTokens: number;
  if (/^gpt-oss-120b/i.test(modelId)) {
    maxTokens = 32_768;
  } else if (/^claude-opus-4-6/i.test(modelId)) {
    maxTokens = 128_000;
  } else if (/^claude-sonnet-4-6/i.test(modelId)) {
    maxTokens = 64_000;
  } else if (/^gemini-/i.test(modelId)) {
    maxTokens = 65_536;
  } else {
    maxTokens = 32_768;
  }
  // Forward real media to the native model; do not infer admission from a family regex.
  const input: ModelCapabilities["input"] = ["text", "image"];
  // GPT-OSS keeps a native 98,304-token working budget even with the 512K
  // preset; do not advertise a larger usable window for this disabled model.
  const contextWindow = /^gpt-oss-120b/i.test(modelId) ? 98_304
    : /^claude-(?:opus|sonnet)-5-5(?:$|-)/i.test(modelId) ? 840_000
    : AGY_PI_SCHEDULING_CONTEXT_WINDOW;
  return { input, contextWindow, maxTokens };
}
