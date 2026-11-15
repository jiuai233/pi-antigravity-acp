import path from "node:path";
import { registerSessionResourceCleanup, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ModelCatalog } from "./src/model-catalog.ts";
import { toProviderModel } from "./src/models.ts";
import { isPatchedMacBinary, resolveBinary } from "./src/platform.ts";
import { AgyPrefixAudit, PREFIX_AUDIT_ENTRY } from "./src/prefix-audit.ts";
import { ensureAgyQuotaBridge } from "./src/quota.ts";
import { AcpRuntime, API, BINDING_ENTRY, type Binding, PROVIDER, RESET_ENTRY } from "./src/runtime.ts";
import { openAgyUsagePicker } from "./src/usage-ui.ts";

type StreamOptionsWithIdentity = SimpleStreamOptions & { requestIdentity?: { requestKind?: string } };

export default function antigravityAcpExtension(pi: ExtensionAPI): void {
  if (process.platform === "darwin" && !process.env.AGY_BINARY && isPatchedMacBinary()) {
    process.env.AGY_CLI_DISABLE_AUTO_UPDATE ??= "true";
  }
  let context: ExtensionContext | undefined;
  let auditUI: ExtensionUIContext | undefined;
  const runtimes = new Map<string, AcpRuntime>();
  const pendingBindings = new Map<string, Binding>();
  let summarySequence = 0;
  let unregisterCleanup: (() => void) | undefined;
  const refreshAuditStatus = () => {
    try { auditUI?.setStatus?.("agy-cache", audit.summary()); }
    catch { /* The UI may have detached; durable diagnostics remain available. */ }
  };
  const audit = new AgyPrefixAudit(event => {
    pi.appendEntry(PREFIX_AUDIT_ENTRY, event);
  }, refreshAuditStatus);
  const ensureCleanup = () => {
    unregisterCleanup ??= registerSessionResourceCleanup(sessionId => {
      const selected = [...runtimes.entries()].filter(([id]) => !sessionId || id === sessionId || id.startsWith(`${sessionId}:compaction:`));
      void Promise.allSettled(selected.map(([, runtime]) => runtime.close())).then(() => {
        for (const [id] of selected) runtimes.delete(id);
        if (!runtimes.size) { unregisterCleanup?.(); unregisterCleanup = undefined; }
      });
    });
  };
  const key = () => context?.sessionManager.getSessionId() ?? "unbound-sdk";
  const stateRoot = () => process.env.AGY_ACP_STATE_DIR ?? path.join(getAgentDir(), "antigravity-acp");
  const catalog = new ModelCatalog(stateRoot());
  ensureAgyQuotaBridge().configureDefaults({
    stateRoot,
    cwd: () => context?.cwd ?? process.cwd(),
    binary: resolveBinary,
  });
  const create = (id: string, persist: boolean) => new AcpRuntime({
    cwd: context?.cwd ?? process.cwd(), sessionKey: id,
    stateDirectory: path.join(stateRoot(), encodeURIComponent(id)),
    onBinding: persist ? binding => pendingBindings.set(id, binding) : undefined,
    onLocalPrefix: persist ? ({ systemPrompt, tools, agentName, agentBody }) => {
      if (key() === id) audit.recordLocal(systemPrompt, tools, { name: agentName, agentBody });
    } : undefined,
    onSampleNative: persist ? ({ conversationId, geminiDir }) => {
      if (key() === id) audit.sample(conversationId, geminiDir);
    } : undefined,
    onNativeTool: persist ? activity => {
      // appendEntry targets the current Pi session, not an arbitrary runtime ID.
      if (context && key() === id) pi.appendEntry("pi-native-tool", activity);
    } : undefined,
  });
  const current = () => {
    const id = key();
    let runtime = runtimes.get(id);
    if (!runtime) { runtime = create(id, true); runtimes.set(id, runtime); }
    return runtime;
  };

  const register = () => pi.registerProvider(PROVIDER, {
    name: "Antigravity ACP", api: API, baseUrl: "agy://native-acp", apiKey: "agy-native-session",
    models: catalog.models.map(toProviderModel),
    streamSimple(model, transcript, options) {
      if ((options as StreamOptionsWithIdentity | undefined)?.requestIdentity?.requestKind === "compaction") {
        const id = `${key()}:compaction:${++summarySequence}`;
        const isolated = create(id, false);
        runtimes.set(id, isolated);
        const stream = isolated.stream(model, transcript, options);
        void stream.result().then(() => isolated.close(), () => isolated.close()).finally(() => runtimes.delete(id)).catch(error => {
          console.warn("[antigravity-acp] summary cleanup:", error);
        });
        return stream;
      }
      return current().stream(model, transcript, options);
    },
  });
  register();

  const refreshModels = async (ctx: ExtensionContext, force = false) => {
    if (!force && (ctx.model?.provider !== PROVIDER || catalog.isFresh())) return;
    const cache = await catalog.refresh();
    register();
    if (cache.discoveryError) {
      const detail = cache.discoveryError instanceof Error ? cache.discoveryError.message : String(cache.discoveryError);
      ctx.ui.notify(`AGY 模型刷新失败：${detail}；保留 ${cache.models.length} 个${cache.source === "live" ? "上次成功" : "内置"}模型。`, "warning");
    } else if (cache.cacheWriteError) {
      ctx.ui.notify(`已刷新 ${cache.models.length} 个 AGY 模型，但缓存写入失败：${String(cache.cacheWriteError)}`, "warning");
    } else if (force) ctx.ui.notify(`已从 AGY 刷新 ${cache.models.length} 个模型并保存。`, "info");
  };

  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    pendingBindings.delete(key());
    const branch = ctx.sessionManager.getBranch();
    current().restore(branch);
    auditUI = ctx.hasUI && ctx.model?.provider === PROVIDER ? ctx.ui : undefined;
    audit.restore(branch, RESET_ENTRY);
    ensureCleanup();
    await refreshModels(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    context = ctx;
    pendingBindings.delete(key());
    const branch = ctx.sessionManager.getBranch();
    current().restore(branch);
    auditUI = ctx.hasUI && ctx.model?.provider === PROVIDER ? ctx.ui : undefined;
    audit.restore(branch, RESET_ENTRY);
  });
  pi.on("before_agent_start", async (_event, ctx) => { context = ctx; await refreshModels(ctx); });
  pi.on("session_compact", (_event, ctx) => { context = ctx; current().invalidateProjection(); });
  pi.on("turn_end", (_event, ctx) => {
    context = ctx;
    const binding = pendingBindings.get(key());
    if (!binding) return;
    const entry = ctx.sessionManager.getBranch().findLast((entry: any) => entry.type === "message"
      && entry.message?.role === "assistant" && entry.message.provider === PROVIDER);
    pi.appendEntry(BINDING_ENTRY, { ...binding, piEntryId: entry?.id });
    pendingBindings.delete(key());
  });
  pi.on("model_select", async (event, ctx) => {
    context = ctx;
    try { ctx.ui.setStatus?.("agy-cache", undefined); } catch { /* Detached UI is not a model failure. */ }
    auditUI = ctx.hasUI && event.model.provider === PROVIDER ? ctx.ui : undefined;
    refreshAuditStatus();
    // Leaving the provider while its MCP prompt waits must stop that prompt.
    if (event.model.provider !== PROVIDER) await runtimes.get(key())?.stopNative();
    else await refreshModels(ctx);
  });
  pi.on("session_shutdown", async () => {
    try { auditUI?.setStatus?.("agy-cache", undefined); } catch { /* Shutdown must continue after UI detach. */ }
    auditUI = undefined;
    await Promise.allSettled([...runtimes.values()].map(runtime => runtime.close()));
    runtimes.clear();
    unregisterCleanup?.(); unregisterCleanup = undefined;
  });
  pi.registerCommand("agy-usage", {
    description: "查看 Antigravity 模型额度（5 小时与周额度）",
    handler: async (args, ctx) => {
      context = ctx;
      if (args.trim()) {
        ctx.ui.notify('agy-usage: 用法 "/agy-usage"。', "error");
        return;
      }
      await openAgyUsagePicker(ctx);
    },
  });
  const ACP_SUBCOMMANDS = [
    { value: "status", label: "status", description: "查看当前 ACP 会话绑定与上次缓存命中" },
    { value: "cache", label: "cache", description: "查看详细前缀与原生采样审计" },
    { value: "doctor", label: "doctor", description: "查看本地运行时、模型目录与审计诊断" },
    { value: "models", label: "models", description: "手动从 AGY 刷新可用模型目录" },
    { value: "reset", label: "reset", description: "停止原生执行并清除 ACP 会话绑定" },
  ];
  pi.registerCommand("agy-acp", {
    description: "查看 ACP 原生会话；cache 查看缓存审计，reset 重建原生会话，doctor 本地诊断，models 刷新模型目录。",
    getArgumentCompletions: argumentPrefix => {
      const prefix = argumentPrefix.trim().toLowerCase();
      const matches = ACP_SUBCOMMANDS.filter(item => item.value.startsWith(prefix));
      return matches.length ? matches : null;
    },
    handler: async (args, ctx) => {
      context = ctx;
      const command = args.trim();
      if (command === "models") {
        await refreshModels(ctx, true);
      } else if (command === "cache") {
        ctx.ui.notify(audit.details().join("\n"), "info");
      } else if (command === "reset") {
        await ctx.abort();
        await ctx.waitForIdle();
        await current().reset();
        pendingBindings.delete(key());
        audit.reset();
        pi.appendEntry(RESET_ENTRY, { version: 1, timestamp: Date.now() });
        ctx.ui.notify("已清除 ACP 原生绑定。Pi 历史保留；下次输入将新建原生会话，不回灌旧对话。", "info");
      } else if (command === "doctor") {
        ctx.ui.notify(JSON.stringify({
          runtime: current().diagnostics(),
          catalog: catalog.diagnostics(),
          prefixAudit: { summary: audit.summary(), details: audit.details() },
        }, null, 2), "info");
      } else if (command && command !== "status") {
        ctx.ui.notify("用法：/agy-acp [status|cache|reset|doctor|models]", "info");
      } else {
        const binding = current().snapshot();
        ctx.ui.notify(binding
          ? `AGY ACP ${binding.conversationId} · ${binding.model} · native step ${binding.stepIndex ?? "未知"}\n${audit.summary()}`
          : `AGY ACP 尚未建立原生执行会话。\n${audit.summary()}`, "info");
      }
    },
  });
}
