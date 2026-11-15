import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import type {
  ClientConnection, ContentBlock, InitializeRequest, InitializeResponse,
  LoadSessionRequest, NewSessionRequest, PromptResponse, RequestPermissionRequest,
  RequestPermissionResponse, ResumeSessionRequest, SessionNotification,
  SessionOptionsRequest, SetSessionConfigOptionRequest, Stream,
} from "@agentclientprotocol/sdk/unstable";
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk/unstable";

export type UpdatePhase = "replay" | "prompt" | "idle";
export type AcpConnectionOptions = {
  /** Called synchronously, in wire arrival order. Do not await or reorder here. */
  onUpdate?: (notification: SessionNotification, context: { phase: UpdatePhase }) => void;
  onUpdateError?: (error: unknown) => void;
  /** No native permissions are granted by default; a bridge may inject a whitelist. */
  requestPermission?: (
    request: RequestPermissionRequest,
    signal: AbortSignal,
  ) => RequestPermissionResponse | Promise<RequestPermissionResponse>;
};

type PendingPrompt = {
  response: Promise<PromptResponse>;
  cancellation?: Promise<PromptResponse>;
};

/** Persistent official ACP connection. No process, request, or replay on import. */
export class AcpConnection {
  readonly #connection: ClientConnection;
  readonly #prompts = new Map<string, PendingPrompt>();
  readonly #replaying = new Set<string>();
  #initializing?: Promise<InitializeResponse>;
  #initialization?: InitializeResponse;

  constructor(stream: Stream, options: AcpConnectionOptions = {}) {
    this.#connection = client({ name: "antigravity-acp" })
      .onRequest(methods.client.session.requestPermission, ({ params, signal }) =>
        options.requestPermission?.(params, signal) ?? { outcome: { outcome: "cancelled" } })
      .onNotification(methods.client.session.update, ({ params }) => {
        const phase = this.#replaying.has(params.sessionId) ? "replay"
          : this.#prompts.has(params.sessionId) ? "prompt" : "idle";
        try {
          options.onUpdate?.(params, { phase });
        } catch (error) {
          // A consumer mapping failure is not a transport failure for every session.
          if (options.onUpdateError) options.onUpdateError(error);
          else console.error("[antigravity-acp] native update mapping failed:", error);
        }
      })
      .connect(stream);
  }

  get closed() { return this.#connection.closed; }
  get signal() { return this.#connection.signal; }
  get initialization() { return this.#initialization; }
  get capabilities() { return this.#initialization?.agentCapabilities; }

  initialize(request: InitializeRequest = {
    protocolVersion: PROTOCOL_VERSION,
    clientInfo: { name: "antigravity-acp", version: "0.1.9" },
    clientCapabilities: {},
  }): Promise<InitializeResponse> {
    this.#initializing ??= this.#connection.agent.request(methods.agent.initialize, request)
      .then((response) => {
        this.#initialization = response;
        return response;
      });
    return this.#initializing;
  }

  newSession(request: NewSessionRequest) {
    return this.#connection.agent.request(methods.agent.session.new, request);
  }

  async loadSession(request: LoadSessionRequest) {
    this.#beginReplay(request.sessionId);
    try {
      return await this.#connection.agent.request(methods.agent.session.load, request);
    } finally {
      this.#replaying.delete(request.sessionId);
    }
  }

  async resumeSession(request: ResumeSessionRequest) {
    this.#beginReplay(request.sessionId);
    try {
      return await this.#connection.agent.request(methods.agent.session.resume, request);
    } finally {
      this.#replaying.delete(request.sessionId);
    }
  }

  sessionOptions(request: SessionOptionsRequest) {
    return this.#connection.agent.request(methods.agent.session.options, request);
  }

  setConfigOption(request: SetSessionConfigOptionRequest) {
    return this.#connection.agent.request(methods.agent.session.setConfigOption, request);
  }

  async prompt(
    sessionId: string,
    contentBlocks: ContentBlock[],
    options: { signal?: AbortSignal } = {},
  ): Promise<PromptResponse> {
    options.signal?.throwIfAborted();
    this.#assertIdle(sessionId);
    // Do not pass signal to SDK request: that would abandon the response before
    // session/cancel has stopped generation and returned its final usage.
    const pending: PendingPrompt = {
      response: this.#connection.agent.request(methods.agent.session.prompt, {
        sessionId, prompt: contentBlocks,
      }),
    };
    this.#prompts.set(sessionId, pending);
    const abort = () => {
      void this.cancel(sessionId).catch((error) => this.#connection.close(error));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      return await pending.response;
    } finally {
      options.signal?.removeEventListener("abort", abort);
      this.#prompts.delete(sessionId);
    }
  }

  /** Resolves only after the current prompt settles; retains its response/usage. */
  async cancel(sessionId: string): Promise<PromptResponse | undefined> {
    const pending = this.#prompts.get(sessionId);
    if (!pending) return undefined;
    pending.cancellation ??= (async () => {
      await this.#connection.agent.notify(methods.agent.session.cancel, { sessionId });
      return await pending.response;
    })();
    return pending.cancellation;
  }

  async closeSession(sessionId: string) {
    await this.cancel(sessionId);
    return await this.#connection.agent.request(methods.agent.session.close, { sessionId });
  }

  /** Disconnects only this transport; pending requests reject without retry/replay. */
  async close(error?: unknown): Promise<void> {
    this.#connection.close(error);
    await this.closed;
  }

  #assertIdle(sessionId: string) {
    if (this.#prompts.has(sessionId) || this.#replaying.has(sessionId)) {
      throw new Error(`ACP session ${sessionId} already has a prompt or replay in flight`);
    }
  }

  #beginReplay(sessionId: string) {
    this.#assertIdle(sessionId);
    this.#replaying.add(sessionId);
  }
}

export type AcpSpawn = (
  executable: string,
  argv: string[],
  options: SpawnOptionsWithoutStdio & { stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcessWithoutNullStreams;

export type AcpProcessOptions = AcpConnectionOptions & {
  executable: string;
  cwd: string;
  /** Complete environment supplied by the parent, never merged with process.env. */
  env: NodeJS.ProcessEnv;
  /** Parent-allocated private AGY directory. Never deleted by this facade. */
  geminiDir: string;
  agent?: string;
  processPerSession?: boolean;
  onStderr?: (chunk: string) => void;
  /** Actual directory of this child's logs, learned by the parent/native adapter. */
  logDirectory?: string;
  /** Version-specific parsing stays with the native adapter. Called once, on demand. */
  readNativeHttpPort?: (logDirectory: string, pid: number) => Promise<number>;
  shutdownGraceMs?: number;
  /** Test seam; production uses node:child_process.spawn with shell disabled. */
  spawnProcess?: AcpSpawn;
};

/** Pure argv construction; safe to call while listing models. */
export function buildAcpArgv(options: Pick<
  AcpProcessOptions, "geminiDir" | "agent" | "processPerSession"
>): string[] {
  const argv = [
    // false also disables discovery of the explicitly selected private agent.
    // That agent's excludeDefaultComponents/inheritCustomizations isolate its prompt.
    "acp", "--disable-telemetry", `--include-default-customizations=${Boolean(options.agent)}`,
    `--gemini-dir=${options.geminiDir}`,
  ];
  if (options.agent) argv.push(`--agent=${options.agent}`);
  if (options.processPerSession) argv.push("--process-per-session");
  return argv;
}

/** Owns exactly one spawned child and its ACP connection, never other AGY/Pi pids. */
export class AcpProcess extends AcpConnection {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #options: AcpProcessOptions;
  readonly #exited: Promise<void>;
  #hasExited = false;
  #closing?: Promise<void>;
  #port?: Promise<number>;

  private constructor(child: ChildProcessWithoutNullStreams, options: AcpProcessOptions) {
    super(ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ), options);
    this.#child = child;
    this.#options = options;
    this.#exited = new Promise((done) => {
      child.once("close", () => { this.#hasExited = true; done(); });
    });
    child.on("error", (error) => { void super.close(error); });
    child.once("exit", (code, signal) => {
      this.#hasExited = true;
      void super.close(new Error(`Owned AGY process exited (code=${code}, signal=${signal})`));
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      try { options.onStderr?.(chunk); }
      catch (error) { void super.close(error); }
    });
  }

  /** Spawns only on explicit start. Initialization is an explicit separate call. */
  static async start(options: AcpProcessOptions): Promise<AcpProcess> {
    if (!isAbsolute(options.geminiDir)) throw new Error("geminiDir must be an absolute private directory");
    if (!options.env) throw new Error("A complete parent-owned env is required");
    const child = (options.spawnProcess ?? spawn)(options.executable, buildAcpArgv(options), {
      cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"],
      shell: false, windowsHide: true, detached: process.platform !== "win32",
    }) as ChildProcessWithoutNullStreams;
    const owned = new AcpProcess(child, options);
    try {
      await new Promise<void>((done, fail) => {
        const onSpawn = () => { child.off("error", onError); done(); };
        const onError = (error: Error) => { child.off("spawn", onSpawn); fail(error); };
        child.once("spawn", onSpawn);
        child.once("error", onError);
      });
      return owned;
    } catch (error) {
      await owned.close(error);
      throw error;
    }
  }

  get pid() { return this.#child.pid; }
  get logDirectory() { return this.#options.logDirectory; }

  /** One read, no polling or discovery of unrelated running AGY instances. */
  getNativeHttpPort(): Promise<number> {
    // ACP's per-session front process may replace its worker after load/new.
    if (this.#options.processPerSession) this.#port = undefined;
    this.#port ??= (async () => {
      const { logDirectory, readNativeHttpPort, geminiDir } = this.#options;
      if (!logDirectory || !readNativeHttpPort || this.pid === undefined) {
        throw new Error("Native port requires this child's logDirectory and readNativeHttpPort adapter");
      }
      const path = relative(resolve(geminiDir), resolve(logDirectory));
      if (path === ".." || path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(path)) {
        throw new Error("Native logDirectory must belong to the owned geminiDir");
      }
      const port = await readNativeHttpPort(logDirectory, this.pid);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid native HTTP port: ${port}`);
      }
      return port;
    })();
    return this.#port;
  }

  override close(error?: unknown): Promise<void> {
    this.#closing ??= this.#shutdown(error);
    return this.#closing;
  }

  async #shutdown(error?: unknown): Promise<void> {
    await super.close(error);
    this.#child.stdin.end();
    if (this.#hasExited || this.pid === undefined) {
      await this.#exited;
      return;
    }
    this.#child.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const exited = await Promise.race([
        this.#exited.then(() => true),
        new Promise<false>((done) => {
          timer = setTimeout(() => done(false), this.#options.shutdownGraceMs ?? 2_000);
        }),
      ]);
      if (!exited) {
        this.#child.kill("SIGKILL");
        await this.#exited;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
