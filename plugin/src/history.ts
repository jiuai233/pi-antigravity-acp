import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DescFile, DescMessage, JsonValue, Message as ProtoMessage } from "@bufbuild/protobuf";
import { createRegistry, fromBinary, fromJson, toBinary, toJson } from "@bufbuild/protobuf";
import { fileDesc } from "@bufbuild/protobuf/codegenv2";
import type { Api, Message, Model, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { BRIDGE_SERVER_NAME } from "./bridge/bridge.ts";
import { bridgeToolName, bridgeToolNames } from "./bridge/names.ts";
import { transformMessages } from "./pi-compat.ts";
import { acpContent, visibleContent } from "./content.ts";

// Native protobuf fields and persistence-format constants, not executable admission rules.
const resource = JSON.parse(await readFile(
  new URL("../resources/history-schema.json", import.meta.url), "utf8",
)) as {
  encryptionKeyBase64: string;
  descriptorBase64: string;
  agentMetadataDescriptors: string[];
  enums: Record<string, number>;
};
// Dependency-ordered, exact-ABI field-type closure, not the whole native schema.
const metadataFiles: DescFile[] = [];
for (const encoded of resource.agentMetadataDescriptors) metadataFiles.push(fileDesc(encoded, metadataFiles));
const descriptor = fileDesc(resource.descriptorBase64, metadataFiles);
const nativeRegistry = createRegistry(descriptor, ...metadataFiles);
const nativeMetadataSchema: DescMessage = descriptor.messages.find(
  (message) => message.name === "CortexTrajectoryMetadata",
) as DescMessage;
// Trajectory is the first declaration in the checked-in partial FileDescriptorProto.
export const nativeTrajectorySchema: DescMessage = descriptor.messages[0];
const enums = resource.enums;
const DONE = enums.CORTEX_STEP_STATUS_DONE;
const statuses = {
  done: DONE,
  invalid: enums.CORTEX_STEP_STATUS_INVALID,
  canceled: enums.CORTEX_STEP_STATUS_CANCELED,
  error: enums.CORTEX_STEP_STATUS_ERROR,
};

export type NativeCall = { id: string; name: string; argumentsJson: string };
type NativeTimestamp = { seconds: bigint; nanos: number };
export type NativeMedia = {
  mimeType: string;
  payload: { case: "inlineData"; value: Uint8Array };
};
export type NativeUserInput = {
  userResponse: string;
  items: { chunk: { case: "text"; value: string } }[];
  media: NativeMedia[];
  clientMessageId: string;
};
export type NativePlannerResponse = { response: string; messageId: string; toolCalls: NativeCall[] };
export type NativeMcpTool = {
  serverName: string;
  toolCall?: NativeCall;
  result: { case: "resultString"; value: string } | { case: undefined; value?: undefined };
  media: NativeMedia[];
};
export type NativeStep = ProtoMessage & {
  type: number;
  status: number;
  metadata?: { createdAt?: NativeTimestamp; completedAt?: NativeTimestamp; toolCall?: NativeCall };
  error?: { userErrorMessage: string; modelErrorMessage: string; shortError: string; fullError: string };
  // Original protobuf oneofs are retained (including user items, media and MCP result).
  step: { case: "userInput"; value: NativeUserInput }
    | { case: "plannerResponse"; value: NativePlannerResponse }
    | { case: "mcpTool"; value: NativeMcpTool }
    | { case: undefined; value?: undefined };
};
export type NativeTrajectory = ProtoMessage & {
  trajectoryId: string;
  cascadeId: string;
  steps: NativeStep[];
  metadata?: {
    createdAt?: NativeTimestamp;
    workspaceUris: string[];
    projectId: string;
    tags: string[];
    staticConfig?: ProtoMessage;
    agentScript?: ProtoMessage;
  };
};
export type NativeToolStatus = keyof typeof statuses;
export interface NativeHistoryConfig {
  /** Numeric plan model already resolved by the caller against this native ABI. */
  planModel: number;
  useCoreDirect?: boolean;
}
export interface NativeAgentMetadata {
  /** Copy only these two JSON fields from a zero-generation native trajectory's metadata. */
  staticConfig: Record<string, unknown>;
  agentScript: Record<string, unknown>;
}
export interface BuildNativeHistoryOptions {
  cwd: string;
  /** Native-compiled agent persistence, required by native load to restore this agent. */
  nativeAgentMetadata?: NativeAgentMetadata;
  serverName?: string;
  /** Optional, verified configuration only; this module never warms up a model. */
  nativeConfig?: NativeHistoryConfig;
  /** Pi only has isError. Supply this when the caller knows canceled/invalid explicitly. */
  toolResultStatus?: (result: ToolResultMessage, messageIndex: number) => NativeToolStatus;
}
export interface MessageStepBoundary {
  /** Index into the original, effective Pi Message[], including system/omitted entries. */
  messageIndex: number;
  /** Zero-based native step range [stepStart, stepEnd); empty for omitted/system messages. */
  stepStart: number;
  stepEnd: number;
}
export interface BuiltNativeHistory {
  conversationId: string;
  trajectory: NativeTrajectory;
  /** Plain protobuf; writeNativeHistory encrypts it for native persistence. */
  bytes: Uint8Array;
  messageStepBoundaries: MessageStepBoundary[];
}
export interface WriteNativeHistoryOptions {
  conversationsDirectory: string;
}
export interface WrittenNativeHistory {
  conversationId: string;
  path: string;
}
export class NativeHistoryError extends Error {
  code: string;
  messageIndex?: number;
  constructor(code: string, message: string, messageIndex?: number) {
    super(message);
    this.name = "NativeHistoryError";
    this.code = code;
    this.messageIndex = messageIndex;
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonRecord = { [key: string]: Json };
const sourceIndex = Symbol("Pi effective message index");
type IndexedMessage = Message & { [sourceIndex]?: number };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  const json = JSON.stringify(value);
  if (json === undefined || (typeof value === "number" && !Number.isFinite(value))) {
    throw new NativeHistoryError("unsupported_value", "History contains a non-JSON value");
  }
  return json;
}

function contentParts(message: Message): { texts: string[]; media: JsonRecord[] } {
  const texts: string[] = [];
  const media: JsonRecord[] = [];
  if (typeof message.content === "string") texts.push(message.content);
  else for (const block of message.content ?? []) {
    if (block.type === "toolCall" || block.type === "thinking") continue;
    for (const part of acpContent([block])) {
      if (part.type === "text") texts.push(part.text);
      else if ((part.type === "image" || part.type === "audio") && message.role !== "assistant") media.push({ mimeType: part.mimeType, inlineData: part.data });
      else texts.push(visibleContent(part));
    }
  }
  return { texts, media };
}

function nativeCall(call: ToolCall, serverName: string): NativeCall {
  const alias = bridgeToolName(serverName, call.name, "");
  return {
    id: call.id,
    name: "call_mcp_tool",
    argumentsJson: canonical({
      ServerName: serverName,
      ToolName: alias,
      Arguments: call.arguments ?? {},
    }),
  };
}

function agentMetadata(value: NativeAgentMetadata | undefined): JsonRecord | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || [value.staticConfig, value.agentScript].some((field) => field === null
      || typeof field !== "object" || Array.isArray(field))) {
    throw new NativeHistoryError("invalid_native_agent_metadata", "nativeAgentMetadata must contain only staticConfig and agentScript objects, not old trajectory metadata");
  }
  try {
    // Native extensions outside the known system/tool fields are not import admission rules.
    const decoded = fromJson(nativeMetadataSchema, structuredClone({
      staticConfig: value.staticConfig, agentScript: value.agentScript,
    }) as unknown as JsonValue, { ignoreUnknownFields: true, registry: nativeRegistry });
    return toJson(nativeMetadataSchema, decoded, { registry: nativeRegistry }) as JsonRecord;
  } catch (error) {
    throw new NativeHistoryError("invalid_native_agent_metadata", `Cannot encode native agent metadata: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function timestamp(milliseconds: number): JsonRecord {
  if (!Number.isFinite(milliseconds)) {
    throw new NativeHistoryError("invalid_timestamp", "History timestamp must be finite milliseconds");
  }
  const seconds = Math.floor(milliseconds / 1000);
  return { seconds: String(seconds), nanos: Math.floor((milliseconds - seconds * 1000) * 1_000_000) };
}

/**
 * Convert the caller's already-effective Pi history, without reading JSONL, compacting,
 * executing tools or contacting AGY. System messages stay in the agent; the caller
 * supplies the native-compiled agent metadata for native load's system/tool restoration.
 * Thinking/signatures are never imported.
 */
/** Drop only unaccepted assistants and their own matching results, not genuine orphan results. */
export function acceptedMessages<T extends Message>(messages: readonly T[]): T[] {
  let rejected = new Map<string, string>();
  return messages.filter(message => {
    if (message.role === "user") rejected.clear();
    if (message.role === "assistant") {
      rejected = new Map();
      if (["error", "aborted", "pending", "deferred"].includes(message.stopReason)) {
        for (const part of message.content ?? []) {
          if (part.type === "toolCall") rejected.set(part.id, part.name);
        }
        return false;
      }
    }
    if (message.role === "toolResult" && rejected.get(message.toolCallId) === message.toolName) {
      rejected.delete(message.toolCallId);
      return false;
    }
    return true;
  });
}

export function buildNativeHistory<TApi extends Api>(
  messages: readonly Message[], model: Model<TApi>, options: BuildNativeHistoryOptions,
): BuiltNativeHistory {
  if (!isAbsolute(options.cwd)) {
    throw new NativeHistoryError("invalid_cwd", "Native history requires an absolute workspace cwd");
  }
  const workspaceUri = pathToFileURL(options.cwd).href;
  const nativeAgentMetadata = agentMetadata(options.nativeAgentMetadata);
  if (options.nativeConfig && !Number.isInteger(options.nativeConfig.planModel)) {
    throw new NativeHistoryError("invalid_native_config", "nativeConfig.planModel must be a verified numeric enum");
  }
  const originals = structuredClone(messages) as IndexedMessage[];
  originals.forEach((message, index) => {
    message[sourceIndex] = index;
    if (message.content == null) message.content = [];
  });
  // Do not normalize native tool IDs: ChatToolCall.id accepts the original string.
  // Preserve actual media; the native endpoint, not a model-name guess, handles capability.
  const transformed = transformMessages(acceptedMessages(originals), { ...model, input: ["text", "image"] }) as IndexedMessage[];
  const pending = new Map<string, { toolName: string; native: NativeCall }>();
  const counts = messages.map(() => 0);
  const steps: JsonRecord[] = [];
  const serverName = options.serverName ?? BRIDGE_SERVER_NAME;
  const historicalToolNames = transformed.flatMap((message) =>
    message.role === "assistant" && Array.isArray(message.content)
      ? message.content.filter((block): block is ToolCall => block.type === "toolCall").map((block) => block.name)
      : [],
  );
  bridgeToolNames(serverName, historicalToolNames, "");
  for (const message of transformed) {
    const index = message[sourceIndex];
    // Pi inserts error placeholders for missing results. These are not real executions.
    if (index === undefined || message.role === "system") continue;
    const { texts, media } = contentParts(message);
    let body: JsonRecord;
    if (message.role === "user") {
      pending.clear();
      const userInput: JsonRecord = { userResponse: texts.join("\n"), items: texts.map((text) => ({ text })), media };
      if (options.nativeConfig) userInput.userConfig = {
        plannerConfig: { planModel: options.nativeConfig.planModel },
        executorConfig: { useCoreDirect: options.nativeConfig.useCoreDirect ?? true },
        dynamicWorkspaceUris: [workspaceUri],
      };
      body = { type: enums.CORTEX_STEP_TYPE_USER_INPUT, status: DONE, userInput };
    } else if (message.role === "assistant") {
      // Pi already removes error/aborted assistants. Pending/deferred are not completed either.
      if (message.stopReason === "pending" || message.stopReason === "deferred") continue;
      pending.clear();
      const entries = message.content
        .filter((block): block is ToolCall => block.type === "toolCall")
        .map((block) => ({ toolName: block.name, native: nativeCall(block, serverName) }));
      for (const entry of entries) {
        if (pending.has(entry.native.id)) {
          throw new NativeHistoryError("duplicate_tool_call", `Duplicate tool call ID: ${entry.native.id}`, index);
        }
        pending.set(entry.native.id, entry);
      }
      const calls = entries.map((entry) => entry.native);
      if (texts.length === 0 && calls.length === 0) continue;
      body = {
        type: enums.CORTEX_STEP_TYPE_PLANNER_RESPONSE, status: DONE,
        plannerResponse: { response: texts.join("\n"), toolCalls: calls },
      };
    } else if (message.role === "toolResult") {
      const entry = pending.get(message.toolCallId);
      if (!entry || entry.toolName !== message.toolName) {
        throw new NativeHistoryError("unmatched_tool_result", `No matching call for tool result ${message.toolCallId} (${message.toolName})`, index);
      }
      const call = entry.native;
      const status = options.toolResultStatus?.(structuredClone(message), index)
        ?? (message.isError ? "error" : "done");
      if (!Object.hasOwn(statuses, status) || (message.isError && status === "done")) {
        throw new NativeHistoryError("invalid_tool_status", "A failed tool result cannot be imported as DONE", index);
      }
      const text = texts.join("\n");
      body = {
        type: enums.CORTEX_STEP_TYPE_MCP_TOOL, status: statuses[status],
        mcpTool: { serverName, toolCall: call, resultString: text, media },
      };
      if (status !== "done") body.error = {
        // Native toolStepOutput consumes Step.error; preserve actual tool text, not a success placeholder.
        userErrorMessage: text, modelErrorMessage: text, shortError: text, fullError: text,
      };
      pending.delete(message.toolCallId);
    } else continue;
    const at = timestamp(message.timestamp);
    body.metadata = { createdAt: at, completedAt: at };
    if (message.role === "toolResult") {
      (body.metadata as JsonRecord).toolCall = (body.mcpTool as JsonRecord).toolCall;
    }
    if (message.role === "user") (body.userInput as JsonRecord).clientMessageId = randomUUID();
    if (message.role === "assistant") (body.plannerResponse as JsonRecord).messageId = randomUUID();
    counts[index]++;
    steps.push(body);
  }
  const conversationId = randomUUID();
  const trajectory = fromJson(nativeTrajectorySchema, {
    trajectoryId: conversationId, cascadeId: conversationId, steps,
    metadata: {
      createdAt: timestamp(Date.now()), workspaceUris: [workspaceUri],
      projectId: "default-cli-project", tags: ["acp-structured-import"],
      ...nativeAgentMetadata,
    },
  }, { registry: nativeRegistry, ignoreUnknownFields: false }) as NativeTrajectory;
  let cursor = 0;
  const messageStepBoundaries = counts.map((count, messageIndex) => {
    const stepStart = cursor;
    cursor += count;
    return { messageIndex, stepStart, stepEnd: cursor };
  });
  return { conversationId, trajectory, bytes: toBinary(nativeTrajectorySchema, trajectory), messageStepBoundaries };
}

/** Encrypt and exclusively create a new UUID .pb; never load, modify or overwrite old histories. */
export async function writeNativeHistory(
  history: BuiltNativeHistory, options: WriteNativeHistoryOptions,
): Promise<WrittenNativeHistory> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(history.conversationId)) {
    throw new NativeHistoryError("invalid_conversation_id", "Native import requires a new UUID v4");
  }
  const decoded = fromBinary(nativeTrajectorySchema, history.bytes) as NativeTrajectory;
  if (decoded.trajectoryId !== history.conversationId || decoded.cascadeId !== history.conversationId) {
    throw new NativeHistoryError("conversation_id_mismatch", "Protobuf IDs must match the new conversation UUID");
  }
  // This is AGY\'s shared file-format key, not a user credential. Reading an exe
  // at a build-dependent offset can silently encrypt history with unrelated bytes.
  const key = Buffer.from(resource.encryptionKeyBase64, "base64");
  let encrypted: Buffer;
  try {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    encrypted = Buffer.concat([nonce, cipher.update(history.bytes), cipher.final(), cipher.getAuthTag()]);
  } finally {
    key.fill(0);
  }
  await mkdir(options.conversationsDirectory, { recursive: true });
  const path = join(options.conversationsDirectory, `${history.conversationId}.pb`);
  const file = await open(path, "wx", 0o600); // EEXIST is intentionally visible to the caller.
  try {
    await file.writeFile(encrypted);
  } catch (error) {
    await file.close();
    await unlink(path); // Only the file we successfully opened exclusively belongs to this import.
    throw error;
  }
  await file.close();
  return { conversationId: history.conversationId, path };
}
