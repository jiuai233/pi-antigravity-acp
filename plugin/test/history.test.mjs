import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import {
  buildNativeHistory, nativeTrajectorySchema, writeNativeHistory,
} from "../src/history.ts";
import { bridgeToolName } from "../src/bridge/names.ts";

const model = {
  type: "chat", id: "history-target", name: "History fixture", api: "fixture-api", provider: "fixture",
  input: ["text", "image"], reasoning: true, baseUrl: "", contextWindow: 10000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const options = { cwd: process.cwd(), serverName: "fixture_pi_tools" };
const usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const user = (text) => ({ role: "user", content: text, timestamp: 1001 });
const assistant = (content, overrides = {}) => ({
  role: "assistant", content, api: "foreign-api", provider: "foreign-provider", model: "foreign-model",
  usage, stopReason: "toolUse", timestamp: 2002, ...overrides,
});
const call = (id = "real-call|full-provider-id", name = "fixture_read", args = { path: "not-executed", nested: { n: 7 } }) => ({
  type: "toolCall", id, name, arguments: args, thoughtSignature: "FOREIGN_SIGNATURE_NOT_TO_IMPORT",
});
const result = (id = "real-call|full-provider-id", text = "TOOL_ONLY_MARKER_7319", overrides = {}) => ({
  role: "toolResult", toolCallId: id, toolName: "fixture_read", content: [{ type: "text", text }],
  isError: false, timestamp: 3003, ...overrides,
});
const json = (history) => toJson(nativeTrajectorySchema, fromBinary(nativeTrajectorySchema, history.bytes));
const build = (messages, extra = {}) => buildNativeHistory(messages, model, { ...options, ...extra });
const code = (expected) => (error) => error?.code === expected;
function freeze(value) {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}


// These are codec tests only. They neither spawn AGY nor execute tools/model requests.
test("imports independent user/tool markers and complete calls without mutating Pi input", () => {
  const messages = [
    { role: "system", content: "SYSTEM_NOT_A_USER_MESSAGE", toolsAdded: [], timestamp: 1 },
    user("USER_ONLY_MARKER_8642"),
    assistant([{ type: "text", text: "Assistant正文" }, call()]), result(),
    assistant([{ type: "text", text: "final reply" }], { stopReason: "stop" }),
  ];
  const snapshot = structuredClone(messages);
  freeze(messages);
  const history = build(messages);
  const decoded = json(history);
  assert.deepEqual(messages, snapshot);
  assert.equal(decoded.steps.length, 4);
  assert.equal(decoded.steps[0].userInput.userResponse, "USER_ONLY_MARKER_8642");
  assert.equal(decoded.steps[0].userInput.items[0].text, "USER_ONLY_MARKER_8642");
  assert.equal(decoded.steps[1].plannerResponse.response, "Assistant正文");
  const nativeCall = decoded.steps[1].plannerResponse.toolCalls[0];
  assert.equal(nativeCall.id, messages[2].content[1].id);
  assert.equal(nativeCall.name, "call_mcp_tool");
  assert.deepEqual(JSON.parse(nativeCall.argumentsJson), {
    ServerName: "fixture_pi_tools",
    ToolName: "fixture_read",
    Arguments: messages[2].content[1].arguments,
  });
  assert.deepEqual(decoded.steps[2].mcpTool.toolCall, nativeCall);
  assert.deepEqual(decoded.steps[2].metadata.toolCall, nativeCall);
  assert.equal(decoded.steps[2].mcpTool.serverName, "fixture_pi_tools");
  assert.equal(decoded.steps[2].mcpTool.resultString, "TOOL_ONLY_MARKER_7319");
  assert.equal(decoded.metadata.projectId, "default-cli-project");
  assert.deepEqual(decoded.metadata.workspaceUris, [pathToFileURL(options.cwd).href]);
  assert.equal(history.trajectory.steps[0].metadata.createdAt.seconds, 1n);
  assert.equal(history.trajectory.steps[0].metadata.createdAt.nanos, 1_000_000);
  assert.deepEqual(history.messageStepBoundaries, [
    { messageIndex: 0, stepStart: 0, stepEnd: 0 }, { messageIndex: 1, stepStart: 0, stepEnd: 1 },
    { messageIndex: 2, stepStart: 1, stepEnd: 2 }, { messageIndex: 3, stepStart: 2, stepEnd: 3 },
    { messageIndex: 4, stepStart: 3, stepEnd: 4 },
  ]);
  assert.ok(!Buffer.from(history.bytes).includes(Buffer.from("SYSTEM_NOT_A_USER_MESSAGE")));
});

test("cross-model and same-model thinking/signatures never become native body or signature", () => {
  for (const identity of [{}, { api: model.api, provider: model.provider, model: model.id }]) {
    const messages = [user("question"), assistant([
      { type: "thinking", thinking: "PUBLIC_THOUGHT_NOT_BODY", thinkingSignature: "OPAQUE_FOREIGN_REASONING" },
      { type: "text", text: "Visible text", textSignature: "TEXT_SIGNATURE" }, call(),
    ], identity), result()];
    const h = build(messages);
    const decoded = json(h);
    assert.equal(decoded.steps[1].plannerResponse.response, "Visible text");
    assert.equal(decoded.steps[1].plannerResponse.toolCalls[0].id, decoded.steps[2].mcpTool.toolCall.id);
    for (const secret of ["PUBLIC_THOUGHT_NOT_BODY", "OPAQUE_FOREIGN_REASONING", "FOREIGN_SIGNATURE_NOT_TO_IMPORT", "TEXT_SIGNATURE"]) {
      assert.ok(!Buffer.from(h.bytes).includes(Buffer.from(secret)));
    }
  }
});

test("real user and tool media survive protobuf with the descriptor's independent media fields", () => {
  const imageBytes = Buffer.from([137, 80, 78, 71, 0, 11, 12, 13]);
  const image = { type: "image", data: imageBytes.toString("base64"), mimeType: "image/png" };
  const h = build([
    { ...user(""), content: [{ type: "text", text: "image input" }, image] },
    assistant([call()]), result(undefined, "image result", { content: [{ type: "text", text: "image result" }, image] }),
  ]);
  const decoded = json(h);
  assert.deepEqual(decoded.steps[0].userInput.media, [{ mimeType: "image/png", inlineData: image.data }]);
  assert.deepEqual(decoded.steps[2].mcpTool.media, [{ mimeType: "image/png", inlineData: image.data }]);
  assert.ok(!("images" in decoded.steps[0].userInput));
  assert.ok(!("images" in decoded.steps[2].mcpTool));
  assert.deepEqual(Buffer.from(h.trajectory.steps[0].step.value.media[0].payload.value), imageBytes);
  assert.deepEqual(Buffer.from(h.trajectory.steps[2].step.value.media[0].payload.value), imageBytes);
});

test("history media is preserved even when a local model record lacks image capability", () => {
  for (const messages of [[{...user(""), content: [{type: "image", data: " aGk\n", mimeType: "image/png"}]}],
    [assistant([call()]), result(undefined, "", {content: [{type: "image", data: "aGk", mimeType: "image/png"}]})]]) {
    const decoded = json(buildNativeHistory(messages, {...model, input: ["text"]}, options));
    const media = decoded.steps.at(-1).userInput?.media ?? decoded.steps.at(-1).mcpTool.media;
    assert.equal(media[0].inlineData, "aGk=");
  }
});
test("resources, audio and assistant media retain actual content without a preflight whitelist", () => {
  const resource = {type: "resource", uri: "file:///not-read", text: "RESOURCE_MARKER"};
  const audio = {type: "audio", data: "aGk", mimeType: "audio/wav"};
  const decoded = json(build([{...user(""), content: [resource, audio]}]));
  assert.ok(decoded.steps[0].userInput.userResponse.includes("RESOURCE_MARKER"));
  assert.equal(decoded.steps[0].userInput.media[0].inlineData, "aGk=");
  const image = {type: "image", data: "aGk=", mimeType: "image/png"};
  assert.ok(json(build([assistant([image])])).steps[0].plannerResponse.response.includes("aGk="));
});
test("ERROR, CANCELED and INVALID are not forged DONE; error payload preserves actual result", () => {
  for (const [status, numeric] of [["error", 7], ["canceled", 6], ["invalid", 4]]) {
    const messages = [assistant([call()]), result(undefined, "actual failure/cancellation", { isError: true })];
    const decoded = json(build(messages, { toolResultStatus: () => status }));
    assert.equal(decoded.steps[0].status, 3);
    assert.equal(decoded.steps[1].status, numeric);
    assert.equal(decoded.steps[1].mcpTool.resultString, "actual failure/cancellation");
    assert.equal(decoded.steps[1].error.modelErrorMessage, "actual failure/cancellation");
  }
  const defaults = json(build([assistant([call()]), result(undefined, "failed", { isError: true })]));
  assert.equal(defaults.steps[1].status, 7);
  assert.throws(() => build([assistant([call()]), result(undefined, "failed", { isError: true })], {
    toolResultStatus: () => "done",
  }), code("invalid_tool_status"));
});

test("Pi helper filters error/aborted assistants, not inventing successful native partial responses", () => {
  const messages = [user("keep"),
    assistant([{ type: "text", text: "FAILED_PARTIAL" }, call()], { stopReason: "error" }),
    assistant([{ type: "text", text: "ABORTED_PARTIAL" }], { stopReason: "aborted" }),
    assistant([{ type: "text", text: "PENDING_PARTIAL" }], { stopReason: "pending" }),
    assistant([{ type: "text", text: "valid final" }], { stopReason: "stop" }),
  ];
  const h = build(messages);
  const decoded = json(h);
  assert.equal(decoded.steps.length, 2);
  assert.equal(decoded.steps[1].plannerResponse.response, "valid final");
  assert.deepEqual(h.messageStepBoundaries.map((b) => b.stepEnd - b.stepStart), [1, 0, 0, 0, 1]);
  assert.ok(!Buffer.from(h.bytes).includes(Buffer.from("PARTIAL")));
});

for (const stopReason of ['error', 'aborted', 'pending', 'deferred']) test(`skips ${stopReason} assistant/result pairs but keeps accepted executions`, () => {
  const messages = [user("question"), assistant([call()], {stopReason}), result(),
    user("valid continuation"), assistant([call("accepted")]), result("accepted", "ACCEPTED_RESULT")];
  const decoded = json(build(messages));
  assert.equal(decoded.steps.filter(s => s.mcpTool).length, 1);
  assert.equal(decoded.steps.at(-1).mcpTool.resultString, "ACCEPTED_RESULT");
  assert.throws(() => build([user("question"), assistant([call()], {stopReason}),
    result(undefined, "wrong name", {toolName: "other"})]), code("unmatched_tool_result"));
  assert.throws(() => build([assistant([call()], {stopReason}), result(), result()]), code("unmatched_tool_result"));
});

test("does not encode Pi's synthetic missing results or invent a call for orphan results", () => {
  const h = build([user("question"), assistant([call()]), user("interrupt")]);
  const decoded = json(h);
  assert.equal(decoded.steps.length, 3);
  assert.ok(!decoded.steps.some((step) => step.mcpTool));
  assert.ok(!Buffer.from(h.bytes).includes(Buffer.from("No result provided")));
  assert.throws(() => build([result()]), code("unmatched_tool_result"));
  assert.throws(() => build([assistant([call()]), result(undefined, "bad name", { toolName: "other" })]), code("unmatched_tool_result"));
  assert.throws(() => build([assistant([call()]), result(), result()]), code("unmatched_tool_result"));
});

test("parallel calls preserve result order, each real ID/name/args, and system is transparent", () => {
  const a = call("parallel-a");
  const b = call("parallel-b", "fixture_read", { path: "b", list: [1, true, null, "汉字"] });
  const h = build([assistant([a, b]), { role: "system", content: "system update", timestamp: 2 },
    result("parallel-b", "B"), result("parallel-a", "A")]);
  const decoded = json(h);
  assert.equal(decoded.steps.length, 3);
  assert.deepEqual(decoded.steps.slice(1).map((s) => s.mcpTool.toolCall.id), ["parallel-b", "parallel-a"]);
  assert.deepEqual(JSON.parse(decoded.steps[1].mcpTool.toolCall.argumentsJson), {
    ServerName: "fixture_pi_tools",
    ToolName: "fixture_read",
    Arguments: b.arguments,
  });
  assert.throws(() => build([assistant([a, a])]), code("duplicate_tool_call"));
});

test("codemode and long tool names import as call_mcp_tool with deterministic bridge aliases", () => {
  const longName = "very_long_tool_name_exceeding_agy_cli_budget_for_mcp_prefix_check";
  const cmCall = call("cm-1", "codemode", { code: "return await tools.read({ path: 'a.txt' });" });
  const longCall = call("long-1", longName, { flag: true });
  const h = build([
    user("batch read"),
    assistant([cmCall, longCall]),
    result("cm-1", "Script completed", { toolName: "codemode" }),
    result("long-1", "LONG_OK", { toolName: longName }),
  ]);
  const decoded = json(h);
  const plannerCalls = decoded.steps[1].plannerResponse.toolCalls;
  assert.deepEqual(plannerCalls.map((c) => c.name), ["call_mcp_tool", "call_mcp_tool"]);
  assert.deepEqual(JSON.parse(plannerCalls[0].argumentsJson), {
    ServerName: "fixture_pi_tools",
    ToolName: "codemode",
    Arguments: cmCall.arguments,
  });
  assert.deepEqual(JSON.parse(plannerCalls[1].argumentsJson), {
    ServerName: "fixture_pi_tools",
    ToolName: bridgeToolName("fixture_pi_tools", longName, ""),
    Arguments: { flag: true },
  });
  assert.deepEqual(decoded.steps[2].mcpTool.toolCall, plannerCalls[0]);
  assert.deepEqual(decoded.steps[3].mcpTool.toolCall, plannerCalls[1]);
});

test("protobuf binary round trip preserves history with a fresh import UUID", () => {
  const messages = [user("one"), assistant([call()]), result()];
  const a = build(messages), b = build(messages);
  assert.notEqual(a.conversationId, b.conversationId);
  assert.equal(a.trajectory.cascadeId, a.conversationId);
  assert.deepEqual(toBinary(nativeTrajectorySchema, fromBinary(nativeTrajectorySchema, a.bytes)), a.bytes);
});
test("accepts caller-verified native configuration without any warm-up; refuses relative cwd", () => {
  const decoded = json(build([user("configured")], { nativeConfig: { planModel: 12345, useCoreDirect: true } }));
  assert.deepEqual(decoded.steps[0].userInput.userConfig, {
    plannerConfig: { planModel: 12345 }, executorConfig: { useCoreDirect: true },
    dynamicWorkspaceUris: [pathToFileURL(options.cwd).href],
  });
  assert.throws(() => build([user("relative")], { cwd: "relative" }), code("invalid_cwd"));
});

function nativeAgentFixture(system = "NATIVE_COMPILED_SYSTEM_MARKER\n\n<cwd>/owned/workspace</cwd>") {
  const agentConfig = {
    mixinConfig: {
      promptSections: [{ custom: { title: "System Prompt", content: system } }],
      tools: [{ name: "read_file", builtin: true }],
      postInvocationHooks: ["message_continue_check", "terminal_step_check", "max_generator_invocations_check",
        "empty_output_continuation_check", "force_invocation", "no_tool_call_check"].map((name) => ({ name, builtin: true })),
    },
    customizationDiscovery: {
      skills: { inheritUser: false }, agents: { inheritUser: false }, plugins: { inheritUser: false },
      rules: { inheritUser: false }, hooks: { inheritUser: false }, agentPath: "file:///owned/agent.md",
    },
  };
  return {
    staticConfig: { agentConfig, customizationConfig: { agentPath: "file:///owned/agent.md" } },
    agentScript: {
      name: "pi-acp-pi-acp", description: "Pi-owned ACP execution agent.", subagent: false, mainAgent: true,
      config: { agentConfig: structuredClone(agentConfig) },
    },
  };
}

test("native compiled metadata preserves system-only placement, whitelist and optional false presence", () => {
  const nativeAgentMetadata = nativeAgentFixture();
  const messages = [
    { role: "system", content: "NATIVE_COMPILED_SYSTEM_MARKER", timestamp: 1 },
    user("Pi message without agent configuration"), assistant([call()]), result(),
  ];
  const snapshot = structuredClone(messages);
  const metadataSnapshot = structuredClone(nativeAgentMetadata);
  freeze(messages);
  freeze(nativeAgentMetadata);
  const h = build(messages, { nativeAgentMetadata });
  const decoded = json(h);
  assert.deepEqual(messages, snapshot);
  assert.deepEqual(nativeAgentMetadata, metadataSnapshot);
  assert.deepEqual(decoded.metadata.staticConfig, metadataSnapshot.staticConfig);
  assert.deepEqual(decoded.metadata.agentScript, metadataSnapshot.agentScript);
  assert.deepEqual(decoded.metadata.workspaceUris, [pathToFileURL(options.cwd).href]);
  assert.equal(decoded.metadata.rootConversationId, undefined);
  assert.equal(decoded.metadata.agentScript.subagent, false);
  assert.ok(Object.hasOwn(decoded.metadata.agentScript, "subagent"));
  const locations = [];
  function visit(value, path = "") {
    if (typeof value === "string" && value.includes("NATIVE_COMPILED_SYSTEM_MARKER")) locations.push(path);
    else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
    }
  }
  visit(decoded);
  assert.deepEqual(locations.sort(), [
    ".metadata.agentScript.config.agentConfig.mixinConfig.promptSections.0.custom.content",
    ".metadata.staticConfig.agentConfig.mixinConfig.promptSections.0.custom.content",
  ]);
  assert.equal(Buffer.from(h.bytes).toString("utf8").split("NATIVE_COMPILED_SYSTEM_MARKER").length - 1, 2);
  for (const config of [decoded.metadata.staticConfig.agentConfig, decoded.metadata.agentScript.config.agentConfig]) {
    assert.deepEqual(config.mixinConfig.tools, [{ name: "read_file", builtin: true }]);
    assert.deepEqual(config.mixinConfig.postInvocationHooks, metadataSnapshot.staticConfig.agentConfig.mixinConfig.postInvocationHooks);
    for (const kind of ["skills", "agents", "plugins", "rules", "hooks"]) {
      assert.ok(Object.hasOwn(config.customizationDiscovery[kind], "inheritUser"));
      assert.equal(config.customizationDiscovery[kind].inheritUser, false);
    }
  }
  assert.equal(h.conversationId, decoded.trajectoryId);
  assert.equal(h.conversationId, decoded.cascadeId);
});

test("native metadata ignores unrelated extensions while preserving actual system and tools", () => {
  const metadata = nativeAgentFixture();
  metadata.staticConfig.agentConfig.mixinConfig.tools[0].futureNativeField = {enabled: true};
  metadata.agentScript.config.agentConfig.customizationDiscovery.skills.futureFlag = false;
  const decoded = json(build([], {nativeAgentMetadata: {...metadata, unrelatedExtension: "new"}}));
  assert.equal(decoded.metadata.staticConfig.agentConfig.mixinConfig.tools[0].name, "read_file");
  assert.equal(decoded.metadata.agentScript.name, metadata.agentScript.name);
  assert.throws(() => build([], {nativeAgentMetadata: {staticConfig: {}}}), code("invalid_native_agent_metadata"));
});

test("writer rejects mismatched/path-traversal IDs before touching conversations", async () => {
  const root = await mkdtemp(join(process.env.AGY_HISTORY_TEST_DIRECTORY ?? tmpdir(), "agy-history-reject-"));
  try {
    const directory = join(root, "must-not-exist");
    const h = build([user("no write")]);
    await assert.rejects(writeNativeHistory({ ...h, conversationId: "../old" }, { conversationsDirectory: directory }), code("invalid_conversation_id"));
    await assert.rejects(writeNativeHistory({ ...h, conversationId: build([]).conversationId }, { conversationsDirectory: directory }), code("conversation_id_mismatch"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native persistence AES-GCM decrypt, random nonce, fresh UUID and exclusive no-overwrite without an exe", async () => {
  const root = await mkdtemp(join(process.env.AGY_HISTORY_TEST_DIRECTORY ?? tmpdir(), "agy-history-encrypt-"));
  let key;
  try {
    const schema = JSON.parse(await readFile(new URL("../resources/history-schema.json", import.meta.url), "utf8"));
    key = Buffer.from(schema.encryptionKeyBase64, "base64");
    const oldPath = join(root, "00000000-0000-4000-8000-000000000001.pb");
    const oldBytes = Buffer.from("EXISTING_NATIVE_HISTORY_UNCHANGED");
    await writeFile(oldPath, oldBytes);
    const h = build([user("CRYPTO_USER_MARKER"), assistant([call()]), result(undefined, "CRYPTO_TOOL_MARKER")]);
    const written = await writeNativeHistory(h, { conversationsDirectory: root });
    assert.equal(written.conversationId, h.conversationId);
    assert.equal(written.path, join(root, `${h.conversationId}.pb`));
    const envelope = await readFile(written.path);
    assert.equal(envelope.length, h.bytes.length + 12 + 16);
    const decipher = createDecipheriv("aes-256-gcm", key, envelope.subarray(0, 12));
    decipher.setAuthTag(envelope.subarray(-16));
    const plain = Buffer.concat([decipher.update(envelope.subarray(12, -16)), decipher.final()]);
    assert.deepEqual(plain, Buffer.from(h.bytes));
    assert.equal(toJson(nativeTrajectorySchema, fromBinary(nativeTrajectorySchema, plain)).steps[2].mcpTool.resultString, "CRYPTO_TOOL_MARKER");
    await assert.rejects(writeNativeHistory(h, { conversationsDirectory: root }), { code: "EEXIST" });
    assert.deepEqual(await readFile(written.path), envelope);
    assert.deepEqual(await readFile(oldPath), oldBytes);
    const h2 = build([user("second import")]);
    const second = await writeNativeHistory(h2, { conversationsDirectory: root });
    assert.notEqual(second.path, written.path);
    assert.notDeepEqual((await readFile(second.path)).subarray(0, 12), envelope.subarray(0, 12));
    assert.equal((await readdir(root)).length, 3);
    const tampered = Buffer.from(envelope);
    tampered[12] ^= 1;
    const rejected = createDecipheriv("aes-256-gcm", key, tampered.subarray(0, 12));
    rejected.setAuthTag(tampered.subarray(-16));
    rejected.update(tampered.subarray(12, -16));
    assert.throws(() => rejected.final());
  } finally {
    key?.fill(0);
    await rm(root, { recursive: true, force: true });
  }
});
