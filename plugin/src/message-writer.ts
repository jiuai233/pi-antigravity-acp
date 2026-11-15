import { isContextOverflow, type AssistantMessage, type AssistantMessageEventStream, type ToolCall } from "@earendil-works/pi-ai";

export const NATIVE_FAILURE_SUMMARY = "AGY 原生调用失败，内部恢复已结束；原始错误见本条消息。";

/** Pi's standard block events; ACP text and public thoughts stay distinct. */
export class MessageWriter {
  private index = -1;
  private kind: "text" | "thinking" | undefined;
  private buffer = "";
  readonly output: AssistantMessage;
  readonly stream: AssistantMessageEventStream;
  constructor(output: AssistantMessage, stream: AssistantMessageEventStream) {
    this.output = output;
    this.stream = stream;
  }

  start(): void { this.stream.push({ type: "start", partial: this.output }); }

  diagnostic(entry: NonNullable<AssistantMessage["diagnostics"]>[number]): void {
    this.output.diagnostics ??= [];
    this.output.diagnostics.push(entry);
  }

  append(kind: "text" | "thinking", delta: string): void {
    if (!delta) return;
    if (this.kind !== kind) {
      this.closeBlock();
      this.kind = kind;
      this.index = this.output.content.length;
      this.output.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
      if (kind === "text") this.stream.push({ type: "text_start", contentIndex: this.index, partial: this.output });
      else this.stream.push({ type: "thinking_start", contentIndex: this.index, partial: this.output });
    }
    this.buffer += delta;
    const block = this.output.content[this.index];
    if (block.type === "text") {
      block.text = this.buffer;
      this.stream.push({ type: "text_delta", contentIndex: this.index, delta, partial: this.output });
    } else if (block.type === "thinking") {
      block.thinking = this.buffer;
      this.stream.push({ type: "thinking_delta", contentIndex: this.index, delta, partial: this.output });
    }
  }

  closeBlock(): void {
    if (this.kind === "text") this.stream.push({ type: "text_end", contentIndex: this.index, content: this.buffer, partial: this.output });
    else if (this.kind === "thinking") this.stream.push({ type: "thinking_end", contentIndex: this.index, content: this.buffer, partial: this.output });
    this.kind = undefined;
    this.buffer = "";
    this.index = -1;
  }

  tool(call: ToolCall): void {
    this.closeBlock();
    const index = this.output.content.length;
    this.output.content.push(call);
    this.stream.push({ type: "toolcall_start", contentIndex: index, partial: this.output });
    this.stream.push({ type: "toolcall_end", contentIndex: index, toolCall: call, partial: this.output });
  }

  finish(reason: "stop" | "toolUse" | "length"): void {
    this.closeBlock();
    this.output.stopReason = reason;
    this.stream.push({ type: "done", reason, message: this.output });
    this.stream.end();
  }

  fail(error: unknown, aborted = false): void {
    this.output.stopReason = aborted ? "aborted" : "error";
    const original = error instanceof Error ? error.message : String(error);
    this.output.errorMessage = original;
    // Pi classifies errorMessage text. Native terminal failures have already
    // completed AGY's recovery policy; keep their details outside that summary.
    if (!aborted && this.output.diagnostics?.some(entry => entry.type === "agy_acp_native_error")
      && !isContextOverflow(this.output)) {
      this.append("text", `\n\nAGY 原始错误（未修改）：\n${original}`);
      this.diagnostic({ type: "agy_acp_native_recovery_finished", timestamp: Date.now(), error: { message: original } });
      this.output.errorMessage = NATIVE_FAILURE_SUMMARY;
    }
    this.closeBlock();
    this.stream.push({ type: "error", reason: this.output.stopReason, error: this.output });
    this.stream.end();
  }
}
