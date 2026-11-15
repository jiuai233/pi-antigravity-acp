import { readFileSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type BridgeToolDef, canonicalToolDefinitions } from "./bridge/bridge.ts";
import { bridgeToolName, bridgeToolNames } from "./bridge/names.ts";

export interface NativeProfile {
  id: "default" | "evidence_only_v1";
  nativeTools: readonly string[];
  bridgeToolAllowlist?: readonly string[];
}

export const DEFAULT_NATIVE_PROFILE: NativeProfile = {
  id: "default",
  nativeTools: ["read_file"],
};

export const EVIDENCE_ONLY_V1_PROFILE: NativeProfile = {
  id: "evidence_only_v1",
  nativeTools: [],
  bridgeToolAllowlist: ["submit_task_result", "submit_review_result"],
};

export const AGY_NATIVE_IDENTITY = [
  "<identity>",
  "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.",
  "You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.",
  "The USER will send you requests, which you must always prioritize addressing.",
  "</identity>",
].join("\n");

interface JsonSchema {
  type?: string;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  const?: unknown;
  items?: JsonSchema;
  required?: string[];
  properties?: Record<string, JsonSchema>;
}

interface TaskEnvelope {
  package_id?: string;
  agent?: { role?: string };
  extensions?: { review_execution?: { profile?: string } };
}

export function nativeAgentName(serverName: string): string {
  return serverName === "acp-tools" ? "acp-agent" : `acp-${serverName}`;
}

/** Only the runner's explicit local worker envelope can select a closed dossier. */
export function readNativeProfile(env: NodeJS.ProcessEnv = process.env): NativeProfile {
  const file = env.PI_WORKER_TASK_PACKAGE_PATH?.trim();
  if (!file || !env.SUBAGENT_PROJECT_ROOT?.trim()) return DEFAULT_NATIVE_PROFILE;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as TaskEnvelope & { task_package?: TaskEnvelope };
    const task = parsed.task_package ?? parsed;
    if (!task.package_id || !task.agent?.role) return DEFAULT_NATIVE_PROFILE;
    return task.extensions?.review_execution?.profile === "evidence_only_v1"
      ? EVIDENCE_ONLY_V1_PROFILE
      : DEFAULT_NATIVE_PROFILE;
  } catch {
    return DEFAULT_NATIVE_PROFILE;
  }
}

export function filterProfileTools<T extends { name: string }>(
  tools: readonly T[],
  profile: NativeProfile,
): T[] {
  const allowlist = profile.bridgeToolAllowlist;
  return allowlist ? tools.filter(tool => allowlist.includes(tool.name)) : [...tools];
}

function parameterHint(schema: JsonSchema = {}): string {
  const variants = schema.anyOf ?? schema.oneOf;
  const values = schema.enum ?? (variants?.every(item => Object.hasOwn(item, "const"))
    ? variants.map(item => item.const) : undefined);
  if (values?.length && values.length <= 5 && values.every(v => v === null || ["string", "number", "boolean"].includes(typeof v))) {
    return values.map(v => JSON.stringify(v)).join("|");
  }
  if (schema.type === "array") {
    const itemHint = parameterHint(schema.items);
    return itemHint ? `${itemHint.includes("|") ? `(${itemHint})` : itemHint}[]` : "";
  }
  return schema.type === "object" && schema.required?.length
    ? `{${schema.required.join(",")}}` : "";
}

/** Restore AGY native <identity> and strip host harness preamble, duplicate bare <tools>, <docs>, and PI_* rules. */
export function buildNativeSystemPrompt(systemPrompt: string): string {
  let text = systemPrompt.replace(/\r\n/g, "\n");
  text = text.replace(/^You are a coding assistant running inside pi,\s*a coding agent harness\.[^\n]*\n*/i, "");
  text = text.replace(/(?:^|\n+)<tools>\n[\s\S]*?\n<\/tools>(?=\n|$)/, "");
  text = text.replace(/(?:^|\n+)<docs>\nPi documentation[\s\S]*?\n<\/docs>(?=\n|$)/, "");
  text = text.replace(/<rules>\n([\s\S]*?)\n<\/rules>/, (_match, inner: string) => {
    const kept = inner
      .split("\n")
      .filter(line => !/^-\s*You can inspect PI_\* environment variables\b/i.test(line.trim()));
    return kept.some(line => line.trim().length > 0) ? `<rules>\n${kept.join("\n")}\n</rules>` : "";
  });
  text = text.replace(/^\n+/, "").trimEnd();
  if (/<identity>[\s\S]*?<\/identity>/.test(text)) return text;
  return text ? `${AGY_NATIVE_IDENTITY}\n\n${text}` : AGY_NATIVE_IDENTITY;
}

/** ACP's MCP descriptor cannot carry timeoutSeconds. Use only this runtime's private config. */
export async function prepareNativeMcpConfig(
  geminiDir: string,
  serverName: string,
  connection: { url: string; token: string } | undefined,
): Promise<void> {
  const directory = path.join(geminiDir, "config");
  await mkdir(directory, { recursive: true });
  const mcpServers = connection ? {
    [serverName]: {
      serverUrl: connection.url,
      headers: { "x-pi-bridge-token": connection.token },
      // Host runner owns completion/cancellation; AGY must not drop all tools after 180s.
      timeoutSeconds: -1,
    },
  } : {};
  await writeFile(path.join(directory, "mcp_config.json"),
    `${JSON.stringify({ mcpServers }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

/** Sync readable JSON Schema files outside gemini/ so mid-turn dynamic tools are immediately readable via read_file. */
export async function syncNativeToolSchemas(
  geminiDir: string,
  tools: readonly BridgeToolDef[],
  serverName: string,
  profile: NativeProfile = DEFAULT_NATIVE_PROFILE,
): Promise<string> {
  const schemaDirectory = path.join(path.dirname(geminiDir), "schemas", serverName);
  if (!profile.nativeTools.includes("read_file")) return schemaDirectory;
  const ordered = canonicalToolDefinitions(filterProfileTools(tools, profile));
  bridgeToolNames(serverName, ordered.map(tool => tool.name), "");
  await mkdir(schemaDirectory, { recursive: true });
  const activeFiles = new Set<string>();
  await Promise.all(ordered.map(async ({ name: toolName, description, parameters }) => {
    const alias = bridgeToolName(serverName, toolName, "");
    const fileName = `${alias}.json`;
    activeFiles.add(fileName);
    await writeFile(
      path.join(schemaDirectory, fileName),
      `${JSON.stringify({ name: alias, targetName: toolName, description, parameters }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }));
  const existing = await readdir(schemaDirectory).catch(() => [] as string[]);
  await Promise.all(
    existing
      .filter(entry => entry.endsWith(".json") && !activeFiles.has(entry))
      .map(entry => rm(path.join(schemaDirectory, entry), { force: true })),
  );
  return schemaDirectory;
}

/** Reuses AGY's custom-agent frontmatter in this runtime's private Gemini home, plus readable tool schemas outside gemini/. */
export async function prepareNativeAgent(
  geminiDir: string,
  systemPrompt: string,
  tools: BridgeToolDef[],
  serverName: string,
  profile: NativeProfile = DEFAULT_NATIVE_PROFILE,
): Promise<string> {
  const name = nativeAgentName(serverName);
  const directory = path.join(geminiDir, "config", "agents", name);
  await mkdir(directory, { recursive: true });

  const ordered = canonicalToolDefinitions(filterProfileTools(tools, profile));
  bridgeToolNames(serverName, ordered.map(tool => tool.name), "");

  // call_mcp_tool is a dynamically injected MCP transport, not a builtin
  // tool component; listing it here makes executor construction fail.
  const nativeTools = profile.nativeTools;

  let bridgeSection = "";
  if (ordered.length > 0) {
    const catalog = ordered.map(({ name: toolName, description, parameters }) => {
      const schema = parameters as JsonSchema | undefined;
      const required = new Set(schema?.required ?? []);
      const fields = Object.entries(schema?.properties ?? {}).map(([field, fieldSchema]) => {
        const hint = parameterHint(fieldSchema);
        return `${field}${required.has(field) ? "" : "?"}${hint ? `:${hint}` : ""}`;
      });
      const alias = bridgeToolName(serverName, toolName, "");
      const origin = alias === toolName ? "" : ` [target: ${toolName}]`;
      const cleaned = description.trim();
      return `- ${alias}(${fields.join(", ")})${cleaned ? `: ${cleaned}` : ""}${origin}`;
    }).join("\n");

    if (!nativeTools.includes("read_file")) {
      const inlineSchemas = ordered.map(({ name: toolName, description, parameters }) => ({
        name: bridgeToolName(serverName, toolName, ""),
        targetName: toolName,
        description,
        parameters,
      }));
      bridgeSection = [
        "",
        "<acp_tool_bridge>",
        `请通过 \`call_mcp_tool\` 提交结果：\`ServerName: "${serverName}"\`，\`ToolName: "<目录中的名称>"\`。\`Arguments\` 只填写该工具自己的参数（不要加入 AGY 顶层的 \`toolSummary\` 封装字段）。完整 Schema 已内联在下方，请直接使用给定卷宗，不要额外读取文件。`,
        "<acp_tool_schemas>",
        JSON.stringify(inlineSchemas),
        "</acp_tool_schemas>",
        "</acp_tool_bridge>",
        "",
        "<acp_active_tools>",
        "当前闭卷可用的提交工具：",
        catalog,
        "</acp_active_tools>",
      ].join("\n");
    } else {
      const schemaDirectory = await syncNativeToolSchemas(geminiDir, ordered, serverName, profile);
      const schemaFile = JSON.stringify(path.join(schemaDirectory, "<目录中的名称>.json"));
      const hasCodemode = ordered.some(tool => tool.name === "codemode");
      const codemodeParagraph = hasCodemode
        ? `\n需要合并多个独立调用、串接工具或筛选大段输出时，优先通过 \`call_mcp_tool\` 调用 \`codemode\`（\`ServerName: "${serverName}"\`，\`ToolName: "codemode"\`，\`Arguments: { code: "<异步 JS 函数体>" }\`），各工具的 \`Codemode:\` 返回值约定与沙箱全局对象见下方目录。`
        : "";
      bridgeSection = [
        "",
        "<acp_tool_bridge>",
        `当前工作区工具通过 ACP 挂载在 MCP 服务 "${serverName}" 下，统一经 \`call_mcp_tool\` 调用：\`ServerName: "${serverName}"\`，\`ToolName: "<目录中的名称>"\`，\`Arguments: <工具参数对象>\`。`,
        `\`Arguments\` 只填写该工具自己的参数，不要加入 AGY 顶层的 \`toolSummary\` 封装字段；除非你的工具声明里明确出现了 \`mcp_${serverName}_<目录中的名称>\`，不要在顶层直接裸调目录中的工具名。${codemodeParagraph}`,
        `日常直接按下方目录中的参数签名和完整说明调用；仅当需要签名里未展开的嵌套 JSON Schema 细节时，再用原生 \`read_file\` 读取 ${schemaFile}。`,
        "</acp_tool_bridge>",
        "",
        "<acp_active_tools>",
        "当前可用工具目录（? 表示可选参数）：",
        catalog,
        "</acp_active_tools>",
      ].join("\n");
    }
  }

  const normalizedSystem = buildNativeSystemPrompt(systemPrompt);
  const body = `${normalizedSystem}${bridgeSection ? `\n${bridgeSection}` : ""}\n`;
  const content = `---\nname: ${name}\ndescription: Antigravity ACP execution agent.\nmainAgent: true\nsubagent: false\nexcludeDefaultComponents: true\ninheritCustomizations: false\ntools: [${nativeTools.join(", ")}]\n---\n\n${body}`;
  await writeFile(path.join(directory, "agent.md"), content, { encoding: "utf8", mode: 0o600 });
  return name;
}
