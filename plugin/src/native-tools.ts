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

type Anchor = Pick<NativeToolActivity, "messageTimestamp" | "contentIndex">;
const OUTPUT_LIMIT = 16_384;
const statuses = new Set(["pending", "in_progress", "completed", "failed"]);
const updates = new Set(["tool_call", "tool_call_update", "tool_call_content_chunk"]);

/** Select display text, never stringify native objects (media and reasoning live there). */
function displayText(value: any): string | undefined {
  if (Array.isArray(value)) {
    const parts = value.map(displayText).filter((part): part is string => part !== undefined);
    return parts.length ? parts.join("\n") : undefined;
  }
  if (typeof value === "string") {
    // Opaque encoded output is not a text result. Typed media is handled below.
    if (/[\x00-\x08\x0e-\x1f]/.test(value) || /^[A-Za-z0-9+/=_-]{128,}$/.test(value)) return undefined;
    return value.replace(/data:[^\s,]+;base64,[A-Za-z0-9+/=_-]+/gi, "[media data omitted]");
  }
  if (!value || typeof value !== "object") return undefined;
  if (value.type === "content") return displayText(value.content);
  if (value.type === "text") return displayText(value.text);
  if (["image", "audio", "video"].includes(value.type)) return `[${value.type}]`;
  // ACP embedded resources may hold text; blobs, URIs and unknown fields are not copied.
  if (value.type === "resource" && typeof value.resource?.text === "string") return displayText(value.resource.text);
  return undefined;
}

/** rawOutput may be a JSON envelope; select its text content rather than archiving the envelope. */
function rawOutputText(value: any): string | undefined {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object") return rawOutputText(parsed);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // Non-JSON strings are already plain output, not a structured envelope.
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.content)) {
    return displayText(value.content);
  }
  return displayText(value);
}

/** Prompt-only reducer for the one native tool enabled by our current agent profile. */
export class NativeToolRecords {
  private records = new Map<string, NativeToolActivity>();

  reduce(sessionId: string, update: any, anchor: () => Anchor, now = Date.now()): NativeToolActivity | undefined {
    if (!updates.has(update?.sessionUpdate) || typeof update.toolCallId !== "string" || !update.toolCallId) return undefined;
    const id = `${sessionId}:${update.toolCallId}`;
    const previous = this.records.get(id);
    // AGY's verified name extension, not title/kind guessing or MCP alias stripping.
    if (!previous && (update.sessionUpdate !== "tool_call" || update.name !== "read_file")) return undefined;
    const next: NativeToolActivity = previous ? { ...previous } : {
      version: 1, id, provider: "antigravity-acp", ...anchor(), toolName: "read_file",
      title: "read_file", status: "pending", startedAt: now, updatedAt: now,
    };
    if (typeof update.title === "string") next.title = update.title;
    if (statuses.has(update.status)) next.status = update.status;
    // Only known read_file arguments: do not persist arbitrary rawInput data.
    const path = typeof update.rawInput?.Path === "string" ? update.rawInput.Path
      : update.locations?.find((location: any) => typeof location?.path === "string")?.path;
    const lineArgs: Record<string, number> = {};
    for (const key of ["StartLine", "EndLine", "ByteOffset"] as const) {
      const value = update.rawInput?.[key];
      if (typeof value === "number" && Number.isInteger(value)) lineArgs[key] = value;
    }
    if (path !== undefined || Object.keys(lineArgs).length > 0) {
      next.input = { ...(next.input ?? {}), ...(path !== undefined ? { Path: path } : {}), ...lineArgs };
    }
    const text = displayText(update.content) ?? rawOutputText(update.rawOutput);
    if (text !== undefined) {
      const chunk = update.sessionUpdate === "tool_call_content_chunk";
      const output = chunk ? (previous?.output ?? "") + text : text;
      next.output = output.slice(0, OUTPUT_LIMIT);
      next.outputTruncated = output.length > OUTPUT_LIMIT || (chunk && previous?.outputTruncated === true);
    }
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) return undefined;
    next.updatedAt = now;
    this.records.set(id, next);
    // Callbacks get a detached snapshot, so persistence cannot mutate reducer state.
    return { ...next, ...(next.input ? { input: { ...next.input } } : {}) };
  }
}
