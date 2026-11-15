import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AcpProcess } from "./acp.ts";
import { NativeControl, readNativeHttpPort } from "./native.ts";
import { readAgyNetworkMonitor } from "./network-monitor.ts";
import { resolveBinary } from "./platform.ts";
import { installAgyDeathHooks, trackAgyChild, untrackAgyChild } from "./processes.ts";
import { removeNativeBootstrap } from "./store.ts";

export const AGY_ACP_QUOTA_BRIDGE_SYMBOL = Symbol.for("pi-stack.antigravity-acp.quota.v1");
const AGY_LIVE_RUNTIMES_SYMBOL = Symbol.for("pi-stack.antigravity-acp.live-runtimes.v1");

export interface AgyQuotaBucket {
  id: string;
  label: string;
  groupLabel: string;
  usedPercent: number;
  remainingPercent: number;
  windowMinutes: number | null;
  resetsAt: number | null;
}

export interface AgyQuotaSummary {
  capturedAt: number;
  source: "live-acp" | "seed-acp";
  buckets: AgyQuotaBucket[];
}

export interface LiveQuotaRuntime {
  hasLiveNativeControl(): boolean;
  readQuotaSummary(signal?: AbortSignal): Promise<unknown>;
}

export interface QueryAntigravityQuotaOptions {
  allowColdSeed?: boolean;
  signal?: AbortSignal;
  stateRoot?: string;
  cwd?: string;
  binary?: string;
  env?: NodeJS.ProcessEnv;
  createProcess?: typeof AcpProcess.start;
}

export interface AgyQuotaBridge {
  queryQuota(options?: QueryAntigravityQuotaOptions): Promise<AgyQuotaSummary>;
  hasLiveRuntime(): boolean;
  configureDefaults(defaults: { stateRoot?: () => string; cwd?: () => string; binary?: () => string }): void;
}

interface RuntimeRegistry {
  runtimes: Map<LiveQuotaRuntime, number>;
  sequence: number;
  defaults: {
    stateRoot?: () => string;
    cwd?: () => string;
    binary?: () => string;
  };
  liveFlight?: Promise<AgyQuotaSummary>;
  seedFlight?: Promise<AgyQuotaSummary>;
}

function getRegistry(): RuntimeRegistry {
  const host = globalThis as Record<symbol, unknown>;
  let existing = host[AGY_LIVE_RUNTIMES_SYMBOL] as RuntimeRegistry | undefined;
  if (!existing) {
    existing = { runtimes: new Map(), sequence: 0, defaults: {} };
    host[AGY_LIVE_RUNTIMES_SYMBOL] = existing;
  }
  return existing;
}

export function registerLiveAcpRuntime(runtime: LiveQuotaRuntime): void {
  const registry = getRegistry();
  registry.runtimes.set(runtime, ++registry.sequence);
}

export function touchLiveAcpRuntime(runtime: LiveQuotaRuntime): void {
  const registry = getRegistry();
  if (registry.runtimes.has(runtime)) registry.runtimes.set(runtime, ++registry.sequence);
}

export function unregisterLiveAcpRuntime(runtime: LiveQuotaRuntime): void {
  getRegistry().runtimes.delete(runtime);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function resolveRemainingFraction(bucket: Record<string, unknown>): number | undefined {
  const direct = toFiniteNumber(bucket.remainingFraction ?? bucket.remaining_fraction);
  if (direct !== undefined) return direct;
  const nested = asRecord(bucket.remaining);
  if (!nested) return undefined;
  const nestedDirect = toFiniteNumber(nested.remainingFraction ?? nested.remaining_fraction);
  if (nestedDirect !== undefined) return nestedDirect;
  if (nested.case === "remainingFraction") {
    return toFiniteNumber(nested.value);
  }
  return undefined;
}

function parseResetTimestamp(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return raw >= 100_000_000_000 ? Math.trunc(raw) : Math.trunc(raw * 1_000);
  }
  const text = nonEmptyString(raw);
  if (!text) return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    const num = Number(text);
    if (!Number.isFinite(num) || num <= 0) return null;
    return num >= 100_000_000_000 ? Math.trunc(num) : Math.trunc(num * 1_000);
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function groupRankAndLabel(group: Record<string, unknown>): { rank: number; label: string; scope: string } {
  const title = nonEmptyString(group.displayName ?? group.display_name ?? group.name) ?? "Quota";
  const lower = title.toLowerCase();
  const rank = lower.includes("gemini") ? 0 : lower.includes("claude") || lower.includes("gpt") ? 1 : 2;
  const label = rank === 0 ? "Gemini" : rank === 1 ? "Claude/GPT" : title;
  const scope = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "quota";
  return { rank, label, scope };
}

function classifyBucket(bucket: Record<string, unknown>): { order: number; windowMinutes: number | null; label: string } {
  const idText = nonEmptyString(bucket.bucketId ?? bucket.bucket_id ?? bucket.id);
  const nameText = nonEmptyString(bucket.displayName ?? bucket.display_name ?? bucket.name);
  const candidates: string[] = [];
  for (const raw of [idText, nameText]) {
    if (!raw) continue;
    const normalized = raw.toLowerCase().replace(/_/g, "-");
    candidates.push(normalized);
    if (normalized.endsWith(" limit")) candidates.push(normalized.slice(0, -6).trim());
  }
  const sessionAliases = ["session", "5h", "5-hour", "five hour", "five-hour"];
  if (candidates.some(c => sessionAliases.some(alias => c === alias || c.endsWith(`-${alias}`)))) {
    return { order: 0, windowMinutes: 300, label: "5 小时额度" };
  }
  if (candidates.some(c => c === "weekly" || c.endsWith("-weekly") || c === "7d" || c.endsWith("-7d"))) {
    return { order: 1, windowMinutes: 10080, label: "周额度" };
  }
  return { order: 2, windowMinutes: null, label: nameText ?? idText ?? "额度" };
}

export function parseAgyQuotaSummary(
  raw: unknown,
  capturedAt = Date.now(),
  source: "live-acp" | "seed-acp" = "live-acp",
): AgyQuotaSummary {
  const envelope = asRecord(raw);
  if (!envelope) throw new Error("Antigravity quota summary response is not an object.");
  const payload = asRecord(envelope.response) ?? asRecord(envelope.summary) ?? envelope;
  const groupsRaw = Array.isArray(payload.groups) ? payload.groups : null;
  if (!groupsRaw) throw new Error("Antigravity quota summary is missing groups.");

  const indexedGroups = groupsRaw
    .map((entry, index) => ({ group: asRecord(entry), index }))
    .filter((entry): entry is { group: Record<string, unknown>; index: number } => entry.group !== null)
    .map(({ group, index }) => ({ group, index, ...groupRankAndLabel(group) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index);

  const buckets: AgyQuotaBucket[] = [];
  const usedIds = new Set<string>();
  const scopeCounts = new Map<string, number>();

  for (const { group, label: groupLabel, scope: baseScope } of indexedGroups) {
    const count = scopeCounts.get(baseScope) ?? 0;
    scopeCounts.set(baseScope, count + 1);
    const groupScope = count === 0 ? baseScope : `${baseScope}-${count}`;
    const rawBuckets = Array.isArray(group.buckets) ? group.buckets : [];
    const sortedBuckets = rawBuckets
      .map((item, idx) => ({ bucket: asRecord(item), idx }))
      .filter((item): item is { bucket: Record<string, unknown>; idx: number } => item.bucket !== null)
      .map(({ bucket, idx }) => ({ bucket, idx, classified: classifyBucket(bucket) }))
      .sort((a, b) => a.classified.order - b.classified.order || a.idx - b.idx);

    for (const { bucket, classified } of sortedBuckets) {
      if (bucket.disabled === true) continue;
      const bucketId = nonEmptyString(bucket.bucketId ?? bucket.bucket_id ?? bucket.id);
      if (!bucketId) continue;
      const fraction = resolveRemainingFraction(bucket);
      if (fraction === undefined) continue;
      const clamped = Math.min(1, Math.max(0, fraction));
      const remainingPercent = Number((clamped * 100).toFixed(2));
      const usedPercent = Number(Math.max(0, 100 - remainingPercent).toFixed(2));
      const resetsAt = parseResetTimestamp(bucket.resetTime ?? bucket.reset_time);

      const baseId = `${groupScope}-${bucketId.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`;
      let id = baseId;
      let ordinal = 1;
      while (usedIds.has(id)) {
        id = `${baseId}-${ordinal++}`;
      }
      usedIds.add(id);

      buckets.push({
        id,
        label: classified.label,
        groupLabel,
        usedPercent,
        remainingPercent,
        windowMinutes: classified.windowMinutes,
        resetsAt,
      });
    }
  }

  if (!buckets.length) {
    throw new Error("Antigravity quota summary contained no usable quota buckets.");
  }

  return { capturedAt, source, buckets };
}

async function queryViaColdSeed(options: QueryAntigravityQuotaOptions): Promise<AgyQuotaSummary> {
  const registry = getRegistry();
  const stateRoot = options.stateRoot
    ?? registry.defaults.stateRoot?.()
    ?? process.env.AGY_ACP_STATE_DIR
    ?? path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"), "antigravity-acp");
  const cwd = options.cwd ?? registry.defaults.cwd?.() ?? process.cwd();
  const executable = options.binary ?? registry.defaults.binary?.() ?? resolveBinary();
  const env = options.env ?? readAgyNetworkMonitor().env;
  const geminiDir = path.join(stateRoot, "_quota-seed", "gemini");
  const logDirectory = path.join(geminiDir, "antigravity-cli", "log");
  await mkdir(logDirectory, { recursive: true });
  installAgyDeathHooks();

  const acp = await (options.createProcess ?? AcpProcess.start)({
    executable,
    cwd,
    env,
    geminiDir,
    processPerSession: true,
    logDirectory,
    readNativeHttpPort,
    requestPermission: () => ({ outcome: { outcome: "cancelled" } }),
  });
  trackAgyChild(acp);
  let seedSessionId: string | undefined;
  try {
    await acp.initialize();
    const seed = await acp.newSession({ cwd, mcpServers: [] });
    seedSessionId = seed.sessionId;
    const control = new NativeControl(await acp.getNativeHttpPort());
    const raw = await control.quotaSummary(options.signal);
    return parseAgyQuotaSummary(raw, Date.now(), "seed-acp");
  } finally {
    try {
      if (seedSessionId) await acp.closeSession(seedSessionId);
    } catch {
      // Best-effort seed session teardown before terminating process.
    }
    await acp.close().catch(() => undefined);
    untrackAgyChild(acp);
    if (seedSessionId) {
      const conversations = path.join(geminiDir, "antigravity-cli", "conversations");
      await Promise.all([".pb", ".db"].map(ext => removeNativeBootstrap(path.join(conversations, seedSessionId + ext))));
    }
  }
}

export async function queryAntigravityQuota(options: QueryAntigravityQuotaOptions = {}): Promise<AgyQuotaSummary> {
  const registry = getRegistry();
  const candidates = [...registry.runtimes.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([runtime]) => runtime)
    .filter(runtime => runtime.hasLiveNativeControl());

  let lastLiveError: unknown;
  if (candidates.length > 0 || registry.liveFlight) {
    let liveTask = registry.liveFlight;
    if (!liveTask) {
      liveTask = (async () => {
        let err: unknown;
        for (const runtime of candidates) {
          try {
            const raw = await runtime.readQuotaSummary(options.signal);
            return parseAgyQuotaSummary(raw, Date.now(), "live-acp");
          } catch (error) {
            err = error;
          }
        }
        throw err instanceof Error ? err : new Error("No active Antigravity ACP runtime succeeded.");
      })();
      registry.liveFlight = liveTask;
      void liveTask.finally(() => {
        if (registry.liveFlight === liveTask) registry.liveFlight = undefined;
      }).catch(() => undefined);
    }
    try {
      return await liveTask;
    } catch (error) {
      lastLiveError = error;
    }
  }

  if (options.allowColdSeed === false) {
    if (registry.seedFlight) return registry.seedFlight;
    if (lastLiveError instanceof Error) throw lastLiveError;
    throw new Error("No active Antigravity ACP runtime is available for quota query.");
  }

  if (registry.seedFlight) return registry.seedFlight;
  const seedTask = queryViaColdSeed(options);
  registry.seedFlight = seedTask;
  void seedTask.finally(() => {
    if (registry.seedFlight === seedTask) registry.seedFlight = undefined;
  }).catch(() => undefined);
  return seedTask;
}

export function ensureAgyQuotaBridge(): AgyQuotaBridge {
  const host = globalThis as Record<symbol, unknown>;
  const bridge: AgyQuotaBridge = {
    queryQuota: queryAntigravityQuota,
    hasLiveRuntime: () => [...getRegistry().runtimes.keys()].some(runtime => runtime.hasLiveNativeControl()),
    configureDefaults: (defaults) => {
      const registry = getRegistry();
      registry.defaults = { ...registry.defaults, ...defaults };
    },
  };
  host[AGY_ACP_QUOTA_BRIDGE_SYMBOL] = bridge;
  return bridge;
}

ensureAgyQuotaBridge();
