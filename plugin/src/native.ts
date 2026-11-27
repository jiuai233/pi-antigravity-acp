import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

/** Version adapter for the loopback control methods missing from ACP 1.5.7. */
export class NativeControl {
  readonly port: number;
  constructor(port: number) { this.port = port; }

  async request(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    const response = await fetch(`http://127.0.0.1:${this.port}/exa.language_server_pb.LanguageServerService/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
      body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(15_000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`AGY ${method} (${response.status}): ${result.message ?? JSON.stringify(result)}`);
    return result;
  }

  async trajectory(conversationId: string): Promise<any> {
    return this.request("GetCascadeTrajectory", {
      cascadeId: conversationId, trajectoryVerbosity: "CLIENT_TRAJECTORY_VERBOSITY_PROD_UI", disableRehydration: true,
    });
  }

  async fork(conversationId: string, stepIndex?: number): Promise<string> {
    const forked = await this.request("ForkConversation", {
      sourceCascadeId: conversationId, ...(stepIndex === undefined ? {} : { forkAtStepIndex: stepIndex }),
      targetForkWorkspace: "FORK_TARGET_CURRENT_WORKSPACE",
    });
    const id = forked.newCascadeId;
    if (typeof id !== "string" || !id) throw new Error("AGY ForkConversation returned no conversation ID.");
    if (stepIndex !== undefined) {
      await this.request("RevertToCascadeStep", { cascadeId: id, stepIndex, conversationOnly: true, suppressErrorStep: true });
    }
    return id;
  }
}

/** Only reads logs in the caller's private AGY home; one read at a control boundary. */
export async function readNativeHttpPort(directory: string, _pid?: number): Promise<number> {
  const names = (await readdir(directory)).filter(name => name.endsWith(".log"));
  const files = await Promise.all(names.map(async name => ({
    name, modified: (await stat(path.join(directory, name), { bigint: true })).mtimeNs,
  })));
  // Worker filenames have second precision and a PID suffix, not creation order.
  files.sort((a, b) => a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : b.name.localeCompare(a.name));
  for (const { name } of files) {
    const text = await readFile(path.join(directory, name), "utf8");
    // Worker logs are later than the ACP front process. Each runtime owns one worker.
    const ports = [...text.matchAll(/listening on random port at (\d+) for HTTP\b/g)];
    if (ports.length) return Number(ports.at(-1)![1]);
  }
  throw new Error("AGY native HTTP port is absent from this runtime's private logs.");
}
