import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type Api, type AssistantMessage, type AssistantMessageEventStream,
  createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools,type Message,
  type Model, type SimpleStreamOptions, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { AcpProcess } from "./acp.ts";
import { AgyPiBridge, BRIDGE_SERVER_NAME,
  type BridgeCall, type BridgeToolDef, canonicalToolDefinitions, resolveBridgeResultsFromContext} from "./bridge/bridge.ts";
import { acpContent, visibleContent } from "./content.ts";
import { acceptedMessages, buildNativeHistory, writeNativeHistory } from "./history.ts";
import { MessageWriter } from "./message-writer.ts";
import { pricingForModel } from "./models.ts";
import { NativeControl, readNativeHttpPort } from "./native.ts";
import { type NativeToolActivity, NativeToolRecords } from "./native-tools.ts";
import { readAgyNetworkMonitor } from "./network-monitor.ts";
import { resolveBinary } from "./platform.ts";
import { installAgyDeathHooks, killAgyTree, trackAgyChild, untrackAgyChild } from "./processes.ts";
import {
  filterProfileTools,
  type NativeProfile,
  nativeAgentName,
  prepareNativeAgent,
  prepareNativeMcpConfig,
  readNativeProfile,
  syncNativeToolSchemas,
} from "./profile.ts";
import { registerLiveAcpRuntime, touchLiveAcpRuntime, unregisterLiveAcpRuntime } from "./quota.ts";
import { copyNativeConversation, removeNativeBootstrap } from "./store.ts";
import { isNativeDoneStep, isNativeErrorStep, nativePromptError } from "./terminal.ts";
import { emptyUsage, UsageLedger } from "./usage.ts";

export const PROVIDER = "antigravity-acp";
export const API = "antigravity-acp";
export const BINDING_ENTRY = "pi-antigravity-acp-checkpoint";
export const RESET_ENTRY = "pi-antigravity-acp-reset";
export const HOST_CONTINUATION = "[ACP continuation — not a new user request] Continue the active task from the effective context above. Recorded tool results are final; do not repeat prior requests or re-run completed tools.";
export interface Binding {
  version: number; conversationId: string; messageCount: number; stepIndex?: number;
  model: string; requestedModel?: string; reportedModel?: string;
  piEntryId?: string; wireOnlyInput: boolean; nativeHome?: string; historyNeedsImport?: boolean;
  bridgeServer?: string;
}
export interface RuntimeOptions {
  cwd: string; stateDirectory: string; sessionKey: string; binary?: string;
  onBinding?: (binding: Binding) => void;
  onNativeTool?: (activity: NativeToolActivity) => void;
  onLocalPrefix?: (input: {
    systemPrompt: string;
    tools: readonly BridgeToolDef[];
    agentName: string;
    agentBody?: string;
  }) => void;
  onSampleNative?: (input: { conversationId: string; geminiDir: string }) => void;
  readProfile?: () => NativeProfile;
  prepareAgent?: (
    geminiDir: string,
    systemPrompt: string,
    tools: BridgeToolDef[],
    serverName: string,
    profile: NativeProfile,
  ) => Promise<string | undefined>;
  createProcess?: typeof AcpProcess.start;
}
type Owner = {
  token: symbol; model: Model<Api>; options: SimpleStreamOptions; writer: MessageWriter;
  messages: Message[]; requestedModel?: string; reportedModel?: string; agentChanged?: boolean;
  chain: Promise<void>; finished: boolean; responded: boolean;
  complete: () => void; completed: Promise<void>;
};
type Flight = { sessionId: string; promise: Promise<any>; settled: boolean; startStep?: number };
const isModelOutput = (update: any): boolean => ["agent_message_chunk", "agent_thought_chunk"].includes(update.sessionUpdate);

export class AcpRuntime {
  readonly settings: RuntimeOptions;
  readonly bridge: AgyPiBridge;
  readonly geminiDir: string;
  private token = randomBytes(24).toString("hex");
  private tools: BridgeToolDef[] = [];
  private acp?: AcpProcess;
  private nativeSessionId?: string;
  private native?: NativeControl;
  private owner?: Owner;
  private flight?: Flight;
  private changing = false;
  private closing = false;
  private closeTask?: Promise<void>;
  private nativeStopTask?: Promise<void>;
  private queuedCalls: BridgeCall[] = [];
  private exposedCalls = new Set<string>();
  private yieldQueued = false;
  private binding?: Binding;
  private acceptedBinding?: Binding;
  private skipPrefixImport = false;
  private requestedSettings?: { model: string; reasoning: string | null };
  private usage = new UsageLedger();
  private lastTrajectory: any;
  private configOptions: any[] = [];
  private needsProjectionCheck = false;
  private needsImport = false;
  private acceptedHistory?: Message[];
  private agentPrompt?: string;
  private agentTools?: BridgeToolDef[];
  private lastAgentName?: string;
  private lastAgentBody?: string;
  private processEnv?: NodeJS.ProcessEnv;
  private lateUpdates: any[] = [];
  private nativeTools = new NativeToolRecords();
  private nativeUpdateSource?: symbol;
  private permissionCalls = new Map<string, { name?: string; kind?: string; rawInput?: unknown }>();
  private readonly nativeProfile: NativeProfile;

  constructor(settings: RuntimeOptions) {
    this.settings = settings;
    this.geminiDir = path.join(settings.stateDirectory, "gemini");
    this.nativeProfile = (settings.readProfile ?? readNativeProfile)();
    // MCP config is runtime-local; a stable logical server name preserves
    // aliases across forks while each bridge keeps its own URL and secret.
    this.bridge = new AgyPiBridge(BRIDGE_SERVER_NAME);
    this.bridge.requireToken(this.token);
    this.bridge.setToolPrefix("");
    this.bridge.setReadable(this.nativeProfile.nativeTools.includes("read_file"));
    this.bridge.setArchiveDirectory(path.join(settings.stateDirectory, "output"));
    this.bridge.setToolSource(() => this.tools);
    this.bridge.setOnCall(call => {
      this.queuedCalls.push(call);
      if (this.owner && !this.changing) this.scheduleYield(this.owner);
      // No absent-owner or timeout response can unlock the native generator.
      return true;
    });
  }

  restore(entries: readonly any[]): void {
    const boundary = entries.findLast(e => e.type === "custom" && (e.customType === RESET_ENTRY
      || (e.customType === BINDING_ENTRY && typeof e.data?.conversationId === "string")));
    const entry = boundary?.customType === BINDING_ENTRY ? boundary : undefined;
    this.skipPrefixImport = boundary?.customType === RESET_ENTRY;
    const previous = this.binding;
    const parent = entries.find(e => e.id === entry?.parentId);
    this.binding = entry ? { ...entry.data, piEntryId: entry.data.piEntryId
      ?? (parent?.type === "message" && parent.message?.role === "assistant" ? parent.id : undefined) } : undefined;
    this.acceptedBinding = this.binding && { ...this.binding };
    const sameCheckpoint = previous && this.binding
      && previous.conversationId === this.binding.conversationId
      && previous.messageCount === this.binding.messageCount && previous.stepIndex === this.binding.stepIndex;
    if (!sameCheckpoint || !this.acceptedHistory) {
      // Rebuild the accepted prefix from Pi's own entries, including compaction/context edits.
      const anchor = this.binding?.piEntryId;
      const messages = anchor && entries.some(e => e.id === anchor)
        ? buildSessionContext([...entries], anchor).messages as Message[] : undefined;
      this.acceptedHistory = messages && structuredClone(messages);
      this.agentPrompt = messages && getCurrentSystemPrompt(messages);
      this.agentTools = messages && filterProfileTools(
        canonicalToolDefinitions(getCurrentTools(messages)),
        this.nativeProfile,
      ).map(tool => ({
        name: tool.name, description: tool.description, parameters: tool.parameters,
      }));
    }
    this.needsProjectionCheck = true;
    const checkHome = this.binding?.nativeHome ?? this.geminiDir;
    const legacyBridgeMismatch = this.binding !== undefined && (
      (this.binding.bridgeServer !== undefined && this.binding.bridgeServer !== this.bridge.serverName)
      || (this.binding.bridgeServer === undefined && existsSync(path.join(checkHome, "config", "agents", "pi-acp-pi-acp", "agent.md")))
    );
    // Missing legacy entry data or legacy bridge identity selects a current-history import, never a refusal or blind load.
    this.needsImport = !this.acceptedHistory || this.binding?.historyNeedsImport === true || legacyBridgeMismatch;
  }

  invalidateProjection(): void { this.needsProjectionCheck = true; this.needsImport = true; }
  snapshot(): Binding | undefined { return this.binding && { ...this.binding }; }

  /** Local state only: never opens AGY or exposes the MCP secret/environment. */
  diagnostics(): object {
    let binary: string | undefined, binaryError: string | undefined;
    try { binary = resolveBinary(this.settings.binary); }
    catch (error) { binaryError = error instanceof Error ? error.message : String(error); }
    return { binary, binaryError, binding: this.snapshot(), acceptedBinding: this.acceptedBinding && { ...this.acceptedBinding },
      live: this.hasLiveNativeControl(), promptActive: Boolean(this.flight && !this.flight.settled),
      ownerActive: Boolean(this.owner && !this.owner.finished), pendingTools: this.bridge.pendingCount,
      requested: this.requestedSettings, reported: this.configOptions.filter(option => ["model", "thought_level"].includes(option.id))
        .map(option => ({ id: option.id, value: option.currentValue })),
      skipPrefixImport: this.skipPrefixImport, needsImport: this.needsImport, needsProjectionCheck: this.needsProjectionCheck };
  }

  /** Forget native state without rewriting Pi's transcript. The separate reset
   * entry restores this one-shot import boundary after reload/tree navigation. */
  async reset(): Promise<void> {
    if (this.owner && !this.owner.finished) await this.fail(this.owner, new Error("AGY ACP manually reset"), true);
    await this.stopNative();
    await this.closeProcess();
    this.flight = undefined;
    this.binding = undefined; this.acceptedBinding = undefined; this.acceptedHistory = undefined;
    this.lastTrajectory = undefined; this.usage = new UsageLedger();
    this.queuedCalls = []; this.exposedCalls.clear(); this.lateUpdates = [];
    this.agentPrompt = undefined; this.agentTools = undefined;
    this.needsProjectionCheck = false; this.needsImport = false; this.skipPrefixImport = true;
  }
  hasLiveNativeControl(): boolean { return Boolean(this.native && this.acp && !this.closing && !this.acp.signal.aborted); }
  async readQuotaSummary(signal?: AbortSignal): Promise<any> {
    if (!this.hasLiveNativeControl()) throw new Error("AGY runtime has no active NativeControl.");
    return this.native!.quotaSummary(signal);
  }

  stream(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions = {}): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    const output: AssistantMessage = { role: "assistant", api: API, provider: PROVIDER, model: model.id,
      content: [], usage: emptyUsage(), stopReason: "stop", timestamp: Date.now() };
    const writer = new MessageWriter(output, stream);
    let complete!: () => void;
    const completed = new Promise<void>(resolve => { complete = resolve; });
    const owner: Owner = { token: Symbol("pi-acp-request"), model, options, writer,
      messages: [], chain: Promise.resolve(), finished: false, responded: false, complete, completed };
    if (this.closing || (this.owner && !this.owner.finished)) {
      writer.start(); writer.fail(new Error("Concurrent Pi requests cannot share one AGY runtime."));
      return stream;
    }
    // Acquire synchronously, before any old MCP response can be delivered.
    this.owner = owner;
    writer.start();
    const abort = () => {
      if (this.owner?.token !== owner.token || owner.finished) return;
      void this.fail(owner, options.signal?.reason ?? new Error("Pi request cancelled"), true)
        .catch(error => console.error("[antigravity-acp] cancellation cleanup failed:", error));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    void this.run(owner, context).catch(error => this.fail(owner, error)).finally(() => {
      options.signal?.removeEventListener("abort", abort);
      if (this.owner?.token === owner.token) this.owner = undefined;
    });
    return stream;
  }

  private enqueue(owner: Owner, action: () => void | Promise<void>): void {
    owner.chain = owner.chain.then(action).catch(error => { void this.fail(owner, error); });
  }

  private async run(owner: Owner, context: TranscriptContext): Promise<void> {
    owner.options.signal?.throwIfAborted();
    const requestIdentity = (owner.options as SimpleStreamOptions & { requestIdentity?: { requestKind?: string } }).requestIdentity;
    const payload = { messages: context.messages, model: owner.model.id, thoughtLevel: owner.options.reasoning,
      requestKind: requestIdentity?.requestKind ?? "turn" };
    const replacement = await owner.options.onPayload?.(payload, owner.model);
    const effective = (replacement ?? payload) as typeof payload;
    owner.messages = effective.messages;
    owner.requestedModel = effective.model;
    owner.writer.output.model = effective.model;
    const systemPrompt = getCurrentSystemPrompt(owner.messages);
    const tools = filterProfileTools(
      canonicalToolDefinitions(getCurrentTools(owner.messages)),
      this.nativeProfile,
    ).map(tool => ({
      name: tool.name, description: tool.description, parameters: tool.parameters,
    }));
    const agentChanged = this.agentPrompt !== undefined
      && (this.agentPrompt !== systemPrompt || !isDeepStrictEqual(this.agentTools, tools));
    owner.agentChanged = agentChanged;
    this.tools = tools;
    this.bridge.refreshTools();
    const monitor = readAgyNetworkMonitor();
    if (monitor.warning) owner.writer.diagnostic({ type: "agy_acp_monitor_unavailable", timestamp: Date.now(),
      error: { message: monitor.warning } });
    for (const event of this.lateUpdates.splice(0)) {
      owner.writer.diagnostic({ type: "agy_acp_late_content", timestamp: Date.now(), details: event });
    }
    await this.nativeStopTask;
    this.assertOwner(owner);
    const binding = this.binding;
    const historyChanged = this.acceptedHistory !== undefined && (
      !isDeepStrictEqual(effectiveHistory(owner.messages.slice(0, this.acceptedHistory.length)), effectiveHistory(this.acceptedHistory))
      || effectiveHistory(owner.messages.slice(this.acceptedHistory.length)).some((message: any) =>
        message.role === "assistant" || (message.role === "toolResult" && !this.bridge.pendingCount)));
    const transportChanged = this.acp && this.processEnv && !isDeepStrictEqual(this.processEnv, monitor.env);
    const extraUsers = owner.messages.slice(binding?.messageCount ?? 0).filter(message => message.role === "user");
    const requiresUserMedia = extraUsers.some(message => Array.isArray(message.content)
      && message.content.some(part => part.type !== "text"));
    // When AGY is actively waiting on a pending MCP bridge call (e.g. codemode calling setActiveTools),
    // refresh the live bridge catalog and deliver the toolResult without killing the active native turn;
    // agentPrompt/agentTools remain at the compiled snapshot so the next idle turn refreshes agent.md.
    if (this.flight && !this.flight.settled && this.flight.sessionId === binding?.conversationId
      && this.nativeSessionId === binding?.conversationId && this.bridge.pendingCount
      && !historyChanged && !requiresUserMedia && !transportChanged && !this.needsImport) {
      if (agentChanged) await syncNativeToolSchemas(this.geminiDir, this.tools, this.bridge.serverName, this.nativeProfile);
      try { await this.configure([], binding.conversationId, effective.model, effective.thoughtLevel); }
      catch (error) {
        owner.options.signal?.throwIfAborted();
        owner.writer.diagnostic({ type: "agy_acp_settings_deferred", timestamp: Date.now(),
          details: { requested: { model: effective.model, reasoning: effective.thoughtLevel ?? null },
            reported: this.configOptions, until: "next idle Pi request" },
          error: { message: error instanceof Error ? error.message : String(error) } });
      }
      await this.respond(owner);
      this.assertOwner(owner);
      if (this.queuedCalls.some(call => !this.exposedCalls.has(call.id))) this.scheduleYield(owner);
      else {
        const steer = extraUsers.length ? { text: `[New message from the user, before continuing]\n${extraUsers.map(m => textContent(m)).join("\n")}`, delivered() {} } : undefined;
        const delivered = resolveBridgeResultsFromContext(this.bridge, owner.messages, steer);
        if (!delivered && this.bridge.pendingCount) throw new Error("Pi has not supplied the real result for the waiting MCP call.");
      }
      await owner.completed;
      return;
    }

    // These Pi results have not reached native yet; materialize them if warm delivery is interrupted.
    const materializeResults = this.bridge.pendingCount > 0;
    if (this.flight && !this.flight.settled) await this.stopNative();
    const lastBody = owner.messages.findLastIndex(message => message.role !== "user" && message.role !== "system");
    const tail = owner.messages.slice(lastBody + 1).filter(message => message.role === "user");
    const hasNewUser = tail.length > 0;
    const prefix = hasNewUser ? owner.messages.slice(0, lastBody + 1) : owner.messages;
    const env = monitor.env;
    if (transportChanged) {
      await this.closeProcess();
      owner.writer.diagnostic({ type: "agy_acp_recovery", timestamp: Date.now(),
        details: { action: "restart_process", reason: "transport_changed" } });
    }
    let nativeId: string | undefined;
    if (binding && !agentChanged && !historyChanged && !this.needsImport && !materializeResults) {
      const local = !binding.nativeHome || path.resolve(binding.nativeHome) === path.resolve(this.geminiDir);
      if (this.acp && this.nativeSessionId === binding.conversationId && !this.needsProjectionCheck && local) nativeId = binding.conversationId;
      else if (binding.stepIndex !== undefined && !binding.historyNeedsImport) {
        if (!local) await this.closeProcess();
        nativeId = await this.restoreCheckpoint(binding, systemPrompt, env);
        owner.writer.diagnostic({ type: "agy_acp_recovery", timestamp: Date.now(),
          details: { action: nativeId === binding.conversationId ? "load_session" : "fork_checkpoint",
            previousConversationId: binding.conversationId, conversationId: nativeId } });
      }
    }
    if (!nativeId) {
      await this.closeProcess();
      owner.writer.diagnostic({ type: "agy_acp_recovery", timestamp: Date.now(),
        details: { action: "cold_import", reason: agentChanged ? "agent_system_or_tools_changed" : "effective_history_changed" } });
      if (!this.skipPrefixImport && prefix.some(message => message.role !== "system")) {
        const nativeAgentMetadata = await this.compileAgentMetadata(systemPrompt, env);
        const history = buildNativeHistory(prefix, owner.model, {
          cwd: this.settings.cwd, serverName: this.bridge.serverName, nativeAgentMetadata,
        });
        nativeId = (await writeNativeHistory(history, {
          conversationsDirectory: path.join(this.geminiDir, "antigravity-cli", "conversations"),
        })).conversationId;
      }
    }
    if (nativeId && this.nativeSessionId && this.nativeSessionId !== nativeId) await this.closeProcess();
    await this.open(systemPrompt, env);
    this.processEnv = { ...env };
    this.assertOwner(owner);
    if (!this.acp) throw new Error("ACP process was not initialized.");
    if (!nativeId || this.nativeSessionId !== nativeId) {
      const loaded = nativeId
        ? await this.acp.loadSession({ sessionId: nativeId, cwd: this.settings.cwd, mcpServers: [] })
        : await this.acp.newSession({ cwd: this.settings.cwd, mcpServers: [] });
      nativeId ??= "sessionId" in loaded ? String(loaded.sessionId) : undefined;
      if (!nativeId) throw new Error("ACP session/new returned no session ID.");
      this.nativeSessionId = nativeId;
      await this.configure(loaded.configOptions ?? [], nativeId, effective.model, effective.thoughtLevel);
      this.native = new NativeControl(await this.acp.getNativeHttpPort());
      registerLiveAcpRuntime(this);
      this.lastTrajectory = await this.sample(owner, nativeId);
      this.usage = new UsageLedger();
      this.usage.baseline(this.lastTrajectory);
    } else {
      await this.configure([], nativeId, effective.model, effective.thoughtLevel);
      touchLiveAcpRuntime(this);
      this.lastTrajectory = await this.sample(owner, nativeId);
    }
    const startStep = Array.isArray(this.lastTrajectory?.steps) ? this.lastTrajectory.steps.length - 1 : undefined;
    this.needsProjectionCheck = false;
    this.needsImport = false;
    const prompt = hasNewUser ? tail.flatMap(message => promptContent(message)) : [{ type: "text" as const, text: HOST_CONTINUATION }];
    await this.respond(owner);
    this.assertOwner(owner);
    const currentId = nativeId!;
    try {
      this.settings.onLocalPrefix?.({
        systemPrompt,
        tools: this.tools,
        agentName: this.lastAgentName ?? nativeAgentName(this.bridge.serverName),
        agentBody: this.lastAgentBody,
      });
    } catch { /* Observability failure must not affect the model turn. */ }
    this.binding = { version: 3, conversationId: currentId, messageCount: prefix.length,
      stepIndex: currentId === binding?.conversationId ? binding.stepIndex : undefined,
      model: owner.writer.output.model, wireOnlyInput: !hasNewUser, nativeHome: this.geminiDir,
      historyNeedsImport: currentId === binding?.conversationId ? binding.historyNeedsImport : undefined,
      bridgeServer: this.bridge.serverName };
    this.permissionCalls.clear();
    const flight: Flight = { sessionId: currentId, settled: false, promise: Promise.resolve(), startStep };
    this.flight = flight;
    flight.promise = this.acp.prompt(currentId, prompt, { signal: owner.options.signal });
    void flight.promise.then(response => this.settled(flight, response), error => this.rejected(flight, error));
    await owner.completed;
  }

  private async restoreCheckpoint(binding: Binding, systemPrompt: string, env: NodeJS.ProcessEnv): Promise<string> {
    const directory = path.join(this.geminiDir, "antigravity-cli", "conversations");
    const copied = binding.nativeHome && path.resolve(binding.nativeHome) !== path.resolve(this.geminiDir);
    const temporary = copied ? await copyNativeConversation(
      path.join(binding.nativeHome!, "antigravity-cli", "conversations"), directory, binding.conversationId,
    ) : undefined;
    let restored: string | undefined;
    try {
      // Only the accepted cursor is forked; unknown tails are imported from Pi by run().
      const fork = (control: NativeControl) => control.fork(binding.conversationId, binding.stepIndex);
      restored = this.native && !copied ? await fork(this.native)
        : await this.withNativeSeed(systemPrompt, env, fork);
      return restored;
    } finally {
      if (temporary && restored !== binding.conversationId) await removeNativeBootstrap(temporary);
    }
  }

  private async withNativeSeed<T>(
    systemPrompt: string, env: NodeJS.ProcessEnv, inspect: (control: NativeControl, sessionId: string) => Promise<T>,
  ): Promise<T> {
    await this.open(systemPrompt, env);
    const acp = this.acp!;
    const seed = await acp.newSession({ cwd: this.settings.cwd, mcpServers: [] });
    this.nativeSessionId = seed.sessionId;
    try {
      return await inspect(new NativeControl(await acp.getNativeHttpPort()), seed.sessionId);
    } finally {
      await acp.closeSession(seed.sessionId);
      this.nativeSessionId = undefined;
      // session/close can return while the per-session worker still owns its
      // SQLite handle. Finish this zero-generation process before unlinking.
      await this.closeProcess();
      const directory = path.join(this.geminiDir, "antigravity-cli", "conversations");
      await Promise.all([".pb", ".db"].map(extension => removeNativeBootstrap(path.join(directory, seed.sessionId + extension))));
    }
  }

  private compileAgentMetadata(systemPrompt: string, env: NodeJS.ProcessEnv): Promise<any> {
    return this.withNativeSeed(systemPrompt, env, async (control, sessionId) => {
      const metadata = (await control.trajectory(sessionId)).trajectory?.metadata;
      if (!metadata?.staticConfig || !metadata?.agentScript) {
        throw new Error("AGY session/new did not return its compiled custom-agent metadata; refusing a default-agent history import.");
      }
      return { staticConfig: metadata.staticConfig, agentScript: metadata.agentScript };
    });
  }

  private assertOwner(owner: Owner): void {
    owner.options.signal?.throwIfAborted();
    if (this.closing || owner.finished || this.owner?.token !== owner.token) throw new Error("Pi request owner is no longer active.");
  }

  private allowsCallMcpTool(rawInput: unknown): boolean {
    if (!this.tools.length) return false;
    if (!rawInput || typeof rawInput !== "object") return false;
    const input = rawInput as Record<string, unknown>;
    const server = input.ServerName ?? input.serverName;
    const tool = input.ToolName ?? input.toolName;
    return server === this.bridge.serverName && this.bridge.ownsToolAlias(tool);
  }

  private async open(systemPrompt: string, env: NodeJS.ProcessEnv): Promise<void> {
    if (this.acp) return;
    await mkdir(this.geminiDir, { recursive: true });
    await this.bridge.start();
    // Supplying the same server via session/new/load would overwrite its timeout
    // with AGY's 180s default. Discover it only from the private Gemini config.
    await prepareNativeMcpConfig(this.geminiDir, this.bridge.serverName,
      this.tools.length ? { url: this.bridge.url!, token: this.token } : undefined);
    const agent = await (this.settings.prepareAgent ?? prepareNativeAgent)(
      this.geminiDir, systemPrompt, this.tools, this.bridge.serverName, this.nativeProfile,
    );
    this.lastAgentName = agent;
    this.lastAgentBody = agent
      ? await readFile(path.join(this.geminiDir, "config", "agents", agent, "agent.md"), "utf8").catch(() => undefined)
      : undefined;
    this.agentPrompt = systemPrompt;
    this.agentTools = structuredClone(this.tools);
    if (this.owner) this.owner.agentChanged = false;
    installAgyDeathHooks();
    const source = Symbol("acp-update-source");
    this.nativeUpdateSource = source;
    this.acp = await (this.settings.createProcess ?? AcpProcess.start)({
      executable: this.settings.binary ?? resolveBinary(), cwd: this.settings.cwd, geminiDir: this.geminiDir, env,
      agent, processPerSession: true, logDirectory: path.join(this.geminiDir, "antigravity-cli", "log"), readNativeHttpPort,
      requestPermission: params => {
        // ToolCallUpdate is partial: reuse the announced call when name/kind/rawInput are omitted.
        // Native execution is restricted to the active profile; MCP calls still route to Pi before execution.
        const call = { ...this.permissionCalls.get(params.toolCall.toolCallId), ...Object.fromEntries(
          Object.entries(params.toolCall).filter(([, value]) => value != null)) };
        const read = this.nativeProfile.nativeTools.includes("read_file")
          && (call.name != null ? call.name === "read_file" : call.kind === "read");
        const callMcp = call.name === "call_mcp_tool"
          && this.allowsCallMcpTool(call.rawInput);
        const active = source === this.nativeUpdateSource && params.sessionId === this.nativeSessionId
          && this.flight?.sessionId === params.sessionId && !this.flight.settled
          && !this.changing && !this.closing;
        const option = active && (read || callMcp || this.bridge.ownsNativeTool(call.name))
          ? params.options.find(option => option.kind.startsWith("allow")) : undefined;
        if (!option) this.owner?.writer.diagnostic({ type: "agy_acp_permission_cancelled", timestamp: Date.now(),
          details: { sessionId: params.sessionId, toolCallId: params.toolCall.toolCallId, name: call.name ?? null } });
        return option ? { outcome: { outcome: "selected", optionId: option.optionId } }
          : { outcome: { outcome: "cancelled" } };
      },
      onUpdateError: error => {
        const entry = { type: "agy_acp_update_error", timestamp: Date.now(), error: { message: String(error) } };
        if (this.owner && !this.owner.finished) this.owner.writer.diagnostic(entry);
        else console.warn("[antigravity-acp] native update error:", error);
      },
      onUpdate: (notification, phase) => {
        const update = notification.update as any;
        if (phase.phase === "replay") return; // Pi already owns the replayed history.
        const owner = this.owner;
        if (source !== this.nativeUpdateSource || (this.nativeSessionId !== undefined && notification.sessionId !== this.nativeSessionId) || !this.acp || phase.phase !== "prompt" || !this.flight || this.flight.settled || this.flight.sessionId !== notification.sessionId || this.changing || this.closing || !owner || owner.finished) {
          if (isModelOutput(update)) this.lateUpdates.push({ sessionId: notification.sessionId, content: update.content });
          return;
        }
        if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
          const prior = this.permissionCalls.get(update.toolCallId);
          this.permissionCalls.set(update.toolCallId, {
            name: update.name ?? prior?.name,
            kind: update.kind ?? prior?.kind,
            rawInput: update.rawInput ?? prior?.rawInput,
          });
        }
        this.enqueue(owner, async () => {
          await owner.options.onProviderStreamEvent?.(notification, owner.model);
          if (source !== this.nativeUpdateSource || !this.acp || this.changing || this.closing) return;
          this.map(owner, update, notification.sessionId);
        });
      },
    });
    if (this.closing) {
      await this.acp.close(new Error("AGY runtime closed during process startup"));
      this.acp = undefined;
      throw new Error("AGY runtime is closed.");
    }
    trackAgyChild(this.acp);
    await this.acp.initialize();
  }

  private async configure(options: any[], sessionId: string, modelId: string, reasoning: string | undefined): Promise<void> {
    if (options.length) this.configOptions = options;
    const requested = { model: modelId, reasoning: reasoning ?? null };
    this.requestedSettings = requested;
    const set = async (configId: string, value: string): Promise<void> => {
      const response = await this.acp!.setConfigOption({ sessionId, configId, value });
      if (Array.isArray(response?.configOptions)) this.configOptions = response.configOptions;
      const reportedModel = response?.configOptions?.find(option => option.id === "model")?.currentValue;
      if (this.owner && configId === "model") {
        this.owner.reportedModel = typeof reportedModel === "string" ? reportedModel : undefined;
        this.owner.writer.output.model = this.owner.reportedModel ?? modelId;
      }
      this.owner?.writer.diagnostic({ type: "agy_acp_native_settings", timestamp: Date.now(),
        details: { requested, setting: configId, submitted: value,
          reported: response?.configOptions ?? null, effectiveValue: response?.configOptions?.find(option => option.id === configId)?.currentValue ?? null } as any });
    };
    await set("model", modelId);
    if (reasoning !== undefined) await set("thought_level",
      ["off", "minimal"].includes(reasoning) ? "low" : reasoning === "max" ? "xhigh" : reasoning);
  }

  private async respond(owner: Owner): Promise<void> {
    if (owner.responded) return;
    await owner.options.onResponse?.({ status: 200, headers: { "x-pi-transport": "acp", "x-agy-session": this.binding?.conversationId ?? "new" } }, owner.model);
    owner.responded = true;
  }

  private map(owner: Owner, update: any, sessionId: string): void {
    if (owner.finished || this.owner?.token !== owner.token) return;
    if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
      owner.writer.append(update.sessionUpdate === "agent_thought_chunk" ? "thinking" : "text",
        update.content?.type === "text" ? update.content.text : visibleContent(update.content));
    } else if (update.sessionUpdate === "usage_update") this.usage.setContext(update.used);
    else if (this.settings.onNativeTool && sessionId === this.nativeSessionId) {
      const activity = this.nativeTools.reduce(sessionId, update, () => {
        owner.writer.closeBlock();
        return { messageTimestamp: owner.writer.output.timestamp, contentIndex: owner.writer.output.content.length };
      });
      // Native activity is persisted separately; never add a Pi toolCall or model message.
      if (activity) {
        try { this.settings.onNativeTool(activity); }
        catch (error) { owner.writer.diagnostic({ type: "agy_acp_native_tool_persist_failed", timestamp: Date.now(), error: { message: String(error) } }); }
      }
    }
  }

  private scheduleYield(owner: Owner): void {
    if (this.yieldQueued || owner.finished) return;
    this.yieldQueued = true;
    this.enqueue(owner, async () => {
      try {
        touchLiveAcpRuntime(this);
        const trajectory = await this.sample(owner);
        for (const call of this.queuedCalls.splice(0)) {
          if (this.exposedCalls.has(call.id)) continue;
          this.exposedCalls.add(call.id);
          owner.writer.tool({ type: "toolCall", id: call.id, name: call.tool, arguments: call.args as any });
        }
        this.usage.apply(owner.writer.output, trajectory, pricingForModel(owner.model.id));
        await this.record(owner, trajectory, "toolUse");
        this.sampleNativeAudit(this.binding?.conversationId ?? this.flight?.sessionId);
        this.finish(owner, "toolUse");
      } finally { this.yieldQueued = false; }
    });
  }

  private async settled(flight: Flight, response: any): Promise<void> {
    flight.settled = true;
    if (this.flight !== flight || this.changing || this.closing) return;
    const owner = this.owner;
    if (!owner || owner.finished) {
      if (this.bridge.pendingCount) this.bridge.cancelPending(`AGY native prompt ended (${response.stopReason}) before consuming its pending result.`);
      return;
    }
    this.enqueue(owner, async () => {
      touchLiveAcpRuntime(this);
      const trajectory = await this.sample(owner);
      this.usage.apply(owner.writer.output, trajectory, pricingForModel(owner.model.id), response.usage);
      if (response.stopReason === "cancelled" || owner.options.signal?.aborted) {
        this.bridge.cancelPending("AGY native prompt has stopped.");
        await this.fail(owner, new Error("AGY request cancelled"), true);
      } else {
        const nativeError = nativePromptError(trajectory, flight.startStep);
        if (nativeError) {
          this.sampleNativeAudit(flight.sessionId);
          owner.writer.diagnostic({ type: "agy_acp_native_error", timestamp: Date.now(),
            details: { stepIndex: (nativeError as any).stepIndex, error: (nativeError as any).nativeError } });
          await this.fail(owner, nativeError);
          return;
        }
        await this.record(owner, trajectory, response.stopReason === "max_tokens" ? "length" : "stop");
        this.sampleNativeAudit(flight.sessionId);
        this.finish(owner, response.stopReason === "max_tokens" ? "length" : "stop");
      }
    });
  }

  private async rejected(flight: Flight, error: unknown): Promise<void> {
    flight.settled = true;
    if (this.flight !== flight || this.changing || this.closing) return;
    const owner = this.owner;
    this.changing = true;
    const task = (async () => {
      if (this.acp?.signal.aborted) killAgyTree(this.acp);
      try { await this.closeProcess(); }
      catch (cleanup) {
        if (owner && !owner.finished) owner.writer.diagnostic({ type: "agy_acp_cleanup_failed", timestamp: Date.now(), error: { message: String(cleanup) } });
        else console.warn("[antigravity-acp] failed to close disconnected native process:", cleanup);
      }
      this.bridge.cancelPending("AGY native transport has stopped.");
      if (owner && !owner.finished) await this.fail(owner, error);
      else console.warn("[antigravity-acp] native transport stopped while Pi owned tool execution:", error);
    })();
    this.nativeStopTask = task;
    try { await task; }
    finally {
      if (this.nativeStopTask === task) this.nativeStopTask = undefined;
      this.changing = false;
    }
  }

  private async sample(owner: Owner, sessionId?: string): Promise<any> {
    const id = sessionId ?? this.binding?.conversationId ?? this.flight?.sessionId;
    if (!this.native || !id) return undefined;
    try {
      this.lastTrajectory = (await this.native.trajectory(id)).trajectory;
      return this.lastTrajectory;
    }
    catch (error) {
      owner.writer.diagnostic({ type: "agy_acp_native_telemetry_unavailable", timestamp: Date.now(),
        error: { message: error instanceof Error ? error.message : String(error) } });
      return undefined;
    }
  }

  private async record(owner: Owner, trajectory: any, reason: "stop" | "toolUse" | "length"): Promise<void> {
    owner.writer.output.stopReason = reason;
    if (!this.binding) return;
    const messages = [...owner.messages, owner.writer.output];
    const steps: any[] = trajectory?.steps ?? [];
    const stepIndex = steps.findLastIndex(step => isNativeDoneStep(step) && !isNativeErrorStep(step));
    this.binding = { ...this.binding, version: 3, model: owner.writer.output.model,
      requestedModel: owner.requestedModel, reportedModel: owner.reportedModel,
      messageCount: messages.length, stepIndex: stepIndex >= 0 ? stepIndex : this.binding.stepIndex,
      historyNeedsImport: stepIndex < 0 || Boolean(owner.agentChanged),
      bridgeServer: this.bridge.serverName };
    this.acceptedHistory = structuredClone(messages);
    this.acceptedBinding = { ...this.binding };
    this.skipPrefixImport = false;
    try { this.settings.onBinding?.({ ...this.binding }); }
    catch (error) { owner.writer.diagnostic({ type: "agy_acp_binding_persist_failed", timestamp: Date.now(), error: { message: String(error) } }); }
  }

  private finish(owner: Owner, reason: "stop" | "toolUse" | "length"): void {
    if (owner.finished) return;
    owner.finished = true;
    owner.writer.finish(reason);
    owner.complete();
  }

  private sampleNativeAudit(conversationId = this.binding?.conversationId ?? this.flight?.sessionId ?? this.nativeSessionId): void {
    if (!conversationId || !this.settings.onSampleNative) return;
    try { this.settings.onSampleNative({ conversationId, geminiDir: this.geminiDir }); }
    catch { /* Observability failure must not affect the model turn. */ }
  }

  private async fail(owner: Owner, error: unknown, aborted = owner.options.signal?.aborted === true): Promise<void> {
    if (owner.finished) return;
    owner.finished = true;
    const activeId = this.flight?.sessionId ?? this.binding?.conversationId;
    try { if (this.flight && !this.flight.settled) await this.stopNative(); }
    finally {
      this.sampleNativeAudit(activeId);
      // A failed native tail is never accepted, even if ACP returned end_turn.
      this.binding = this.acceptedBinding && { ...this.acceptedBinding };
      this.needsProjectionCheck = true;
      owner.writer.fail(error, aborted); owner.complete();
    }
  }

  stopNative(): Promise<void> {
    if (this.nativeStopTask) return this.nativeStopTask;
    const task = this.stopNativeNow();
    this.nativeStopTask = task;
    const clear = () => { if (this.nativeStopTask === task) this.nativeStopTask = undefined; };
    void task.then(clear, clear);
    return task;
  }

  private async stopNativeNow(): Promise<void> {
    if (!this.acp || !this.flight || this.flight.settled) return;
    this.changing = true;
    this.needsProjectionCheck = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([this.acp.cancel(this.flight.sessionId).then(() => true).catch(() => false),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 5_000); })]);
      if (!result) { killAgyTree(this.acp); await this.acp.close(new Error("AGY did not acknowledge cancellation")); this.acp = undefined; this.nativeSessionId = undefined; this.native = undefined;
        unregisterLiveAcpRuntime(this);
        this.processEnv = undefined; this.configOptions = []; this.permissionCalls.clear(); this.nativeUpdateSource = undefined; }
      this.bridge.cancelPending("AGY native prompt has stopped.");
      this.queuedCalls = []; this.exposedCalls.clear();
      this.flight = undefined;
    } finally { if (timer) clearTimeout(timer); this.changing = false; }
  }

  private async closeProcess(): Promise<void> {
    const acp = this.acp;
    this.processEnv = undefined; this.configOptions = []; this.permissionCalls.clear();
    this.nativeUpdateSource = undefined;
    if (!acp) return;
    if (this.flight && !this.flight.settled) await this.stopNative();
    const sessionId = this.nativeSessionId;
    this.acp = undefined; this.nativeSessionId = undefined; this.native = undefined;
    unregisterLiveAcpRuntime(this);
    try { if (sessionId) await acp.closeSession(sessionId); }
    finally { await acp.close(); untrackAgyChild(acp); }
  }

  close(): Promise<void> {
    this.closeTask ??= this.closeAll();
    return this.closeTask;
  }

  private async closeAll(): Promise<void> {
    this.closing = true;
    try { await this.closeProcess(); }
    finally {
      await this.bridge.close();
      if (this.owner && !this.owner.finished) await this.fail(this.owner, new Error("AGY runtime closed"), true);
    }
  }
}

export function textContent(message: Message): string {
  return typeof message.content === "string" ? message.content : message.content
    .filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
}

export function promptContent(message: Message): any[] { return acpContent(message.content); }

/** Compare actual accepted Pi content, not synthetic hashes or import-model transforms. */
function effectiveHistory(messages: readonly Message[]): unknown[] {
  return acceptedMessages(messages)
    .map(message => message.role === "toolResult"
      ? { role: message.role, content: message.content, toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError }
      : { role: message.role, content: message.content });
}
