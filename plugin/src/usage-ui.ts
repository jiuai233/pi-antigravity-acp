import { BorderedLoader, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type AgyQuotaBucket, type AgyQuotaSummary, queryAntigravityQuota } from "./quota.ts";

const REFRESH = "Refresh";
const CLOSE = "Close";
const BAR_SEGMENTS = 20;
const LABEL_COLUMN = 16;
export const DEFAULT_USAGE_CACHE_TTL_MS = 60_000;

type LoaderResult<T> = { ok: true; value: T } | { ok: false; error: unknown } | null;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

export function usageBar(remainingPercent: number, segments = BAR_SEGMENTS): string {
  const ratio = Math.min(1, Math.max(0, remainingPercent / 100));
  const filled = Math.round(ratio * segments);
  return `[${"█".repeat(filled)}${"░".repeat(segments - filled)}]`;
}

export function formatResetTime(resetsAt: number, now: Date = new Date()): string | undefined {
  const reset = new Date(resetsAt);
  if (Number.isNaN(reset.getTime())) return undefined;
  const time = `${pad2(reset.getHours())}:${pad2(reset.getMinutes())}`;
  if (reset.toDateString() === now.toDateString()) return time;
  return `${time} on ${reset.getDate()} ${reset.toLocaleDateString("en-US", { month: "short" })}`;
}

function bucketLabel(bucket: AgyQuotaBucket): string {
  if (bucket.windowMinutes === 300) return "5h limit:";
  if (bucket.windowMinutes === 10080) return "Weekly limit:";
  const clean = bucket.label.trim() || bucket.id;
  return clean.endsWith(":") ? clean : `${clean}:`;
}

function formatPercent(value: number): string {
  const clamped = Math.min(100, Math.max(0, value));
  const rounded = Math.round(clamped * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatBucket(bucket: AgyQuotaBucket, now: Date): string {
  const label = bucketLabel(bucket).padEnd(LABEL_COLUMN);
  const parts = [`${usageBar(bucket.remainingPercent)} ${formatPercent(bucket.remainingPercent)}% left`];
  if (bucket.resetsAt !== null) {
    const reset = formatResetTime(bucket.resetsAt, now);
    if (reset) parts.push(`resets ${reset}`);
  }
  return `  ${label}${parts.join(" · ")}`;
}

export function formatAgyQuotaReport(summary: AgyQuotaSummary, now: Date = new Date()): string {
  const groups = new Map<string, AgyQuotaBucket[]>();
  for (const bucket of summary.buckets) {
    const list = groups.get(bucket.groupLabel) ?? [];
    list.push(bucket);
    groups.set(bucket.groupLabel, list);
  }
  const sections: string[] = [];
  for (const [groupLabel, buckets] of groups) {
    const lines = [groupLabel];
    for (const bucket of buckets) lines.push(formatBucket(bucket, now));
    sections.push(lines.join("\n"));
  }
  const sourceLabel = `${summary.source === "live-acp" ? "live ACP" : "seed ACP"}${summary.cached ? " (cached)" : ""}`;
  const captured = new Date(summary.capturedAt);
  const timeLabel = Number.isNaN(captured.getTime())
    ? ""
    : ` · ${pad2(captured.getHours())}:${pad2(captured.getMinutes())}:${pad2(captured.getSeconds())}`;
  sections.push(`Source: ${sourceLabel}${timeLabel}`);
  return sections.join("\n\n");
}

async function runWithLoader<T>(
  ctx: ExtensionCommandContext,
  label: string,
  parentSignal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
  if (ctx.mode !== "tui") return operation(parentSignal);
  const result = await ctx.ui.custom<LoaderResult<T>>((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, label, { cancellable: true });
    let finished = false;
    const finish = (value: LoaderResult<T>) => {
      if (finished) return;
      finished = true;
      done(value);
    };
    loader.onAbort = () => finish(null);
    const signal = AbortSignal.any([parentSignal, loader.signal]);
    void operation(signal)
      .then((value) => finish({ ok: true, value }))
      .catch((error) => {
        if (isAbortError(error)) finish(null);
        else finish({ ok: false, error });
      });
    return loader;
  });
  if (!result) return undefined;
  if (!result.ok) throw result.error;
  return result.value;
}

function notifyError(ctx: ExtensionCommandContext, error: unknown): void {
  ctx.ui.notify(`agy-usage: ${error instanceof Error ? error.message : String(error)}`, "error");
}

export type UsageQuotaFetcher = (
  signal?: AbortSignal,
  options?: { forceRefresh?: boolean },
) => Promise<AgyQuotaSummary>;

const defaultUsageFetcher: UsageQuotaFetcher = (signal, options) =>
  queryAntigravityQuota({
    signal,
    ...(options?.forceRefresh ? { forceRefresh: true } : { maxCacheAgeMs: DEFAULT_USAGE_CACHE_TTL_MS }),
  });

export async function openAgyUsagePicker(
  ctx: ExtensionCommandContext,
  fetchQuota: UsageQuotaFetcher = defaultUsageFetcher,
): Promise<void> {
  if (!ctx.hasUI) {
    try {
      ctx.ui.notify(formatAgyQuotaReport(await fetchQuota(undefined, { forceRefresh: false })), "info");
    } catch (error) {
      notifyError(ctx, error);
    }
    return;
  }

  const controller = new AbortController();
  try {
    let summary = await runWithLoader(ctx, "Checking agy quota…", controller.signal, (signal) =>
      fetchQuota(signal, { forceRefresh: false }),
    );
    if (!summary) return;
    while (!controller.signal.aborted) {
      const action = await ctx.ui.select(formatAgyQuotaReport(summary), [REFRESH, CLOSE], {
        signal: controller.signal,
      });
      if (!action || action === CLOSE) return;
      if (action === REFRESH) {
        try {
          const refreshed = await runWithLoader(ctx, "Refreshing usage…", controller.signal, (signal) =>
            fetchQuota(signal, { forceRefresh: true }),
          );
          if (refreshed) summary = refreshed;
        } catch (error) {
          if (isAbortError(error)) return;
          notifyError(ctx, error);
        }
      }
    }
  } catch (error) {
    if (isAbortError(error)) return;
    notifyError(ctx, error);
  } finally {
    controller.abort();
  }
}
