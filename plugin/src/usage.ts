import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ModelPricing } from "./models.ts";

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

type Counter = { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number };
const numeric = (value: unknown): number => value === undefined ? 0 : Number(value);
const counter = (u: any): Counter => ({ input: numeric(u.inputTokens), output: numeric(u.outputTokens),
  cacheRead: numeric(u.cacheReadTokens), cacheWrite: numeric(u.cacheWriteTokens), reasoning: numeric(u.thinkingOutputTokens) });
const countKeys = ["input", "output", "cacheRead", "cacheWrite", "reasoning"] as const;
const unknownUsage = (): Usage => ({
  input: NaN, output: NaN, cacheRead: NaN, cacheWrite: NaN, totalTokens: NaN,
  cost: { input: NaN, output: NaN, cacheRead: NaN, cacheWrite: NaN, total: NaN },
});

/** Native per-inference counters, not ACP's multi-inference/session total. */
export class UsageLedger {
  private counted = new Map<string, Counter>();
  private contextUsed: number | undefined;

  setContext(used: number): void {
    if (Number.isFinite(used) && used >= 0) this.contextUsed = used;
  }

  baseline(trajectory: any): void { this.consume(trajectory); }

  private consume(trajectory: any): { delta: Counter; context?: number; known: boolean; invalid: unknown[] } {
    try { return this.readCounters(trajectory); }
    catch (error) {
      // Accounting failures stay visible but never invalidate successfully generated content.
      return { delta: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        context: this.contextUsed, known: false,
        invalid: [{ error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) }] };
    }
  }

  private readCounters(trajectory: any): { delta: Counter; context?: number; known: boolean; invalid: unknown[] } {
    const delta: Counter = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    let last: Counter | undefined;
    const invalid: unknown[] = [];
    for (const [index, generation] of (trajectory?.generatorMetadata ?? []).entries()) {
      const raw = generation.chatModel?.usage;
      if (!raw) continue;
      const value = counter(raw);
      if (countKeys.some(key => !Number.isSafeInteger(value[key]) || value[key] < 0)) {
        invalid.push({ index, usage: raw });
        continue;
      }
      const key = raw.messageId ?? raw.responseId ?? `${generation.executionId ?? "native"}:${index}`;
      const prior = this.counted.get(key);
      for (const name of countKeys) delta[name] += Math.max(0, value[name] - (prior?.[name] ?? 0));
      this.counted.set(key, value);
      last = value;
    }
    const context = this.contextUsed ?? (last && last.input + last.cacheRead + last.cacheWrite + last.output);
    return { delta, context, known: last !== undefined && !invalid.length, invalid };
  }

  apply(output: AssistantMessage, trajectory: any, pricing: ModelPricing, acpUsage?: unknown): void {
    const observed = this.consume(trajectory);
    if (!observed.known) {
      // Unknown is not a measured zero; JSON persistence represents NaN as null.
      output.usage = unknownUsage();
      if (observed.context !== undefined) output.usage.totalTokens = observed.context;
      output.diagnostics ??= [];
      output.diagnostics.push({ type: "agy_acp_usage_unknown", timestamp: Date.now(),
        details: { context: observed.context ?? "unknown", billing: "unknown", invalidNativeUsage: observed.invalid, acpCumulativeUsage: acpUsage ?? null } as any });
      return;
    }
    const { delta, context } = observed;
    const cost = {
      input: delta.input * pricing.input / 1e6,
      output: delta.output * pricing.output / 1e6,
      cacheRead: delta.cacheRead * pricing.cacheRead / 1e6,
      cacheWrite: delta.cacheWrite * pricing.cacheWrite / 1e6,
      total: 0, totalFromProvider: false,
    };
    cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
    output.usage = { ...delta, totalTokens: context ?? 0, cost };
    output.diagnostics ??= [];
    output.diagnostics.push({ type: "agy_acp_usage", timestamp: Date.now(),
      details: { contextSource: this.contextUsed === undefined ? "native_last_inference" : "native_context_update",
        billingSource: "native_inference_delta", costSource: "catalog_estimate", acpCumulativeUsage: acpUsage ?? null } as any });
  }
}
