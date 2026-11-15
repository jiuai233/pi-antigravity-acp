import type { AgentMessage, AssistantMessage, SessionEntry } from "./types";

/** Official appendEntry data, never an LLM message or executable toolCall. */
export const NATIVE_TOOL_ENTRY = "pi-native-tool";
export interface NativeToolActivity {
  version: 1;
  id: string;
  provider: "antigravity-acp";
  messageTimestamp: number;
  contentIndex: number;
  toolName: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  input?: Record<string, unknown>;
  output?: string;
  outputTruncated?: boolean;
  startedAt: number;
  updatedAt: number;
}
const statuses = new Set(["pending", "in_progress", "completed", "failed"]);
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Pick only v1 display fields; other extension data is not sent to the browser. */
export function readNativeToolActivity(value: unknown): NativeToolActivity | null {
  if (!record(value) || value.version !== 1 || value.provider !== "antigravity-acp"
    || typeof value.id !== "string" || !value.id || typeof value.toolName !== "string"
    || typeof value.title !== "string" || typeof value.status !== "string" || !statuses.has(value.status)
    || typeof value.messageTimestamp !== "number" || !Number.isFinite(value.messageTimestamp)
    || typeof value.contentIndex !== "number" || !Number.isInteger(value.contentIndex) || value.contentIndex < 0
    || typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt)
    || typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) return null;
  return {
    version: 1, id: value.id, provider: value.provider, messageTimestamp: value.messageTimestamp,
    contentIndex: value.contentIndex, toolName: value.toolName, title: value.title,
    status: value.status as NativeToolActivity["status"], startedAt: value.startedAt, updatedAt: value.updatedAt,
    ...(record(value.input) ? { input: value.input } : {}),
    ...(typeof value.output === "string" ? { output: value.output } : {}),
    ...(value.outputTruncated === true ? { outputTruncated: true } : {}),
  };
}
export function isNativeToolEntry(entry: { type?: unknown; customType?: unknown }): boolean {
  return entry.type === "custom" && entry.customType === NATIVE_TOOL_ENTRY;
}
export function nativeToolFromEntry(value: unknown): NativeToolActivity | null {
  return record(value) && isNativeToolEntry(value) ? readNativeToolActivity(value.data) : null;
}
export function upsertNativeTool(
  current: readonly NativeToolActivity[], activity: NativeToolActivity,
): NativeToolActivity[] {
  const index = current.findIndex(item => item.id === activity.id);
  if (index < 0) return [...current, activity];
  if (current[index].updatedAt > activity.updatedAt) return [...current];
  const next = [...current];
  next[index] = activity;
  return next;
}
export function nativeToolsFromEntries(entries: readonly SessionEntry[]): NativeToolActivity[] {
  let activities: NativeToolActivity[] = [];
  for (const entry of entries) {
    const activity = nativeToolFromEntry(entry);
    if (activity) activities = upsertNativeTool(activities, activity);
  }
  return activities;
}
/** Adds UI-only metadata to a copy, preserving original block indexes and source messages. */
export function withNativeTools<T extends AgentMessage>(message: T, activities: readonly NativeToolActivity[]): T {
  if (message.role !== "assistant") return message;
  const matching = activities.filter(item => item.provider === message.provider && item.messageTimestamp === message.timestamp);
  if (!matching.length) return message;
  let tools = (message as AssistantMessage).nativeTools ?? [];
  for (const activity of matching) tools = upsertNativeTool(tools, activity);
  return { ...message, nativeTools: tools };
}
