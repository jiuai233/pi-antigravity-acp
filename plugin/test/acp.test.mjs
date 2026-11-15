import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join, resolve } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import test from "node:test";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk/unstable";
import { AcpConnection, AcpProcess, buildAcpArgv } from "../src/acp.ts";

const configOptions = [{
  id: "fixture-model", name: "Model", category: "model", type: "select",
  currentValue: "fixture-a", options: [{ value: "fixture-a", name: "A" }, { value: "fixture-b", name: "B" }],
}];
const usage = {
  totalTokens: 123, inputTokens: 80, outputTokens: 43, thoughtTokens: 7,
  cachedReadTokens: 11, cachedWriteTokens: 13, _meta: { fixture: "usage-preserved" },
};
const sessionRequest = {
  cwd: resolve("."), mcpServers: [{ type: "http", name: "pi", url: "http://127.0.0.1:7777/mcp", headers: [] }],
  _meta: { antigravity: { systemPrompt: { append: "fixture instructions" } } },
};
const initResponse = {
  protocolVersion: PROTOCOL_VERSION,
  agentCapabilities: {
    loadSession: true, promptCapabilities: { image: true },
    sessionCapabilities: { resume: {}, close: {}, options: {} },
  },
  _meta: { fixture: "capabilities-preserved" },
};
const text = (value) => [{ type: "text", text: value }];

function fixture(t, configure = () => {}, options = {}) {
  const outbound = new TransformStream();
  const inbound = new TransformStream();
  const app = agent({ name: "offline-fake-agent", version: "1" });
  configure(app);
  app.onRequest(methods.agent.initialize, () => initResponse)
    .onRequest(methods.agent.session.new, () => ({ sessionId: "s", configOptions }));
  const peer = app.connect(ndJsonStream(inbound.writable, outbound.readable));
  const connection = new AcpConnection(ndJsonStream(outbound.writable, inbound.readable), options);
  t.after(async () => {
    await connection.close();
    peer.close();
    await peer.closed;
  });
  return { connection, peer };
}

test("direct SDK consumption: initialize/new/options/config/load/resume/prompt/close", async (t) => {
  const calls = [];
  const updates = [];
  const { connection } = fixture(t, (app) => {
    app.onRequest(methods.agent.session.new, ({ params }) => {
      calls.push(["new", params]);
      return { sessionId: "s", configOptions, _meta: { fixture: "new" } };
    });
    app.onRequest(methods.agent.session.options, ({ params }) => {
      calls.push(["options", params]);
      return { configOptions };
    });
    app.onRequest(methods.agent.session.setConfigOption, ({ params }) => {
      calls.push(["config", params]);
      return { configOptions: [{ ...configOptions[0], currentValue: params.value }] };
    });
    for (const [label, method] of [["load", methods.agent.session.load], ["resume", methods.agent.session.resume]]) {
      app.onRequest(method, async ({ params, client }) => {
        calls.push([label, params]);
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: text(label)[0] },
        });
        return { configOptions, _meta: { fixture: label } };
      });
    }
    app.onRequest(methods.agent.session.prompt, async ({ params, client }) => {
      calls.push(["prompt", params]);
      // Deliberately issue consecutive notifications without waiting for async UI work.
      await client.notify(methods.client.session.update, {
        sessionId: "s", update: { sessionUpdate: "agent_thought_chunk", content: text("public thinking")[0] },
      });
      await client.notify(methods.client.session.update, {
        sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: text("answer")[0] },
      });
      await client.notify(methods.client.session.update, {
        sessionId: "s", update: { sessionUpdate: "usage_update", used: 91, size: 1000 },
      });
      return { stopReason: "end_turn", usage, _meta: { fixture: "prompt" } };
    });
    app.onRequest(methods.agent.session.close, ({ params }) => { calls.push(["close", params]); return {}; });
  }, { onUpdate: (notification, context) => updates.push({ ...notification, ...context }) });

  assert.deepEqual(await connection.initialize(), initResponse);
  assert.deepEqual(connection.initialization, initResponse);
  assert.deepEqual(connection.capabilities, initResponse.agentCapabilities);
  assert.deepEqual(await connection.newSession(sessionRequest), {
    sessionId: "s", configOptions, _meta: { fixture: "new" },
  });
  assert.deepEqual(await connection.sessionOptions({ cwd: sessionRequest.cwd }), { configOptions });
  const config = await connection.setConfigOption({ sessionId: "s", configId: "fixture-model", value: "fixture-b" });
  assert.equal(config.configOptions[0].currentValue, "fixture-b");
  const existing = { ...sessionRequest, sessionId: "s" };
  assert.deepEqual((await connection.loadSession(existing)).configOptions, configOptions);
  assert.deepEqual((await connection.resumeSession(existing)).configOptions, configOptions);
  // Load/resume never trigger a prompt, and their output is not automatically new output.
  assert.equal(calls.filter(([kind]) => kind === "prompt").length, 0);
  assert.deepEqual(updates.map(({ phase }) => phase), ["replay", "replay"]);
  const blocks = [...text("new input"), { type: "image", data: "AA==", mimeType: "image/png" }];
  assert.deepEqual(await connection.prompt("s", blocks), {
    stopReason: "end_turn", usage, _meta: { fixture: "prompt" },
  });
  assert.deepEqual(updates.map(({ update }) => update.sessionUpdate), [
    "agent_message_chunk", "agent_message_chunk", "agent_thought_chunk", "agent_message_chunk", "usage_update",
  ]);
  assert.deepEqual(updates.map(({ phase }) => phase), ["replay", "replay", "prompt", "prompt", "prompt"]);
  assert.equal(updates[4].update.used, 91); // Context watermark is not cumulative response usage.
  assert.deepEqual(calls.find(([kind]) => kind === "new")[1], sessionRequest);
  assert.deepEqual(calls.find(([kind]) => kind === "load")[1], existing);
  assert.deepEqual(calls.find(([kind]) => kind === "resume")[1], existing);
  assert.deepEqual(calls.find(([kind]) => kind === "prompt")[1], { sessionId: "s", prompt: blocks });
  assert.deepEqual(await connection.closeSession("s"), {});
  assert.equal(calls.filter(([kind]) => kind === "prompt").length, 1);
  await connection.close();
  assert.equal(connection.signal.aborted, true);
  await assert.rejects(connection.newSession(sessionRequest));
});

test("initialize caches the native negotiated protocol response without a local version gate", async (t) => {
  for (const protocolVersion of [PROTOCOL_VERSION, PROTOCOL_VERSION + 1]) {
    let calls = 0;
    const { connection } = fixture(t, (app) => {
      app.onRequest(methods.agent.initialize, () => { calls++; return { protocolVersion }; });
    });
    const first = connection.initialize();
    assert.equal(connection.initialize(), first);
    assert.equal((await first).protocolVersion, protocolVersion);
    assert.equal(connection.signal.aborted, false);
    assert.equal(calls, 1);
  }
});

test("interleaved sessions retain per-session phases and synchronous arrival order", async (t) => {
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const phases = [];
  const { connection, peer } = fixture(t, (app) => {
    app.onRequest(methods.agent.session.prompt, () => { entered.resolve(); return finish.promise; });
    app.onRequest(methods.agent.session.load, async ({ params, client }) => {
      for (const sessionId of [params.sessionId, "live", params.sessionId]) {
        await client.notify(methods.client.session.update, {
          sessionId, update: { sessionUpdate: "agent_thought_chunk", content: text(sessionId)[0] },
        });
      }
      return {};
    });
  }, { onUpdate: (notification, { phase }) => phases.push([notification.sessionId, phase]) });
  await connection.initialize();
  const live = connection.prompt("live", text("new input"));
  await entered.promise;
  await connection.loadSession({ ...sessionRequest, sessionId: "history" });
  assert.deepEqual(phases, [["history", "replay"], ["live", "prompt"], ["history", "replay"]]);
  await peer.client.notify(methods.client.session.update, {
    sessionId: "history", update: { sessionUpdate: "agent_message_chunk", content: text("idle")[0] },
  });
  finish.resolve({ stopReason: "end_turn" });
  await live;
  assert.deepEqual(phases.at(-1), ["history", "idle"]);
});

test("cancel waits for actual prompt settlement and keeps terminal usage", async (t) => {
  const entered = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let cancelCount = 0;
  const { connection } = fixture(t, (app) => {
    app.onRequest(methods.agent.session.prompt, () => { entered.resolve(); return finish.promise; });
    app.onNotification(methods.agent.session.cancel, () => { cancelCount++; cancelled.resolve(); });
  });
  await connection.initialize();
  const prompt = connection.prompt("s", text("one request"));
  await entered.promise;
  let settled = false;
  const cancel = connection.cancel("s").then((result) => { settled = true; return result; });
  const duplicate = connection.cancel("s");
  await cancelled.promise;
  await Promise.resolve();
  assert.equal(settled, false);
  await assert.rejects(connection.prompt("s", text("overlap")));
  finish.resolve({ stopReason: "cancelled", usage });
  assert.deepEqual(await prompt, { stopReason: "cancelled", usage });
  assert.deepEqual(await cancel, { stopReason: "cancelled", usage });
  await duplicate;
  assert.equal(cancelCount, 1);
  assert.equal(await connection.cancel("s"), undefined);
});

test("AbortSignal uses session cancellation, not early SDK request abandonment", async (t) => {
  const entered = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let prompts = 0;
  const { connection } = fixture(t, (app) => {
    app.onRequest(methods.agent.session.prompt, () => { prompts++; entered.resolve(); return finish.promise; });
    app.onNotification(methods.agent.session.cancel, () => cancelled.resolve());
  });
  await connection.initialize();
  const controller = new AbortController();
  let settled = false;
  const pending = connection.prompt("s", text("input"), { signal: controller.signal })
    .then((result) => { settled = true; return result; });
  await entered.promise;
  controller.abort();
  await cancelled.promise;
  assert.equal(settled, false);
  finish.resolve({ stopReason: "cancelled", usage });
  assert.deepEqual(await pending, { stopReason: "cancelled", usage });
  await assert.rejects(connection.prompt("s", text("pre-aborted"), { signal: controller.signal }), { name: "AbortError" });
  assert.equal(prompts, 1);
});

test("closeSession cancels and waits before sending session/close", async (t) => {
  const entered = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const order = [];
  const { connection } = fixture(t, (app) => {
    app.onRequest(methods.agent.session.prompt, async () => {
      entered.resolve();
      const response = await finish.promise;
      order.push("prompt settled");
      return response;
    });
    app.onNotification(methods.agent.session.cancel, () => { order.push("cancel"); cancelled.resolve(); });
    app.onRequest(methods.agent.session.close, () => { order.push("close"); return {}; });
  });
  await connection.initialize();
  const prompt = connection.prompt("s", text("input"));
  await entered.promise;
  const closing = connection.closeSession("s");
  await cancelled.promise;
  assert.deepEqual(order, ["cancel"]);
  finish.resolve({ stopReason: "cancelled" });
  await prompt;
  await closing;
  assert.deepEqual(order, ["cancel", "prompt settled", "close"]);
});

test("permission defaults to no grant; injected whitelist sees original request", async (t) => {
  const permission = {
    sessionId: "s", toolCall: { toolCallId: "bridge-1", title: "Pi bridge" },
    options: [{ optionId: "yes", name: "Allow once", kind: "allow_once" }],
  };
  for (const allow of [false, true]) {
    const { connection } = fixture(t, (app) => {
      app.onRequest(methods.agent.session.prompt, async ({ client }) => {
        const response = await client.request(methods.client.session.requestPermission, permission);
        assert.deepEqual(response.outcome, allow ? { outcome: "selected", optionId: "yes" } : { outcome: "cancelled" });
        return { stopReason: "end_turn" };
      });
    }, allow ? { requestPermission: (request, signal) => {
      assert.deepEqual(request, permission);
      assert.equal(signal.aborted, false);
      return { outcome: { outcome: "selected", optionId: "yes" } };
    } } : {});
    await connection.initialize();
    await connection.prompt("s", text("permission fixture"));
  }
});

test("load failure restores idle phase; failures propagate without automatic retry", async (t) => {
  let loads = 0;
  let prompts = 0;
  const updates = [];
  const { connection, peer } = fixture(t, (app) => {
    app.onRequest(methods.agent.session.load, () => { loads++; throw new RequestError(-32002, "fixture missing"); });
    app.onRequest(methods.agent.session.prompt, () => { prompts++; throw new RequestError(-32602, "fixture rejected"); });
  }, { onUpdate: (_, context) => updates.push(context.phase) });
  await connection.initialize();
  await assert.rejects(connection.loadSession({ ...sessionRequest, sessionId: "s" }), { code: -32002 });
  await assert.rejects(connection.prompt("s", text("input")), { code: -32602 });
  await peer.client.notify(methods.client.session.update, {
    sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: text("late idle update")[0] },
  });
  // Round trip ensures the prior notification was synchronously dispatched.
  await connection.newSession(sessionRequest);
  assert.deepEqual(updates, ["idle"]);
  assert.equal(loads, 1);
  assert.equal(prompts, 1);
});

test("consumer mapping errors remain visible without disconnecting healthy native prompts", async t => {
  const entered = Promise.withResolvers(), finish = Promise.withResolvers(), mapped = Promise.withResolvers();
  const {connection, peer} = fixture(t, app => {
    app.onRequest(methods.agent.session.prompt, () => { entered.resolve(); return finish.promise; });
  }, {onUpdate: () => { throw new Error("mapping failure"); }, onUpdateError: error => mapped.resolve(error)});
  await connection.initialize();
  const pending = connection.prompt("s", text("input"));
  await entered.promise;
  await peer.client.notify(methods.client.session.update, {
    sessionId: "s", update: {sessionUpdate: "agent_message_chunk", content: {type: "text", text: "actual"}},
  });
  assert.match((await mapped.promise).message, /mapping failure/);
  assert.equal(connection.signal.aborted, false);
  finish.resolve({stopReason: "end_turn"});
  assert.equal((await pending).stopReason, "end_turn");
});

test("actual transport disconnect still rejects pending prompts", async t => {
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  const {connection, peer} = fixture(t, app => {
    app.onRequest(methods.agent.session.prompt, () => { entered.resolve(); return finish.promise; });
  });
  await connection.initialize();
  const pending = assert.rejects(connection.prompt("s", text("input")));
  await entered.promise;
  const closing = connection.close(new Error("native transport disconnected"));
  finish.resolve({stopReason: "cancelled"});
  await pending;
  await closing;
});
// Fake only the owned OS process. All protocol handling still uses official SDK.
function fakeSpawn(app, { exitOn = "SIGTERM", failStart = false } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = failStart ? undefined : 424242;
  const peer = app.connect(ndJsonStream(
    Writable.toWeb(child.stdout), Readable.toWeb(child.stdin),
  ));
  const kills = [];
  const end = (code = 0, signal = null) => {
    child.emit("exit", code, signal);
    peer.close();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    child.emit("close", code, signal);
  };
  child.kill = (signal) => { kills.push(signal); if (signal === exitOn) queueMicrotask(() => end(null, signal)); return true; };
  let received;
  const spawnProcess = (executable, argv, options) => {
    received = { executable, argv, options };
    queueMicrotask(() => {
      if (failStart) {
        child.emit("error", Object.assign(new Error("fixture executable missing"), { code: "ENOENT" }));
        queueMicrotask(() => end(-1));
      } else child.emit("spawn");
    });
    return child;
  };
  return { child, peer, kills, end, spawnProcess, get received() { return received; } };
}

const processOptions = () => ({
  executable: "offline-fake-agy", cwd: resolve("."), env: { ONLY_PARENT_ENV: "fixture" },
  geminiDir: resolve("owned-agy-fixture"), shutdownGraceMs: 1,
});

test("argv is pure; owned process receives exact env and closes only its own child", async (t) => {
  const options = { ...processOptions(), agent: "bridge-agent", processPerSession: true };
  assert.deepEqual(buildAcpArgv(options), [
    "acp", "--disable-telemetry", "--include-default-customizations=true",
    `--gemini-dir=${options.geminiDir}`, "--agent=bridge-agent", "--process-per-session",
  ]);
  const fake = fakeSpawn(agent().onRequest(methods.agent.initialize, () => initResponse));
  const logs = [];
  let reads = 0;
  const owned = await AcpProcess.start({
    ...options, spawnProcess: fake.spawnProcess, onStderr: (chunk) => logs.push(chunk),
    logDirectory: join(options.geminiDir, "logs"),
    readNativeHttpPort: async (directory, pid) => {
      reads++;
      assert.equal(directory, join(options.geminiDir, "logs"));
      assert.equal(pid, 424242);
      return reads === 1 ? 32123 : 32124;
    },
  });
  t.after(() => owned.close());
  assert.equal(fake.received.executable, options.executable);
  assert.deepEqual(fake.received.argv, buildAcpArgv(options));
  assert.deepEqual(fake.received.options.env, options.env);
  assert.equal(fake.received.options.shell, false);
  assert.equal(owned.pid, 424242);
  assert.deepEqual(await owned.initialize(), initResponse);
  fake.child.stderr.write("owned diagnostic");
  assert.deepEqual(logs, ["owned diagnostic"]);
  assert.equal(await owned.getNativeHttpPort(), 32123);
  assert.equal(await owned.getNativeHttpPort(), 32124);
  assert.equal(reads, 2);
  await owned.close();
  await owned.close();
  assert.deepEqual(fake.kills, ["SIGTERM"]);
});

test("owned process exit rejects pending prompt, never restarts", async (t) => {
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const fake = fakeSpawn(agent()
    .onRequest(methods.agent.initialize, () => initResponse)
    .onRequest(methods.agent.session.prompt, () => { entered.resolve(); return finish.promise; }));
  const owned = await AcpProcess.start({ ...processOptions(), spawnProcess: fake.spawnProcess });
  t.after(() => owned.close());
  await owned.initialize();
  const result = assert.rejects(owned.prompt("s", text("input")), /exited.*code=17/);
  await entered.promise;
  fake.end(17);
  await result;
  finish.resolve({ stopReason: "cancelled" });
  await owned.close();
  assert.deepEqual(fake.kills, []);
});

test("owned close escalates only its child; failed spawn is surfaced", async () => {
  const stubborn = fakeSpawn(agent(), { exitOn: "SIGKILL" });
  const owned = await AcpProcess.start({ ...processOptions(), spawnProcess: stubborn.spawnProcess });
  await owned.close();
  assert.deepEqual(stubborn.kills, ["SIGTERM", "SIGKILL"]);
  const missing = fakeSpawn(agent(), { failStart: true });
  await assert.rejects(AcpProcess.start({ ...processOptions(), spawnProcess: missing.spawnProcess }), { code: "ENOENT" });
});

test("native port adapter cannot inspect logs outside this owned directory", async (t) => {
  let reads = 0;
  const fake = fakeSpawn(agent());
  const owned = await AcpProcess.start({
    ...processOptions(), spawnProcess: fake.spawnProcess, logDirectory: resolve("unrelated-agy/logs"),
    readNativeHttpPort: async () => { reads++; return 1234; },
  });
  t.after(() => owned.close());
  await assert.rejects(owned.getNativeHttpPort(), /owned geminiDir/);
  assert.equal(reads, 0);
});
