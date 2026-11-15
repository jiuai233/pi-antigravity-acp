import { clampThinkingLevel } from "../models.js";
import { registerSessionResourceCleanup } from "../session-resources.js";
import { combineAbortSignals } from "../utils/abort-signals.js";
import { appendAssistantMessageDiagnostic, createAssistantMessageDiagnostic, formatThrownValue, } from "../utils/diagnostics.js";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { headersToRecord } from "../utils/headers.js";
import { getIdentityHeaders } from "../utils/identity.js";
import { resolveHttpProxyUrlForTarget } from "../utils/node-http-proxy.js";
import { getSystemMessageText } from "../utils/text.js";
import { getDeclaredTools, getInitialSystemMessage, normalizeContext, resolveTranscript, resolveTranscriptTools, } from "../utils/transcript.js";
import { uuidv7 } from "../utils/uuid.js";
import { createGrammarToolInputProperties } from "./constrained-sampling.js";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.js";
import { convertResponsesMessages, convertResponsesTools, getResponsesToolSupport, processResponsesStream, } from "./openai-responses-shared.js";
import { buildBaseOptions } from "./simple-options.js";
// ============================================================================
// Configuration
// ============================================================================
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;
// The Codex backend accepts zstd-compressed request bodies on the SSE responses
// endpoint (the same endpoint the official Codex client compresses against).
const REQUEST_COMPRESSION_ZSTD_LEVEL = 3;
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
const WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE = 1009;
const TURN_STATE_HEADER = "x-codex-turn-state";
// Foreground and summary routing must coexist; session cleanup owns their lifetime.
const codexTurnStates = new Map();
function buildCodexRequestMetadata(identity) {
    if (!identity) return undefined;
    const windowId = identity.windowId ?? `${identity.threadId}:0`;
    const turnMetadata = JSON.stringify({
        ...(identity.installationId ? { installation_id: identity.installationId } : {}),
        session_id: identity.sessionId, thread_id: identity.threadId, turn_id: identity.turnId,
        window_id: windowId, request_kind: identity.requestKind, turn_started_at_unix_ms: identity.startedAt,
    }).replace(/[\u007f-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
    const clientMetadata = { session_id: identity.sessionId, thread_id: identity.threadId,
        turn_id: identity.turnId, "x-codex-window-id": windowId, "x-codex-turn-metadata": turnMetadata };
    const headers = { "session-id": identity.sessionId, "thread-id": identity.threadId,
        "x-client-request-id": identity.threadId, "x-codex-window-id": windowId, "x-codex-turn-metadata": turnMetadata };
    if (identity.installationId) {
        clientMetadata["x-codex-installation-id"] = identity.installationId;
        headers["x-codex-installation-id"] = identity.installationId;
    }
    return { clientMetadata, headers };
}
function getCodexTurnState(identity, accountId, url) {
    if (!identity) return undefined;
    for (const [key, state] of codexTurnStates) {
        if (state.sessionId === identity.sessionId && (state.accountId !== accountId || state.url !== url)) codexTurnStates.delete(key);
    }
    const key = JSON.stringify([identity.sessionId, identity.threadId, identity.requestKind]);
    const previous = codexTurnStates.get(key);
    const state = previous?.turnId === identity.turnId ? previous
        : { sessionId: identity.sessionId, accountId, url, turnId: identity.turnId };
    codexTurnStates.set(key, state);
    return state;
}
function captureCodexTurnState(state, value) {
    // The first valid server value is opaque: replay unchanged and never log it.
    if (state && state.value === undefined && typeof value === "string" && /^[\x21-\x7e]+$/.test(value)) state.value = value;
}
function applyCodexTurnState(headers, state, modelHeaders, callerHeaders) {
    let value = state?.value;
    for (const source of [modelHeaders, callerHeaders]) {
        for (const [key, override] of Object.entries(source ?? {})) {
            if (key.toLowerCase() === TURN_STATE_HEADER) value = override;
        }
    }
    if (value != null) headers.set(TURN_STATE_HEADER, value);
    else headers.delete(TURN_STATE_HEADER);
}
registerSessionResourceCleanup((sessionId) => {
    for (const [key, state] of codexTurnStates) {
        if (sessionId === undefined || state.sessionId === sessionId) codexTurnStates.delete(key);
    }
});

const CODEX_RESPONSE_STATUSES = new Set([
    "completed",
    "incomplete",
    "failed",
    "cancelled",
    "queued",
    "in_progress",
]);
function assertSuccessfulOutput(output) {
    if (output.stopReason === "pending") {
        throw new Error("Codex stream ended without a stop reason");
    }
    if (output.stopReason === "error" || output.stopReason === "aborted") {
        throw new Error(output.errorMessage || "An unknown error occurred");
    }
}
// ============================================================================
// Retry Helpers
// ============================================================================
function isTerminalRateLimitError(errorText) {
    return /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i.test(errorText);
}
function isRetryableError(status, errorText) {
    if (status === 429 && isTerminalRateLimitError(errorText)) {
        return false;
    }
    if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
        return true;
    }
    return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(errorText);
}
function getRetryAfterDelayMs(headers) {
    const retryAfterMs = headers.get("retry-after-ms");
    if (retryAfterMs !== null) {
        const millis = Number(retryAfterMs);
        if (Number.isFinite(millis)) {
            return Math.max(0, millis);
        }
    }
    const retryAfter = headers.get("retry-after");
    if (!retryAfter) {
        return undefined;
    }
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
        return Math.max(0, seconds * 1000);
    }
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) {
        return Math.max(0, date - Date.now());
    }
    return undefined;
}
class RetryDelayExceededError extends Error {
}
function validateRetryDelayMs(delayMs, options) {
    const maxRetryDelayMs = options?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    if (maxRetryDelayMs > 0 && delayMs > maxRetryDelayMs) {
        throw new RetryDelayExceededError(`Server requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(maxRetryDelayMs / 1000)}s)`);
    }
    return delayMs;
}
function normalizeTimeoutMs(value) {
    if (value === undefined)
        return undefined;
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`Invalid timeoutMs: ${String(value)}`);
    }
    return Math.floor(value);
}
function loadNodeZlib() {
    if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) {
        return null;
    }
    return process.getBuiltinModule?.("node:zlib") ?? null;
}
// Returns the zstd-compressed body bytes, or null when compression is
// unavailable (browser/Vite builds). Callers fall back to sending the
// uncompressed JSON when this returns null.
function compressRequestBodyZstd(bodyJson) {
    const zlib = loadNodeZlib();
    if (!zlib || typeof zlib.zstdCompressSync !== "function") {
        return null;
    }
    try {
        const compressed = zlib.zstdCompressSync(bodyJson, {
            params: { [zlib.constants.ZSTD_c_compressionLevel]: REQUEST_COMPRESSION_ZSTD_LEVEL },
        });
        // A copy owns a plain ArrayBuffer, which fetch accepts as a body under every lib.
        return new Uint8Array(compressed);
    }
    catch {
        return null;
    }
}
// ============================================================================
// Main Stream Function
// ============================================================================
export const stream = (model, context, options) => {
    const stream = new AssistantMessageEventStream();
    const normalizedContext = resolveTranscript(context, model.compat?.supportsMidConvoSystemMessages);
    (async () => {
        let output = {
            role: "assistant",
            content: [],
            api: "openai-codex-responses",
            provider: model.provider,
            model: model.id,
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "pending",
            timestamp: Date.now(),
        };
        const observation = startCodexTransportObservation(options?.sessionId ?? options?.requestIdentity?.sessionId);
        let codexRetryTransport = "setup";
        try {
            const apiKey = options?.apiKey;
            if (!apiKey) {
                throw new Error(`No API key for provider: ${model.provider}`);
            }
            const accountId = extractAccountId(apiKey);
            const socketSessionId = options?.sessionId ?? options?.requestIdentity?.sessionId;
            const socketOwner = socketSessionId ? websocketSessionCache.get(socketSessionId) : undefined;
            if (socketOwner && (socketOwner.accountId !== accountId || socketOwner.url !== resolveCodexWebSocketUrl(model.baseUrl))) {
                closeOpenAICodexWebSocketSessions(socketSessionId);
            }
            const turnState = getCodexTurnState(options?.requestIdentity, accountId, resolveCodexUrl(model.baseUrl));
            const grammarToolInputProperties = createGrammarToolInputProperties(getDeclaredTools(normalizedContext.messages), model.compat?.supportsOpenAIGrammarTools ?? false);
            const cacheSessionId = options?.cacheRetention === "none" ? undefined : options?.sessionId;
            const codexSessionId = clampOpenAIPromptCacheKey(cacheSessionId);
            let body = buildRequestBody(model, normalizedContext, options, codexSessionId, grammarToolInputProperties);
            const nextBody = await options?.onPayload?.(body, model);
            if (nextBody !== undefined) {
                body = nextBody;
            }
            // Record the final sent tail, never response.reasoning.effort (which is the head).
            // Direct streams need this too; the agent loop adds its own requested thinkingLevel.
            if (supportsCodexReasoningReplay(model)) {
                const updates = body.input?.filter(item => item.type === "configuration_update");
                const effectiveEffort = updates?.at(-1)?.reasoning?.effort ?? body.reasoning?.effort;
                if (typeof effectiveEffort === "string") output.providerThinkingLevel = effectiveEffort;
            }
            const requestMetadata = buildCodexRequestMetadata(options?.requestIdentity);
            if (requestMetadata) body.client_metadata = requestMetadata.clientMetadata;
            const websocketRequestId = options?.requestIdentity?.threadId || codexSessionId || uuidv7();
            // Codex expects an originator on every request; it is not attribution.
            const identityHeaders = { originator: "pi", ...getIdentityHeaders(model, options?.identity) };
            const sseHeaders = buildSSEHeaders(identityHeaders, model.headers, options?.headers, accountId, apiKey, codexSessionId, options?.requestIdentity);
            const websocketHeaders = buildWebSocketHeaders(identityHeaders, model.headers, options?.headers, accountId, apiKey, websocketRequestId, options?.requestIdentity);
            const bodyJson = JSON.stringify(body);
            const httpTimeoutMs = normalizeTimeoutMs(options?.timeoutMs);
            const websocketConnectTimeoutMs = normalizeTimeoutMs(options?.websocketConnectTimeoutMs);
            const transport = options?.transport || "auto";
            let startEmitted = false;
            const requestBytes = new TextEncoder().encode(bodyJson).byteLength;
            const websocketAttempt = transport === "sse" ? { allowed: false, recoveryProbe: false }
                : acquireWebSocketAttempt(cacheSessionId, requestBytes);
            const websocketDisabledForSession = transport !== "sse" && !websocketAttempt.allowed;
            if (websocketDisabledForSession) {
                recordWebSocketSseFallback(cacheSessionId);
                observation("fallback", "fallback", null, websocketFallbackStates.get(cacheSessionId)?.reason === "message_too_big" ? "ws_message_too_big" : "ws_unavailable", websocketDebugStats.get(cacheSessionId)?.nextProbeAt);
            }
            if (transport !== "sse" && !websocketDisabledForSession) {
                codexRetryTransport = "websocket";
                let websocketStarted = false, codexWebSocketRetries = 0, codexConnectionRetries = 0, codexCapacityRetries = 0;
                for (;;) {
                    if (options?.signal?.aborted) {
                        releaseWebSocketRecoveryProbe(cacheSessionId, websocketAttempt.recoveryProbe);
                        throw new Error("Request was aborted");
                    }
                    websocketStarted = false;
                    try {
                        await processWebSocketStream(resolveCodexWebSocketUrl(model.baseUrl), body, websocketHeaders, output, stream, model, () => {
                            websocketStarted = true;
                            if (!startEmitted) {
                                startEmitted = true;
                                stream.push({ type: "start", partial: output });
                            }
                        }, httpTimeoutMs, websocketConnectTimeoutMs, cacheSessionId, accountId, grammarToolInputProperties, turnState, options, observation);

                        if (options?.signal?.aborted) throw new Error("Request was aborted");
                        assertSuccessfulOutput(output);
                        recordWebSocketSuccess(cacheSessionId, websocketAttempt.recoveryProbe);
                        observation("end", "idle", undefined, "completed");
                        stream.push({ type: "done", reason: output.stopReason, message: output });
                        stream.end();
                        return;
                    } catch (error) {
                        if (options?.signal?.aborted) {
                            releaseWebSocketRecoveryProbe(cacheSessionId, websocketAttempt.recoveryProbe);
                            throw error;
                        }
                        if (!isCodexRetryableStreamError(error)) {
                            recordWebSocketSuccess(cacheSessionId, websocketAttempt.recoveryProbe);
                            throw error;
                        }
                        const oversized = error instanceof WebSocketCloseError && error.code === 1009;
                        const connectionFailure = error instanceof CodexRetryConnectionError;
                        const capacityFailure = isCodexCapacityError(error);
                        if (capacityFailure || (!websocketAttempt.recoveryProbe && !oversized && (connectionFailure || codexWebSocketRetries < CODEX_TRANSPORT_MAX_RETRIES))) {
                            const retry = capacityFailure ? codexCapacityRetries++ : connectionFailure ? codexConnectionRetries++ : codexWebSocketRetries++;
                            if (!connectionFailure) codexConnectionRetries = 0;
                            if (!capacityFailure) codexCapacityRetries = 0;
                            await waitForCodexTransportRetry(output, error, "websocket", retry, connectionFailure, options, observation, capacityFailure);
                            output = resetCodexRetryOutput(output);
                            if (startEmitted) stream.push({ type: "start", reset: true, partial: output });
                            continue;
                        }
                        appendAssistantMessageDiagnostic(output, createAssistantMessageDiagnostic("provider_transport_failure", error, {
                            configuredTransport: transport, fallbackTransport: "sse", eventsEmitted: websocketStarted,
                            phase: websocketStarted ? "after_message_stream_start" : "before_message_stream_start", requestBytes,
                        }));
                        recordWebSocketFailure(cacheSessionId, error, requestBytes);
                        output = resetCodexRetryOutput(output);
                        if (startEmitted) stream.push({ type: "start", reset: true, partial: output });
                        recordWebSocketSseFallback(cacheSessionId);
                        observation("fallback", "fallback", null, oversized ? "ws_message_too_big" : "ws_unavailable", websocketDebugStats.get(cacheSessionId)?.nextProbeAt);
                        break;
                    }
                }
            }
            // Compress the request body once for the SSE path. The Codex backend
            // decodes Content-Encoding: zstd; the WebSocket transport above sends the
            // uncompressed JSON frame, matching the official Codex client.
            const compressedBody = compressRequestBodyZstd(bodyJson);
            if (compressedBody) {
                sseHeaders.set("content-encoding", "zstd");
            }
            const sseBody = compressedBody ?? bodyJson;
            codexRetryTransport = "sse";
            let response, codexSseRetries = 0, codexConnectionRetries = 0, codexCapacityRetries = 0;
            for (;;) {
                if (options?.signal?.aborted) throw new Error("Request was aborted");
                response = undefined;
                let codexReadingStream = false;
                try {
                    applyCodexTurnState(sseHeaders, turnState, model.headers, options?.headers);
                    const headerTimeoutSignal = httpTimeoutMs !== undefined && httpTimeoutMs > 0 ? AbortSignal.timeout(httpTimeoutMs) : undefined;
                    const combinedSignal = combineAbortSignals([options?.signal, headerTimeoutSignal]);
                    try {
                        observation("sse_fetch", "connecting", null);
                        response = await (options?.fetch ?? globalThis.fetch)(resolveCodexUrl(model.baseUrl), {
                            method: "POST",
                            headers: sseHeaders,
                            body: sseBody,
                            signal: combinedSignal.signal,
                        });
                    }
                    catch (error) {
                        if (headerTimeoutSignal?.aborted && !options?.signal?.aborted) {
                            throw new Error(`Codex SSE response headers timed out after ${httpTimeoutMs}ms`);
                        }
                        throw error;
                    }
                    finally {
                        combinedSignal.cleanup();
                    }
                    observation("sse_received", "connecting", null);
                    captureCodexTurnState(turnState, response.headers.get(TURN_STATE_HEADER));
                    try { await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model); }
                    catch (error) { throw new ProviderStreamEventCallbackError(error); }

                    if (!response.ok) {
                        const errorText = await response.text();
                        const info = await parseErrorResponse(new Response(errorText, { status: response.status, statusText: response.statusText }));
                        const terminal = response.status === 401 || response.status === 403 || CODEX_NON_RETRYABLE_ERROR_PATTERN.test(errorText);
                        const capacityFailure = !terminal && isCodexCapacityMessage(errorText);
                        throw new CodexRetryHttpError(info.friendlyMessage || info.message,
                            !terminal && (capacityFailure || isRetryableError(response.status, errorText)), getRetryAfterDelayMs(response.headers), capacityFailure);
                    }
                    codexReadingStream = true;
                    if (!response.body) throw new CodexProtocolError("No response body");
                    observation("sse_response", "connecting", "sse");
                    if (!startEmitted) {
                        startEmitted = true;
                        stream.push({ type: "start", partial: output });
                    }
                    await processStream(response, output, stream, model, grammarToolInputProperties, turnState, options, observation);
                    if (options?.signal?.aborted) throw new Error("Request was aborted");
                    assertSuccessfulOutput(output);
                    observation("end", "idle", undefined, "completed");
                    stream.push({ type: "done", reason: output.stopReason, message: output });
                    stream.end();
                    return;
                } catch (error) {
                    if (options?.signal?.aborted || !isCodexRetryableStreamError(error)) throw error;
                    const networkFailure = (response === undefined || codexReadingStream) && isCodexNetworkFailure(error);
                    const capacityFailure = isCodexCapacityError(error);
                    if (!networkFailure && !capacityFailure && codexSseRetries >= CODEX_TRANSPORT_MAX_RETRIES) throw error;
                    const retry = capacityFailure ? codexCapacityRetries++ : networkFailure ? codexConnectionRetries++ : codexSseRetries++;
                    if (!networkFailure) codexConnectionRetries = 0;
                    if (!capacityFailure) codexCapacityRetries = 0;
                    await waitForCodexTransportRetry(output, error, "sse", retry, networkFailure, options, observation, capacityFailure);
                    output = resetCodexRetryOutput(output);
                    if (startEmitted) stream.push({ type: "start", reset: true, partial: output });
                }
            }
        }
        catch (error) {
            if (codexRetryTransport !== "setup") appendAssistantMessageDiagnostic(output,
                createAssistantMessageDiagnostic("provider_retry_policy_finished", error, { transport: codexRetryTransport }));
            observation("end", options?.signal?.aborted ? "idle" : "error", undefined, options?.signal?.aborted ? "cancelled" : "request_failed");
            output.stopReason = options?.signal?.aborted ? "aborted" : "error";
            output.errorMessage = formatProviderError(normalizeProviderError(error));
            stream.push({ type: "error", reason: output.stopReason, error: output });
            stream.end();
        }
    })();
    return stream;
};
export const streamSimple = (model, context, options) => {
    const apiKey = options?.apiKey;
    if (!apiKey) {
        throw new Error(`No API key for provider: ${model.provider}`);
    }
    const base = {
        ...buildBaseOptions(model, context, options, apiKey),
        toolChoice: options?.toolChoice,
    };
    const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
    const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
    return stream(model, context, {
        ...base,
        reasoningEffort,
    });
};
// ============================================================================
// Request Building
// ============================================================================
function buildRequestBody(model, context, options, cacheSessionId, grammarToolInputProperties = createGrammarToolInputProperties(getDeclaredTools(context.messages), model.compat?.supportsOpenAIGrammarTools ?? false)) {
    const supportsStrictMode = model.compat?.supportsStrictMode ?? true;
    const supportsOpenAIGrammarTools = model.compat?.supportsOpenAIGrammarTools ?? false;
    const supportsAdditionalTools = model.compat?.supportsAdditionalTools ?? false;
    const supportsToolSearch = model.compat?.supportsToolSearch ?? false;
    const transcriptTools = resolveTranscriptTools(context.messages, getResponsesToolSupport({
        supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
        supportsAdditionalTools,
        supportsToolSearch,
    }));
    const desiredEffort = resolveCodexReasoningEffort(model, options?.reasoningEffort);
    const reasoningReplay = createCodexReasoningReplay(model, context.messages, desiredEffort);
    const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
        reasoningReplay,
        includeSystemPrompt: false,
        grammarToolInputProperties,
        supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
        supportsAdditionalTools,
        supportsToolSearch,
        toolOptions: { strict: null, supportsStrictMode, supportsOpenAIGrammarTools },
    });
    const initialSystemMessage = getInitialSystemMessage(context.messages);
    const instructions = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : "";
    const body = {
        model: model.id,
        store: false,
        stream: true,
        instructions: instructions || "You are a helpful assistant.",
        input: messages,
        text: { verbosity: options?.textVerbosity || "low" },
        include: ["reasoning.encrypted_content"],
        prompt_cache_key: cacheSessionId,
        tool_choice: options?.toolChoice ?? "auto",
        parallel_tool_calls: true,
    };
    if (options?.temperature !== undefined) {
        body.temperature = options.temperature;
    }
    if (options?.serviceTier !== undefined) {
        body.service_tier = options.serviceTier;
    }
    if (transcriptTools.requestTools.length > 0) {
        body.tools = convertResponsesTools(transcriptTools.requestTools, {
            strict: null,
            supportsStrictMode,
            supportsOpenAIGrammarTools,
        });
    }
    const effort = reasoningReplay?.initialEffort ?? desiredEffort;
    if (typeof effort === "string") {
        body.reasoning = {
            effort,
            ...(reasoningReplay || options?.reasoningEffort !== undefined
                ? { summary: options?.reasoningSummary ?? "auto" } : {}),
        };
    }
    return body;
}
function getServiceTierCostMultiplier(model, serviceTier) {
    switch (serviceTier) {
        case "flex":
            return 0.5;
        case "priority":
            return model.id === "gpt-5.5" ? 2.5 : 2;
        default:
            return 1;
    }
}
function applyServiceTierPricing(usage, serviceTier, model) {
    const multiplier = getServiceTierCostMultiplier(model, serviceTier);
    if (multiplier === 1)
        return;
    usage.cost.input *= multiplier;
    usage.cost.output *= multiplier;
    usage.cost.cacheRead *= multiplier;
    usage.cost.cacheWrite *= multiplier;
    usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
function resolveCodexServiceTier(responseServiceTier, requestServiceTier) {
    if (responseServiceTier === "default" && (requestServiceTier === "flex" || requestServiceTier === "priority")) {
        return requestServiceTier;
    }
    return responseServiceTier ?? requestServiceTier;
}
function resolveCodexUrl(baseUrl) {
    const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
    const normalized = raw.replace(/\/+$/, "");
    if (normalized.endsWith("/codex/responses"))
        return normalized;
    if (normalized.endsWith("/codex"))
        return `${normalized}/responses`;
    return `${normalized}/codex/responses`;
}
function resolveCodexWebSocketUrl(baseUrl) {
    const url = new URL(resolveCodexUrl(baseUrl));
    if (url.protocol === "https:")
        url.protocol = "wss:";
    if (url.protocol === "http:")
        url.protocol = "ws:";
    return url.toString();
}
// ============================================================================
// Response Processing
// ============================================================================
async function processStream(response, output, stream, model, grammarToolInputProperties, turnState, options, observation) {
    const observedEvents = startWebSocketOutputOnFirstEvent(parseSSE(response, options?.signal), () => observation("sse_event", "streaming", "sse"));
    await processResponsesStream(mapCodexEvents(observedEvents, output, model, options?.onProviderStreamEvent, turnState), output, stream, model, {
        serviceTier: options?.serviceTier,
        grammarToolInputProperties,
        resolveServiceTier: resolveCodexServiceTier,
        applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
    });
}
class CodexApiError extends Error {
    code;
    payload;
    constructor(message, options) {
        super(message);
        this.name = "CodexApiError";
        this.code = options?.code;
        this.payload = options?.payload;
        this.cause = options?.cause;
    }
}
class CodexProtocolError extends Error {
    payload;
    constructor(message, options) {
        super(message);
        this.name = "CodexProtocolError";
        this.payload = options?.payload;
        this.cause = options?.cause;
    }
}
class ProviderStreamEventCallbackError extends Error {
    constructor(cause) {
        super(formatThrownValue(cause));
        this.name = "ProviderStreamEventCallbackError";
        this.cause = cause;
    }
}
class CodexSessionChangedError extends Error {}
function isCodexNonTransportError(error) {
    return (error instanceof CodexApiError ||
        error instanceof CodexProtocolError ||
        error instanceof ProviderStreamEventCallbackError || error instanceof CodexSessionChangedError);
}
function extractCodexEventError(event) {
    const nested = event.error && typeof event.error === "object" ? event.error : undefined;
    return {
        code: typeof event.code === "string" ? event.code : typeof nested?.code === "string" ? nested.code : undefined,
        message: typeof event.message === "string"
            ? event.message
            : typeof nested?.message === "string"
                ? nested.message
                : undefined,
    };
}
async function* mapCodexEvents(events, output, model, onProviderStreamEvent, turnState) {
    for await (const event of events) {
        try {
            await onProviderStreamEvent?.(event, model);
        }
        catch (error) {
            // Keep callback failures out of Codex's WebSocket retry and SSE fallback path.
            throw new ProviderStreamEventCallbackError(error);
        }
        const type = typeof event.type === "string" ? event.type : undefined;
        if (!type)
            continue;
        if (type === "codex.response.metadata" || type === "response.metadata") {
            if (event.headers && typeof event.headers === "object") captureCodexTurnState(turnState, event.headers[TURN_STATE_HEADER]);
            continue;
        }
        if (type === "error") {
            const { code, message } = extractCodexEventError(event);
            throw new CodexApiError(`Codex error: ${message || code || JSON.stringify(event)}`, {
                code,
                payload: event,
            });
        }
        if (type === "response.failed") {
            const response = event.response;
            const code = response?.error?.code;
            const message = response?.error?.message;
            throw new CodexApiError(message || "Codex response failed", { code, payload: event });
        }
        if (type === "response.done" || type === "response.completed" || type === "response.incomplete") {
            const response = event.response;
            if (typeof response?.end_turn === "boolean") {
                output.endTurn = response.end_turn;
            }
            const normalizedResponse = response
                ? { ...response, status: normalizeCodexStatus(response.status) }
                : response;
            yield { ...event, type: "response.completed", response: normalizedResponse };
            return;
        }
        yield event;
    }
}
function normalizeCodexStatus(status) {
    if (typeof status !== "string")
        return undefined;
    return CODEX_RESPONSE_STATUSES.has(status) ? status : undefined;
}
// ============================================================================
// SSE Parsing
// ============================================================================
async function* parseSSE(response, signal) {
    if (!response.body)
        return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const onAbort = () => {
        void reader.cancel().catch(() => { });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
        while (true) {
            if (signal?.aborted) {
                throw new Error("Request was aborted");
            }
            const { done, value } = await reader.read();
            if (signal?.aborted) {
                throw new Error("Request was aborted");
            }
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            // Treat EOF as terminating the residual SSE frame.
            if (done && buffer.trim())
                buffer += "\n\n";
            let idx = buffer.indexOf("\n\n");
            while (idx !== -1) {
                const chunk = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);
                const dataLines = chunk
                    .split("\n")
                    .filter((l) => l.startsWith("data:"))
                    .map((l) => l.slice(5).trim());
                if (dataLines.length > 0) {
                    const data = dataLines.join("\n").trim();
                    if (data && data !== "[DONE]") {
                        try {
                            yield JSON.parse(data);
                        }
                        catch (cause) {
                            throw new CodexProtocolError(`Invalid Codex SSE JSON: ${formatThrownValue(cause)}`, {
                                cause,
                                payload: data,
                            });
                        }
                    }
                }
                idx = buffer.indexOf("\n\n");
            }
            if (done)
                break;
        }
    }
    finally {
        signal?.removeEventListener("abort", onAbort);
        try {
            await reader.cancel();
        }
        catch { }
        try {
            reader.releaseLock();
        }
        catch { }
    }
}
// ============================================================================
// WebSocket Parsing
// ============================================================================
const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";
const SESSION_WEBSOCKET_CACHE_TTL_MS = 15 * 60 * 1000;
const SESSION_WEBSOCKET_MAX_AGE_MS = 55 * 60 * 1000;
const websocketSessionCache = new Map();
const websocketRecoveryState = globalThis[Symbol.for("pi.codex.transport.recovery.1.5.0")] ??= {
    websocketDebugStats: new Map(), websocketFallbackStates: new Map(),
};
const { websocketDebugStats, websocketFallbackStates } = websocketRecoveryState;
registerSessionResourceCleanup(sessionId => {
    if (sessionId === undefined) { websocketDebugStats.clear(); websocketFallbackStates.clear(); }
    else { websocketDebugStats.delete(sessionId); websocketFallbackStates.delete(sessionId); }
});
function getOrCreateWebSocketDebugStats(sessionId) {
    let stats = websocketDebugStats.get(sessionId);
    if (!stats) {
        stats = {
            requests: 0,
            connectionsCreated: 0,
            connectionsReused: 0,
            cachedContextRequests: 0,
            storeTrueRequests: 0,
            fullContextRequests: 0,
            deltaRequests: 0,
            lastInputItems: 0,
            websocketFailures: 0,
            sseFallbacks: 0,
            websocketRecoveryProbes: 0, websocketRecoveries: 0, oversizeFallbacks: 0,
        };
        websocketDebugStats.set(sessionId, stats);
    }
    return stats;
}
export function getOpenAICodexWebSocketDebugStats(sessionId) {
    const stats = websocketDebugStats.get(sessionId);
    return stats ? { ...stats } : undefined;
}
export function resetOpenAICodexWebSocketDebugStats(sessionId) {
    if (sessionId) {
        websocketDebugStats.delete(sessionId);
        websocketFallbackStates.delete(sessionId);
        return;
    }
    websocketDebugStats.clear();
    websocketFallbackStates.clear();
}
export function closeOpenAICodexWebSocketSessions(sessionId) {
    const closeEntry = entry => {
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        closeWebSocketSilently(entry.socket, 1000, "debug_close");
    };
    if (sessionId) {
        const entry = websocketSessionCache.get(sessionId)?.connection;
        if (entry) closeEntry(entry);
        websocketSessionCache.delete(sessionId);
        return;
    }
    for (const session of websocketSessionCache.values()) if (session.connection) closeEntry(session.connection);
    websocketSessionCache.clear();
}
registerSessionResourceCleanup(closeOpenAICodexWebSocketSessions);
function acquireWebSocketAttempt(sessionId, requestBytes) {
    if (!sessionId) return { allowed: true, recoveryProbe: false };
    const state = websocketFallbackStates.get(sessionId);
    if (!state) return { allowed: true, recoveryProbe: false };
    if (state.probeInFlight) return { allowed: false, recoveryProbe: false };
    if (state.reason === "message_too_big" && requestBytes > Math.floor(state.failedRequestBytes * 0.8))
        return { allowed: false, recoveryProbe: false };
    if (state.reason === "transport" && Date.now() < state.retryAt) return { allowed: false, recoveryProbe: false };
    state.probeInFlight = true;
    getOrCreateWebSocketDebugStats(sessionId).websocketRecoveryProbes++;
    return { allowed: true, recoveryProbe: true };
}
function isWebSocketSseFallbackActive(sessionId) {
    return sessionId ? websocketFallbackStates.has(sessionId) : false;
}
function recordWebSocketSseFallback(sessionId) {
    if (!sessionId) return;
    const stats = getOrCreateWebSocketDebugStats(sessionId);
    stats.sseFallbacks++;
    stats.websocketFallbackActive = isWebSocketSseFallbackActive(sessionId);
}
function recordWebSocketFailure(sessionId, error, requestBytes) {
    if (!sessionId) return;
    const reason = error instanceof WebSocketCloseError && error.code === 1009 ? "message_too_big" : "transport";
    const previous = websocketFallbackStates.get(sessionId);
    const consecutiveFailures = previous?.reason === reason ? previous.consecutiveFailures + 1 : 1;
    const cooldownMs = Math.min(30_000 * 2 ** (consecutiveFailures - 1), 300_000);
    const state = { reason, consecutiveFailures, retryAt: reason === "transport" ? Date.now() + cooldownMs : 0,
        probeInFlight: false, failedRequestBytes: reason === "message_too_big" ? requestBytes : undefined };
    websocketFallbackStates.set(sessionId, state);
    const stats = getOrCreateWebSocketDebugStats(sessionId);
    stats.websocketFailures++;
    if (reason === "message_too_big") stats.oversizeFallbacks++;
    stats.lastWebSocketError = formatThrownValue(error);
    stats.websocketFallbackActive = true;
    stats.fallbackReason = reason;
    stats.consecutiveFailures = consecutiveFailures;
    stats.nextProbeAt = reason === "transport" ? state.retryAt : undefined;
    stats.lastFailedRequestBytes = state.failedRequestBytes;
}
function releaseWebSocketRecoveryProbe(sessionId, recoveryProbe) {
    if (!sessionId || !recoveryProbe) return;
    const state = websocketFallbackStates.get(sessionId);
    if (state) state.probeInFlight = false;
}
function recordWebSocketSuccess(sessionId, recoveryProbe) {
    if (!sessionId || !websocketFallbackStates.has(sessionId)) return;
    websocketFallbackStates.delete(sessionId);
    const stats = getOrCreateWebSocketDebugStats(sessionId);
    if (recoveryProbe) stats.websocketRecoveries++;
    stats.websocketFallbackActive = false;
    stats.fallbackReason = undefined;
    stats.consecutiveFailures = 0;
    stats.nextProbeAt = undefined;
    stats.lastFailedRequestBytes = undefined;
}

let _cachedWebsocket = null;
async function getWebSocketConstructor(env) {
    if (!env && _cachedWebsocket)
        return _cachedWebsocket;
    // bun doesn't respect http proxy envs, ref: https://github.com/oven-sh/bun/issues/15489
    // TODO: remove this when bun supports proxy envs in websocket.
    if (typeof process !== "undefined" && process.versions?.bun) {
        const WebSocketWithProxy = class extends WebSocket {
            constructor(url, options) {
                let _opts = {};
                if (Array.isArray(options) || typeof options === "string") {
                    _opts = { protocols: options };
                }
                else {
                    _opts = { ...options };
                }
                const proxyUrl = resolveHttpProxyUrlForTarget(url.toString().replace(/^wss:/, "https:").replace(/^ws:/, "http:"), env);
                super(url, { ..._opts, ...(proxyUrl ? { proxy: proxyUrl.toString() } : {}) });
            }
        };
        if (!env) {
            _cachedWebsocket = WebSocketWithProxy;
        }
        return WebSocketWithProxy;
    }
    const ctor = globalThis.WebSocket;
    if (typeof ctor !== "function")
        return null;
    return ctor;
}
class WebSocketCloseError extends Error {
    code;
    reason;
    wasClean;
    constructor(message, options) {
        super(message);
        this.name = "WebSocketCloseError";
        this.code = options?.code;
        this.reason = options?.reason;
        this.wasClean = options?.wasClean;
    }
}
function getWebSocketReadyState(socket) {
    const readyState = socket.readyState;
    return typeof readyState === "number" ? readyState : undefined;
}
function isWebSocketReusable(socket) {
    const readyState = getWebSocketReadyState(socket);
    // If readyState is unavailable, assume the runtime keeps it open/reusable.
    return readyState === undefined || readyState === 1;
}
function isWebSocketSessionExpired(entry) {
    return Date.now() - entry.createdAt >= SESSION_WEBSOCKET_MAX_AGE_MS;
}
function closeWebSocketSilently(socket, code = 1000, reason = "done") {
    try {
        socket.close(code, reason);
    }
    catch { }
}
function scheduleSessionWebSocketExpiry(session, entry) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
        if (entry.busy) return;
        closeWebSocketSilently(entry.socket, 1000, "idle_timeout");
        if (session.connection === entry) session.connection = undefined;
    }, SESSION_WEBSOCKET_CACHE_TTL_MS);
}
async function connectWebSocket(url, headers, signal, connectTimeoutMs = DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS, env) {
    const WebSocketCtor = await getWebSocketConstructor(env);
    if (!WebSocketCtor) {
        throw new Error("WebSocket transport is not available in this runtime");
    }
    const wsHeaders = headersToRecord(headers);
    delete wsHeaders["OpenAI-Beta"];
    return new Promise((resolve, reject) => {
        let settled = false;
        let timeout;
        let socket;
        try {
            socket = new WebSocketCtor(url, { headers: wsHeaders });
        }
        catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
        }
        const cleanup = () => {
            if (timeout) {
                clearTimeout(timeout);
                timeout = undefined;
            }
            socket.removeEventListener("open", onOpen);
            socket.removeEventListener("error", onError);
            socket.removeEventListener("close", onClose);
            signal?.removeEventListener("abort", onAbort);
        };
        const fail = (error, closeReason) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            if (closeReason) {
                closeWebSocketSilently(socket, 1000, closeReason);
            }
            reject(error);
        };
        const onOpen = () => {
            if (settled)
                return;
            settled = true;
            cleanup();
            resolve(socket);
        };
        const onError = (event) => {
            fail(extractWebSocketError(event));
        };
        const onClose = (event) => {
            fail(extractWebSocketCloseError(event));
        };
        const onAbort = () => {
            fail(new Error("Request was aborted"), "aborted");
        };
        socket.addEventListener("open", onOpen);
        socket.addEventListener("error", onError);
        socket.addEventListener("close", onClose);
        signal?.addEventListener("abort", onAbort);
        if (connectTimeoutMs > 0) {
            timeout = setTimeout(() => {
                fail(new Error(`WebSocket connect timeout after ${connectTimeoutMs}ms`), "connect_timeout");
            }, connectTimeoutMs);
        }
        if (signal?.aborted) {
            onAbort();
        }
    });
}
async function acquireWebSocket(url, headers, sessionId, accountId, signal, connectTimeoutMs, env) {
    if (!sessionId) {
        const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
        return { socket, reused: false, release: () => closeWebSocketSilently(socket) };
    }
    let session = websocketSessionCache.get(sessionId);
    if (!session || session.accountId !== accountId || session.url !== url) {
        closeOpenAICodexWebSocketSessions(sessionId);
        session = { accountId, url };
        websocketSessionCache.set(sessionId, session);
    }
    const cached = session.connection;
    let entry;
    if (cached) {
        if (cached.idleTimer) { clearTimeout(cached.idleTimer); cached.idleTimer = undefined; }
        if (!cached.busy && isWebSocketSessionExpired(cached)) {
            closeWebSocketSilently(cached.socket, 1000, "connection_age_limit");
            session.connection = undefined;
        } else if (!cached.busy && isWebSocketReusable(cached.socket)) entry = cached;
        else if (!cached.busy && !isWebSocketReusable(cached.socket)) {
            closeWebSocketSilently(cached.socket);
            session.connection = undefined;
        }
    }
    const reused = entry !== undefined;
    if (!entry) {
        let socket;
        try { socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env); }
        catch (error) {
            if (websocketSessionCache.get(sessionId) !== session) throw new CodexSessionChangedError("WebSocket session changed during connection");
            throw error;
        }
        if (websocketSessionCache.get(sessionId) !== session) {
            closeWebSocketSilently(socket);
            throw new CodexSessionChangedError("WebSocket session changed during connection");
        }
        if (session.connection) return { socket, reused: false, release: () => closeWebSocketSilently(socket) };
        entry = { socket, busy: true, createdAt: Date.now() };
        session.connection = entry;
    }
    const connection = entry;
    connection.busy = true;
    return { socket: connection.socket, entry: connection, reused,
        release: ({ keep } = {}) => {
            if (!keep || websocketSessionCache.get(sessionId) !== session || !isWebSocketReusable(connection.socket)) {
                closeWebSocketSilently(connection.socket);
                if (connection.idleTimer) clearTimeout(connection.idleTimer);
                if (session.connection === connection) session.connection = undefined;
                return;
            }
            connection.busy = false;
            scheduleSessionWebSocketExpiry(session, connection);
        } };
}
function extractWebSocketError(event) {
    // ws ErrorEvent.message duplicates error.message; keep the original code/cause
    // so only actual TCP/DNS establishment failures bypass the finite WS budget.
    if (event instanceof Error) return event;
    if (event?.error instanceof Error) return event.error;
    return new Error(typeof event?.message === "string" ? event.message : "WebSocket error", { cause: event?.error });
}
function extractWebSocketCloseError(event) {
    if (event && typeof event === "object") {
        const code = "code" in event ? event.code : undefined;
        const reason = "reason" in event ? event.reason : undefined;
        const wasClean = "wasClean" in event ? event.wasClean : undefined;
        const codeText = typeof code === "number" ? ` ${code}` : "";
        let reasonText = typeof reason === "string" && reason.length > 0 ? ` ${reason}` : "";
        if (!reasonText && code === WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE) {
            reasonText = " message too big";
        }
        return new WebSocketCloseError(`WebSocket closed${codeText}${reasonText}`.trim(), {
            code: typeof code === "number" ? code : undefined,
            reason: typeof reason === "string" && reason.length > 0 ? reason : undefined,
            wasClean: typeof wasClean === "boolean" ? wasClean : undefined,
        });
    }
    return new Error("WebSocket closed");
}
async function decodeWebSocketData(data) {
    if (typeof data === "string")
        return data;
    if (data instanceof ArrayBuffer) {
        return new TextDecoder().decode(new Uint8Array(data));
    }
    if (ArrayBuffer.isView(data)) {
        const view = data;
        return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    }
    if (data && typeof data === "object" && "arrayBuffer" in data) {
        const blobLike = data;
        const arrayBuffer = await blobLike.arrayBuffer();
        return new TextDecoder().decode(new Uint8Array(arrayBuffer));
    }
    return null;
}
async function* parseWebSocket(socket, signal, idleTimeoutMs) {
    const queue = [];
    let pending = null;
    let done = false;
    let failed = null;
    let sawCompletion = false;
    const wake = () => {
        if (!pending)
            return;
        const resolve = pending;
        pending = null;
        resolve();
    };
    const onMessage = (event) => {
        void (async () => {
            let text = null;
            try {
                if (!event || typeof event !== "object" || !("data" in event))
                    return;
                text = await decodeWebSocketData(event.data);
                if (!text)
                    return;
                const parsed = JSON.parse(text);
                const type = typeof parsed.type === "string" ? parsed.type : "";
                if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
                    sawCompletion = true;
                    done = true;
                }
                queue.push(parsed);
                wake();
            }
            catch (cause) {
                failed = new CodexProtocolError(`Invalid Codex WebSocket JSON: ${formatThrownValue(cause)}`, {
                    cause,
                    payload: text,
                });
                done = true;
                wake();
            }
        })();
    };
    const onError = (event) => {
        failed = extractWebSocketError(event);
        done = true;
        wake();
    };
    const onClose = (event) => {
        if (sawCompletion) {
            done = true;
            wake();
            return;
        }
        if (!failed) {
            failed = extractWebSocketCloseError(event);
        }
        done = true;
        wake();
    };
    const onAbort = () => {
        failed = new Error("Request was aborted");
        done = true;
        wake();
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    signal?.addEventListener("abort", onAbort);
    try {
        while (true) {
            if (signal?.aborted) {
                throw new Error("Request was aborted");
            }
            if (queue.length > 0) {
                yield queue.shift();
                continue;
            }
            if (done)
                break;
            let timeout;
            await new Promise((resolve, reject) => {
                pending = resolve;
                if (idleTimeoutMs !== undefined && idleTimeoutMs > 0) {
                    timeout = setTimeout(() => {
                        const error = new Error(`WebSocket idle timeout after ${idleTimeoutMs}ms`);
                        failed = error;
                        done = true;
                        pending = null;
                        closeWebSocketSilently(socket, 1000, "idle_timeout");
                        reject(error);
                    }, idleTimeoutMs);
                }
            }).finally(() => {
                if (timeout) {
                    clearTimeout(timeout);
                }
            });
        }
        if (failed) {
            throw failed;
        }
        if (!sawCompletion) {
            throw new Error("WebSocket stream closed before response.completed");
        }
    }
    finally {
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
        signal?.removeEventListener("abort", onAbort);
    }
}
function requestBodyWithoutInput(body) {
    // Identity describes this request, not the cached prompt prefix.
    const { input: _input, previous_response_id: _previousResponseId, client_metadata: _clientMetadata, ...rest } = body;
    return rest;
}
function responseInputsEqual(a, b) {
    return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}
function requestBodiesMatchExceptInput(a, b) {
    return JSON.stringify(requestBodyWithoutInput(a)) === JSON.stringify(requestBodyWithoutInput(b));
}
function getCachedWebSocketInputDelta(body, continuation) {
    if (!requestBodiesMatchExceptInput(body, continuation.lastRequestBody)) {
        return undefined;
    }
    const currentInput = body.input ?? [];
    const baseline = [...(continuation.lastRequestBody.input ?? []), ...continuation.lastResponseItems];
    if (currentInput.length < baseline.length) {
        return undefined;
    }
    const prefix = currentInput.slice(0, baseline.length);
    if (!responseInputsEqual(prefix, baseline)) {
        return undefined;
    }
    return currentInput.slice(baseline.length);
}
function buildCachedWebSocketRequestBody(entry, body) {
    const continuation = entry.continuation;
    if (!continuation) {
        return body;
    }
    const delta = getCachedWebSocketInputDelta(body, continuation);
    if (!delta || !continuation.lastResponseId) {
        entry.continuation = undefined;
        return body;
    }
    return {
        ...body,
        previous_response_id: continuation.lastResponseId,
        input: delta,
    };
}
async function* startWebSocketOutputOnFirstEvent(events, onStart) {
    let started = false;
    for await (const event of events) {
        if (!started) {
            started = true;
            onStart();
        }
        yield event;
    }
}
async function processWebSocketStream(url, body, headers, output, stream, model, onStart, idleTimeoutMs, websocketConnectTimeoutMs, cacheSessionId, accountId, grammarToolInputProperties, turnState, options, observation) {
    observation("ws_connecting", "connecting", null);
    let acquired;
    try { acquired = await acquireWebSocket(url, headers, cacheSessionId, accountId, options?.signal, websocketConnectTimeoutMs, options?.env); }
    catch (error) {
        if (isCodexConnectionFailure(error) && !isCodexNonTransportError(error)) throw new CodexRetryConnectionError(error);
        throw error;
    }
    const { socket, entry, reused, release } = acquired;
    observation("ws_open", "connecting", "ws");
    let keepConnection = true;
    const useCachedContext = options?.transport === "websocket-cached" || options?.transport === "auto";
    // ChatGPT Codex Responses rejects `store: true` ("Store must be set to false").
    // WebSocket continuation still works via connection-scoped previous_response_id state.
    const fullBody = body;
    const requestBody = useCachedContext && entry ? buildCachedWebSocketRequestBody(entry, fullBody) : fullBody;
    const stats = cacheSessionId ? getOrCreateWebSocketDebugStats(cacheSessionId) : undefined;
    if (stats) {
        stats.requests++;
        if (reused)
            stats.connectionsReused++;
        else
            stats.connectionsCreated++;
        if (useCachedContext)
            stats.cachedContextRequests++;
        if (requestBody.store === true)
            stats.storeTrueRequests++;
        stats.lastInputItems = requestBody.input?.length ?? 0;
        if (requestBody.previous_response_id) {
            stats.deltaRequests++;
            stats.lastDeltaInputItems = requestBody.input?.length ?? 0;
            stats.lastPreviousResponseId = requestBody.previous_response_id;
        }
        else {
            stats.fullContextRequests++;
            stats.lastDeltaInputItems = undefined;
            stats.lastPreviousResponseId = undefined;
        }
    }
    try {
        // Per-turn routing goes on the frame, never an automatically populated handshake.
        const requestHeaders = new Headers(headers);
        applyCodexTurnState(requestHeaders, turnState, model.headers, options?.headers);
        const routingState = requestHeaders.get(TURN_STATE_HEADER);
        socket.send(JSON.stringify({ type: "response.create", ...requestBody,
            ...(routingState ? { client_metadata: { ...requestBody.client_metadata, [TURN_STATE_HEADER]: routingState } } : {}) }));
        observation("ws_sent", "connecting", "ws");
        await processResponsesStream(startWebSocketOutputOnFirstEvent(mapCodexEvents(parseWebSocket(socket, options?.signal, idleTimeoutMs), output, model, options?.onProviderStreamEvent, turnState), () => { observation("ws_response", "streaming", "ws"); onStart(); }), output, stream, model, {
            serviceTier: options?.serviceTier,
            grammarToolInputProperties,
            resolveServiceTier: resolveCodexServiceTier,
            applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
        });
        assertSuccessfulOutput(output);
        if (options?.signal?.aborted) {
            keepConnection = false;
        }
        else if (useCachedContext && entry && output.responseId) {
            const responseItems = convertResponsesMessages(model, normalizeContext({ messages: [output] }), CODEX_TOOL_CALL_PROVIDERS, {
                includeSystemPrompt: false,
                grammarToolInputProperties,
            }).filter((item) => item.type !== "function_call_output" && item.type !== "custom_tool_call_output");
            entry.continuation = {
                lastRequestBody: fullBody,
                lastResponseId: output.responseId,
                lastResponseItems: responseItems,
            };
        }
    }
    catch (error) {
        if (entry) {
            entry.continuation = undefined;
        }
        keepConnection = false;
        throw error;
    }
    finally {
        release({ keep: keepConnection });
    }
}
// ============================================================================
// Error Handling
// ============================================================================
async function parseErrorResponse(response) {
    const raw = await response.text();
    let message = raw || response.statusText || "Request failed";
    let friendlyMessage;
    try {
        const parsed = JSON.parse(raw);
        const err = parsed?.error;
        if (err) {
            const code = err.code || err.type || "";
            if (/usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code) || response.status === 429) {
                const plan = err.plan_type ? ` (${err.plan_type.toLowerCase()} plan)` : "";
                const mins = err.resets_at
                    ? Math.max(0, Math.round((err.resets_at * 1000 - Date.now()) / 60000))
                    : undefined;
                const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
                friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
            }
            message = err.message || friendlyMessage || message;
        }
    }
    catch { }
    return { message, friendlyMessage };
}
// ============================================================================
// Auth & Headers
// ============================================================================
function extractAccountId(token) {
    try {
        const parts = token.split(".");
        if (parts.length !== 3)
            throw new Error("Invalid token");
        const payload = JSON.parse(atob(parts[1]));
        const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
        if (!accountId)
            throw new Error("No account ID in token");
        return accountId;
    }
    catch {
        throw new Error("Failed to extract accountId from token");
    }
}
function buildBaseCodexHeaders(defaultHeaders, initHeaders, additionalHeaders, accountId, token, requestIdentity) {
    // Defaults first so model and caller headers can override them, matching the other providers.
    const headers = new Headers(defaultHeaders);
    for (const [key, value] of Object.entries(initHeaders || {})) {
        headers.set(key, value);
    }
    const metadata = buildCodexRequestMetadata(requestIdentity);
    for (const [key, value] of Object.entries(metadata?.headers ?? {})) headers.set(key, value);
    for (const [key, value] of Object.entries(additionalHeaders || {})) {
        if (value === null) {
            headers.delete(key);
        }
        else {
            headers.set(key, value);
        }
    }
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("chatgpt-account-id", accountId);
    return headers;
}
function buildSSEHeaders(defaultHeaders, initHeaders, additionalHeaders, accountId, token, sessionId, requestIdentity) {
    const headers = buildBaseCodexHeaders(defaultHeaders, initHeaders, additionalHeaders, accountId, token, requestIdentity);
    headers.set("OpenAI-Beta", "responses=experimental");
    headers.set("accept", "text/event-stream");
    headers.set("content-type", "application/json");
    if (sessionId && !requestIdentity) {
        headers.set("session-id", sessionId);
        headers.set("x-client-request-id", sessionId);
    }
    return headers;
}
function buildWebSocketHeaders(defaultHeaders, initHeaders, additionalHeaders, accountId, token, requestId, requestIdentity) {
    const headers = buildBaseCodexHeaders(defaultHeaders, initHeaders, additionalHeaders, accountId, token, requestIdentity);
    headers.delete("accept");
    headers.delete("content-type");
    headers.delete("OpenAI-Beta");
    headers.delete("openai-beta");
    headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
    if (!requestIdentity) {
        headers.set("x-client-request-id", requestId);
        headers.set("session-id", requestId);
    }
    return headers;
}
//# sourceMappingURL=openai-codex-responses.js.map
const CODEX_NON_RETRYABLE_ERROR_PATTERN = new RegExp([
    // OpenCode Go/free-tier limits returned as 429 JSON error types by OpenCode's
    // Zen API. These are subscription/account limits, not transient throttles.
    "GoUsageLimitError",
    "FreeUsageLimitError",
    // OpenCode Go subscription-limit text asks users to enable available-balance
    // usage after rolling/weekly/monthly limits are reached.
    "Monthly usage limit reached",
    "available balance",
    // Generic quota/budget/billing exhaustion. `insufficient_quota` is OpenAI's
    // quota/billing error code; the other strings cover common gateway wording.
    "insufficient_quota",
    "out of budget",
    "quota exceeded",
    "billing",
    // Sign in with ChatGPT: the subscription's shared usage limit, which resets
    // after hours rather than seconds.
    "subscription_sharing_usage_limit_exceeded",
    "usage_limit_reached",
    "usage_not_included",
    // Explicit authentication/authorization errors require caller action. A bare
    // "authentication" mention can instead describe a transient service outage.
    "invalid_api_key",
    "authentication_error",
    "unauthorized",
    "permission_denied",
].join("|"), "i");
const CODEX_RETRYABLE_ERROR_PATTERN = new RegExp([
    // Generic provider load, HTTP status, and server-side transient failures.
    "overloaded",
    "currently experiencing high demand",
    "rate.?limit",
    "too many requests",
    "429",
    "500",
    "502",
    "503",
    "504",
    "520",
    "524",
    "service.?unavailable",
    "server.?error",
    "internal.?error",
    // Wrapper/provider text for transient upstream failures, including OpenRouter
    // "Provider returned error" responses (#2264).
    "provider.?returned.?error",
    "exceeded request buffer limit while retrying upstream",
    // Network, proxy, and fetch transport failures. This includes OpenAI Codex
    // raw-fetch failures such as "upstream connect", "connection refused", and
    // "reset before headers" (#733), plus OpenRouter connection drops (#3317).
    "network.?error",
    "connection.?error",
    "connection.?refused",
    "connection.?lost",
    "other side closed",
    "fetch failed",
    "getaddrinfo",
    "ENOTFOUND",
    "EAI_AGAIN",
    "upstream.?connect",
    "reset before headers",
    "socket hang up",
    "socket connection was closed",
    "timed? out",
    "timeout",
    "terminated",
    // WebSocket transports can report close/error text instead of HTTP/fetch text.
    "websocket.?closed",
    "websocket.?error",
    // Premature stream endings from SDKs and transports. Anthropic can throw
    // "stream ended without ..." and "Anthropic stream ended before message_stop"
    // (#4433); Bedrock/Smithy can throw an HTTP/2 no-response error (#3594).
    "ended without",
    "stream ended before message_stop",
    "stream ended before a terminal response event",
    "http2 request did not get a response",
    // Provider-requested retry delay cap failures should flow through the outer
    // retry policy so callers can surface/abort the backoff (#1123).
    "retry delay",
    // Explicit retry guidance emitted mid-stream by OpenAI Responses and Bedrock
    // stream exceptions (#6019).
    "you can retry your request",
    "try your request again",
    "please retry your request",
    // gRPC based providers (e.g. NVIDIA NIM)
    "ResourceExhausted",
    // Sign in with ChatGPT: usage or user data temporarily unavailable. Usage
    // failures can arrive mid-stream without an HTTP 503 in the message.
    "subscription_sharing_usage_unavailable",
    "subscription_sharing_user_unavailable",
].join("|"), "i");
// Source fragment appended to openai-codex-responses.ts by the transport overlay build.
const CODEX_TRANSPORT_MAX_RETRIES = 5;
// Match the Codex service-load response, not generic quota/capacity wording.
const CODEX_CAPACITY_ERROR_PATTERN = /\bCodex is at capacity\b/i;
function isCodexCapacityMessage(text) {
    return CODEX_CAPACITY_ERROR_PATTERN.test(text) && !CODEX_NON_RETRYABLE_ERROR_PATTERN.test(text);
}
function isCodexCapacityError(error) {
    if (error instanceof CodexRetryHttpError)
        return error.capacityFailure;
    return error instanceof CodexApiError && isCodexCapacityMessage(`${error.code ?? ""} ${error.message}`);
}
class CodexRetryConnectionError extends Error {
    constructor(cause) {
        super(cause instanceof Error ? cause.message : String(cause), { cause });
    }
}
class CodexRetryHttpError extends Error {
    retryable;
    retryAfterMs;
    capacityFailure;
    constructor(message, retryable, retryAfterMs, capacityFailure = false) {
        super(message);
        this.retryable = retryable;
        this.retryAfterMs = retryAfterMs;
        this.capacityFailure = capacityFailure;
    }
}
function isCodexConnectionFailure(error) {
    if (!error || typeof error !== "object")
        return false;
    const failure = error;
    if (["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(failure.code ?? ""))
        return true;
    return isCodexConnectionFailure(failure.cause) || (Array.isArray(failure.errors) && failure.errors.some(isCodexConnectionFailure));
}
function isCodexNetworkFailure(error) {
    if (error instanceof CodexApiError || error instanceof CodexRetryHttpError || isCodexNonTransportError(error))
        return false;
    if (isCodexConnectionFailure(error))
        return true;
    if (!error || typeof error !== "object")
        return false;
    const failure = error;
    if (["ECONNRESET", "ECONNABORTED", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(failure.code ?? ""))
        return true;
    if (/^(fetch failed|terminated|Codex stream ended without a stop reason|OpenAI Responses stream ended before a terminal response event)$|^Codex SSE response headers timed out after /i.test(failure.message ?? ""))
        return true;
    return isCodexNetworkFailure(failure.cause) || (Array.isArray(failure.errors) && failure.errors.some(isCodexNetworkFailure));
}
function isCodexRetryableStreamError(error) {
    if (isCodexNonTransportError(error) && !(error instanceof CodexApiError))
        return false;
    if (error instanceof CodexRetryHttpError)
        return error.retryable;
    if (error instanceof RetryDelayExceededError)
        return false;
    if (error instanceof CodexProtocolError)
        return false;
    const text = error instanceof CodexApiError ? `${error.code ?? ""} ${error.message}`
        : error instanceof Error ? error.message : String(error);
    if (CODEX_NON_RETRYABLE_ERROR_PATTERN.test(text))
        return false;
    if (isCodexCapacityError(error))
        return true;
    if (error instanceof CodexApiError && ["server_error", "rate_limit_exceeded", "websocket_connection_limit_reached", "previous_response_not_found", "subscription_sharing_usage_unavailable", "subscription_sharing_user_unavailable"].includes(error.code ?? ""))
        return true;
    return CODEX_RETRYABLE_ERROR_PATTERN.test(text) || (!(error instanceof CodexApiError) && error instanceof Error) || isCodexConnectionFailure(error);
}
function resetCodexRetryOutput(output) {
    const next = { ...output, content: [], stopReason: "pending",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    if (output.diagnostics)
        next.diagnostics = [...output.diagnostics];
    delete next.responseId;
    delete next.rawStopReason;
    delete next.errorMessage;
    delete next.endTurn;
    return next;
}
async function waitForCodexTransportRetry(output, error, transport, retry, connectionFailure, options, observation, capacityFailure = false) {
    const exponentialDelay = Math.min(60_000, 5_000 * 2 ** retry);
    const providerDelay = error instanceof CodexRetryHttpError ? error.retryAfterMs : undefined;
    const delayMs = providerDelay === undefined
        ? exponentialDelay
        : Math.max(exponentialDelay, validateRetryDelayMs(providerDelay, options));
    observation("retry", "retrying", null, capacityFailure ? "capacity_retry" : connectionFailure ? "network_retry" : "transport_retry", Date.now() + delayMs);
    // Indefinite waits retain their latest diagnostic rather than growing the transcript.
    if (connectionFailure || capacityFailure)
        output.diagnostics = output.diagnostics?.filter((entry) => connectionFailure
            ? entry.type !== "provider_connection_retry"
            : !(entry.type === "provider_transport_retry" && entry.details?.reason === "capacity"));
    appendAssistantMessageDiagnostic(output, createAssistantMessageDiagnostic(connectionFailure ? "provider_connection_retry" : "provider_transport_retry", error, {
        transport, retry: retry + 1, maxRetries: connectionFailure || capacityFailure ? null : CODEX_TRANSPORT_MAX_RETRIES, delayMs,
        ...(capacityFailure ? { reason: "capacity" } : {}),
    }));
    await new Promise((resolve, reject) => {
        const signal = options?.signal;
        const abort = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            reject(new Error("Request was aborted"));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
        }, delayMs);
        if (signal?.aborted)
            abort();
        else
            signal?.addEventListener("abort", abort, { once: true });
    });
    if (options?.signal?.aborted)
        throw new Error("Request was aborted");
}

// Process-wide, content-free events shared by modular providers and the RPC bundle.
// The host subscribes by session; no fetch/WebSocket globals or payloads are inspected.
const modelTransportObservations = globalThis[Symbol.for("pi.model.transport.v1")] ??= {
    snapshots: new Map(), listeners: new Map(), sequence: 0,
};
registerSessionResourceCleanup(sessionId => {
    if (sessionId === undefined) modelTransportObservations.snapshots.clear();
    else modelTransportObservations.snapshots.delete(sessionId);
});
function startCodexTransportObservation(sessionId) {
    if (!sessionId) return () => {};
    const requestId = ++modelTransportObservations.sequence;
    const publish = (event, phase, transport, reason, nextProbeAt) => {
        const previous = modelTransportObservations.snapshots.get(sessionId);
        if (event !== "request_start" && previous?.requestId !== requestId) return;
        const snapshot = Object.freeze({
            requestId, transport, phase, observedAt: Date.now(),
            active: event !== "end", event,
            ...(reason ? { reason } : {}),
            ...(nextProbeAt !== undefined ? { nextProbeAt } : {}),
        });
        modelTransportObservations.snapshots.set(sessionId, snapshot);
        for (const listener of modelTransportObservations.listeners.get(sessionId) ?? []) {
            try { listener(snapshot); } catch { /* Observation cannot interrupt generation. */ }
        }
    };
    publish("request_start", "connecting", null);
    return (event, phase, transport, reason, nextProbeAt) => {
        const previous = modelTransportObservations.snapshots.get(sessionId);
        const fallback = previous?.reason === "ws_unavailable" || previous?.reason === "ws_message_too_big";
        const preserveFallback = fallback && event.startsWith("sse_");
        publish(event, phase, transport === undefined ? previous?.transport ?? null : transport,
            reason ?? (preserveFallback ? previous.reason : undefined),
            nextProbeAt ?? (preserveFallback ? previous.nextProbeAt : undefined));
    };
}

// Standard GPT-6 plus the verified GPT-6.1 Sol subscription route; not Pro or other providers.
function supportsCodexReasoningReplay(model) {
    return model.provider === "openai-codex" && model.api === "openai-codex-responses" &&
        /^(gpt-6|gpt-6-(astra|luna|sol)|gpt-6\.1-sol)$/.test(model.id);
}
function resolveCodexReasoningEffort(model, reasoningEffort) {
    if (reasoningEffort !== undefined) {
        return reasoningEffort === "none"
            ? model.thinkingLevelMap?.off === undefined ? "none" : model.thinkingLevelMap.off
            : (model.thinkingLevelMap?.[reasoningEffort] ?? reasoningEffort);
    }
    return model.reasoning && model.thinkingLevelMap?.off !== null ? model.thinkingLevelMap?.off ?? "none" : undefined;
}
function createCodexReasoningReplay(model, messages, currentEffort) {
    if (!supportsCodexReasoningReplay(model) || typeof currentEffort !== "string") return undefined;
    // The session's selected branch/context is the only history. A different physical
    // model (including a failed attempt) ends the segment; aliases are routed before here.
    let start = 0;
    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        if (message.role === "assistant" && (message.provider !== model.provider ||
            message.api !== model.api || message.model !== model.id)) start = i + 1;
    }
    const isSuccess = message => ["stop", "length", "toolUse"].includes(message.stopReason);
    const effortOf = message => message.providerThinkingLevel ?? (message.thinkingLevel === undefined ? undefined
        : resolveCodexReasoningEffort(model, message.thinkingLevel === "off" ? undefined : message.thinkingLevel));
    const segment = messages.slice(start).filter(message => message.role === "assistant" && isSuccess(message));
    // Legacy history cannot tell us its request head/tail. Do not infer it from today's UI selection.
    if (segment.some(message => typeof effortOf(message) !== "string")) return undefined;
    const initialEffort = segment.length ? effortOf(segment[0]) : currentEffort;
    const assistantEfforts = messages.flatMap((message, index) => message.role !== "assistant" ||
        message.stopReason === "error" || message.stopReason === "aborted" ? []
        : [index >= start && isSuccess(message) ? effortOf(message) : undefined]);
    return { initialEffort, assistantEfforts, currentEffort };
}
