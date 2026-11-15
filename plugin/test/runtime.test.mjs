import assert from 'node:assert/strict';
import {createDecipheriv} from 'node:crypto';
import {mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {request} from 'node:http';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import test from 'node:test';
import {fromBinary, toJson} from '@bufbuild/protobuf';
import {nativeTrajectorySchema} from '../src/history.ts';
import {NATIVE_FAILURE_SUMMARY} from '../src/message-writer.ts';
import {AcpRuntime, API, HOST_CONTINUATION, PROVIDER, RESET_ENTRY } from '../src/runtime.ts';

// No AGY process is spawned or executable read; persistence uses native format data.
const binary = 'offline-fake-agy';
const model = (id = 'fixture-a') => ({id, name: id, api: API, provider: PROVIDER,
  baseUrl: '', reasoning: true, input: ['text', 'image'], contextWindow: 10000, maxTokens: 1000,
  cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}});
const tool = {name: 'probe', description: 'Offline fixture',
  parameters: {type: 'object', properties: {x: {type: 'number'}}, required: ['x']}};
const system = (content = 'Fixture instructions') => ({role: 'system', content, toolsAdded: [tool], timestamp: 0});
const user = content => ({role: 'user', content, timestamp: 1});
const initial = () => [system(), user('Do the fixture task')];
const toolResult = (call, text = 'REAL_PI_RESULT') => ({role: 'toolResult', toolCallId: call.id,
  toolName: call.name, content: [{type: 'text', text}], isError: false, timestamp: 3});
const turn = () => new Promise(resolve => setImmediate(resolve));
const configOptions = [{id: 'model', currentValue: 'fixture-a', options: [{value: 'fixture-a'}, {value: 'fixture-b'}]},
  {id: 'thought_level', currentValue: 'low', options: [{value: 'low'}, {value: 'high'}]}];

async function fixture(t) {
  const directory = await mkdtemp(join(process.env.PI_AGY_RUNTIME_TEST_TMP ?? tmpdir(), 'pi-acp-runtime-'));
  const previousMonitor = process.env.PI_AGY_NETWORK_MONITOR_CONFIG;
  // Never consume the operator's transport configuration in an offline test.
  process.env.PI_AGY_NETWORK_MONITOR_CONFIG = join(directory, 'absent-monitor.json');
  const log = [], processes = [], prompts = [], waiters = [], requests = new Set();
  let sessionRequest, descriptor;
  const nativePort = 54321; // fetch is intercepted; nothing listens on this port.
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body);
    const method = String(url).split('/').at(-1);
    assert.equal(String(url), `http://127.0.0.1:${nativePort}/exa.language_server_pb.LanguageServerService/${method}`);
    if (method === 'ForkConversation') {
      if (f.forkError) throw f.forkError;
      log.push(['fork', body]); return {ok: true, json: async () => ({newCascadeId: `fork-${body.sourceCascadeId}`})};
    }
    if (method === 'RevertToCascadeStep') {
      log.push(['revert', body]); return {ok: true, json: async () => ({})};
    }
    assert.equal(method, 'GetCascadeTrajectory');
    log.push(['trajectory', body.cascadeId]);
    if (f.telemetryError) throw f.telemetryError;
    return {ok: true, json: async () => ({trajectory: {steps: structuredClone(f.nativeSteps), generatorMetadata: f.nativeUsage ?? [], metadata: {
      staticConfig: {agentConfig: {mixinConfig: {tools: [{name: 'read_file', builtin: true}]}}},
      agentScript: {name: f.compiledName},
    }}})};
  });
  const f = {directory, log, processes, prompts, nativeTools: [], nativeSteps: [], compiledName: 'offline-agent', holdCancel: false,
    cancelled: Promise.withResolvers(), prepared: [], bindings: [],
    closeEntered: Promise.withResolvers(), closeRelease: Promise.withResolvers(), holdClose: false,
    waitPrompt(count) {
      if (prompts.length >= count) return Promise.resolve(prompts[count - 1]);
      const ready = Promise.withResolvers(); waiters.push({count, ready}); return ready.promise;
    },
    update(update, processIndex = processes.length - 1) {
      f.notify(update, {processIndex});
    },
    notify(update, {processIndex = processes.length - 1, phase = 'prompt', sessionId = prompts.at(-1).sessionId} = {}) {
      processes[processIndex].options.onUpdate({sessionId, update}, {phase});
    },
    rpc(method, params = {}) {
      assert.ok(sessionRequest, 'native process must receive the bridge descriptor first');
      assert.deepEqual(sessionRequest.mcpServers, [], 'ACP descriptors would reset the configured MCP timeout');
      const headers = descriptor.headers;
      let settled = false;
      const result = new Promise((resolveReply, reject) => {
        const req = request(descriptor.url, {method: 'POST', headers: {...headers, 'content-type': 'application/json'}}, res => {
          let body = ''; res.setEncoding('utf8'); res.on('data', text => { body += text; });
          res.on('end', () => { settled = true; resolveReply({status: res.statusCode, body: JSON.parse(body)}); });
        });
        requests.add(req); req.on('close', () => requests.delete(req)); req.on('error', reject);
        req.end(JSON.stringify({jsonrpc: '2.0', id: 1, method, params}));
      });
      // Cleanup may destroy a still-waiting client after a failed assertion.
      void result.catch(() => {});
      return {result, get settled() { return settled; }};
    },
  };
  const runtime = new AcpRuntime({cwd: resolve('.'), stateDirectory: directory, sessionKey: 'offline', binary,
    onBinding: binding => f.bindings.push(binding),
    onNativeTool: activity => f.nativeTools.push(activity),
    prepareAgent: async (_home, prompt, tools, serverName) => {
      f.prepared.push({prompt, tools, serverName}); return 'offline-agent';
    },
    createProcess: async options => {
      const config = JSON.parse(await readFile(join(options.geminiDir, 'config', 'mcp_config.json'), 'utf8'));
      const entry = config.mcpServers['acp-tools'];
      assert.equal(entry.timeoutSeconds, -1, 'Host runner owns long-tool completion and cancellation');
      descriptor = {...entry, url: entry.serverUrl};
      const index = processes.length;
      log.push(['create', index]);
      const controller = new AbortController();
      const fake = {options, signal: controller.signal,
        initialize: async () => { log.push(['initialize', index]); },
        getNativeHttpPort: async () => nativePort,
        newSession: async params => {
          sessionRequest = params; log.push(['new', index]);
          fake.configOptions = structuredClone(configOptions);
          return {sessionId: `session-${index}`, configOptions: fake.configOptions};
        },
        loadSession: async params => {
          sessionRequest = params; log.push(['load', params.sessionId, index]);
          fake.configOptions = structuredClone(configOptions);
          return {configOptions: fake.configOptions};
        },
        setConfigOption: async params => {
          log.push(['config', params]);
          const override = await f.onConfig?.(params, fake);
          if (override) return override;
          fake.configOptions = structuredClone(fake.configOptions);
          fake.configOptions.find(option => option.id === params.configId).currentValue = params.value;
          if (params.configId === 'model') {
            const effort = fake.configOptions.find(option => option.id === 'thought_level');
            effort.options = [{value: 'low'}, {value: 'high'}, ...(params.value === 'fixture-b' ? [{value: 'xhigh'}] : [])];
            if (!effort.options.some(option => option.value === effort.currentValue)) effort.currentValue = 'low';
          }
          return {configOptions: fake.configOptions};
        },
        prompt: (sessionId, content, {signal} = {}) => {
          const done = Promise.withResolvers();
          const flight = {sessionId, content, done, promise: done.promise, settled: false};
          prompts.push(flight); fake.flight = flight; log.push(['prompt', sessionId, content]);
          const abort = () => { void fake.cancel(sessionId); };
          signal?.addEventListener('abort', abort, {once: true});
          const settled = () => { flight.settled = true; signal?.removeEventListener('abort', abort); };
          void done.promise.then(settled, settled);
          for (const {count, ready} of waiters) if (prompts.length >= count) ready.resolve(prompts[count - 1]);
          return done.promise;
        },
        cancel: async sessionId => {
          log.push(['cancel', sessionId]); f.cancelled.resolve();
          if (!f.holdCancel) fake.flight?.done.resolve({stopReason: 'cancelled'});
          return fake.flight?.promise;
        },
        closeSession: async sessionId => { log.push(['closeSession', sessionId]); },
        close: async () => {
          log.push(['close', index]); f.closeEntered.resolve();
          if (f.holdClose) await f.closeRelease.promise;
          fake.flight?.done.resolve({stopReason: 'cancelled'}); controller.abort();
        },
      };
      // No fake pid: runtime's process-tree cleanup cannot signal any real PID.
      processes.push(fake); return fake;
    },
  });
  f.runtime = runtime;
  t.after(async () => {
    // Release fake native requests before the full runtime/socket cleanup, even on failure.
    f.closeRelease.resolve();
    for (const p of processes) p.flight?.done.resolve({stopReason: 'cancelled'});
    try { await runtime.close(); }
    finally {
      for (const req of requests) req.destroy();
      if (previousMonitor === undefined) delete process.env.PI_AGY_NETWORK_MONITOR_CONFIG;
      else process.env.PI_AGY_NETWORK_MONITOR_CONFIG = previousMonitor;
      await rm(directory, {recursive: true, force: true});
    }
  });
  return f;
}

async function pauseForTool(f, messages = initial(), selected = model()) {
  const stream = f.runtime.stream(selected, {messages});
  const flight = await f.waitPrompt(1);
  const pending = f.rpc('tools/call', {name: 'probe', arguments: {x: 7}});
  const output = await stream.result();
  assert.equal(output.stopReason, 'toolUse');
  const call = output.content.find(part => part.type === 'toolCall');
  assert.equal(call.name, 'probe'); assert.deepEqual(call.arguments, {x: 7});
  assert.equal(pending.settled, false); assert.equal(f.runtime.bridge.pendingCount, 1);
  return {messages, flight, pending, output, call};
}

// Starting the next owner directly in result().then runs before the old run()
// finally. A response-hook gate then gives that old finally time to execute.
test('next owner delivers real MCP result on the same prompt; old finally cannot detach it', {timeout: 10000}, async t => {
  const f = await fixture(t);
  const first = f.runtime.stream(model(), {messages: initial()});
  const flight = await f.waitPrompt(1);
  const gate = Promise.withResolvers(), entered = Promise.withResolvers();
  let oldOutput;
  const next = first.result().then(output => {
    oldOutput = output;
    return f.runtime.stream(model(), {messages: [...initial(), output, toolResult(output.content.find(p => p.type === 'toolCall'))]}, {
      onResponse: async () => { entered.resolve(); await gate.promise; },
    });
  });
  const pending = f.rpc('tools/call', {name: 'probe', arguments: {x: 7}});
  const second = await next;
  await entered.promise; await turn();
  assert.equal(oldOutput.stopReason, 'toolUse');
  assert.equal(pending.settled, false, 'onResponse gate must precede MCP delivery');
  gate.resolve();
  const reply = await pending.result;
  assert.equal(reply.status, 200); assert.equal(reply.body.result.isError, false);
  assert.deepEqual(reply.body.result.content, [{type: 'text', text: 'REAL_PI_RESULT'}]);
  f.update({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'continued under new owner'}});
  flight.done.resolve({stopReason: 'end_turn'});
  const output = await second.result();
  assert.equal(output.stopReason, 'stop');
  assert.deepEqual(output.content, [{type: 'text', text: 'continued under new owner'}]);
  assert.equal(f.prompts.length, 1); assert.equal(f.processes.length, 1);
  assert.equal(f.runtime.bridge.pendingCount, 0);
});

test('payload replacement drives native input/config/tools and transport hooks serialize before mapping', {timeout: 10000}, async t => {
  const f = await fixture(t), hooks = [], gate = Promise.withResolvers(), entered = Promise.withResolvers();
  const replacementTool = {...tool, name: 'replacement_probe'};
  const effective = [{...system('Replacement instructions'), toolsAdded: [replacementTool]}, user('REPLACED_INPUT')];
  const stream = f.runtime.stream(model(), {messages: initial()}, {
    onPayload: (payload, selectedModel) => {
      hooks.push('payload'); assert.equal(selectedModel.id, 'fixture-a');
      assert.equal(payload.messages.at(-1).content, 'Do the fixture task');
      return {...payload, messages: effective, model: 'fixture-b', thoughtLevel: 'high'};
    },
    onResponse: response => { hooks.push('response'); assert.equal(response.status, 200); assert.equal(response.headers['x-pi-transport'], 'acp'); },
    onProviderStreamEvent: async notification => {
      hooks.push(notification.update.sessionUpdate);
      if (notification.update.sessionUpdate === 'agent_thought_chunk') { entered.resolve(); await gate.promise; }
    },
  });
  const events = []; const collected = (async () => { for await (const event of stream) events.push(event); })();
  const flight = await f.waitPrompt(1);
  assert.deepEqual(flight.content, [{type: 'text', text: 'REPLACED_INPUT'}]);
  assert.equal(f.prepared[0].prompt, 'Replacement instructions');
  assert.deepEqual(f.prepared[0].tools, [replacementTool]);
  const catalog = await f.rpc('tools/list').result;
  assert.deepEqual(catalog.body.result.tools.map(t => t.name), ['replacement_probe']);
  assert.deepEqual(f.log.filter(([kind]) => kind === 'config').map(([, p]) => [p.configId, p.value]),
    [['model', 'fixture-b'], ['thought_level', 'high']]);
  f.update({sessionUpdate: 'agent_thought_chunk', content: {type: 'text', text: 'public thought'}});
  f.update({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'answer'}});
  flight.done.resolve({stopReason: 'end_turn'});
  await entered.promise; await turn();
  assert.deepEqual(events.map(e => e.type), ['start'], 'raw hook must finish before text/thought mapping or terminal output');
  gate.resolve(); await collected;
  const output = await stream.result();
  assert.deepEqual(hooks, ['payload', 'response', 'agent_thought_chunk', 'agent_message_chunk']);
  assert.deepEqual(output.content, [{type: 'thinking', thinking: 'public thought'}, {type: 'text', text: 'answer'}]);
  assert.equal(events.at(-1).type, 'done');
});

test('stopNative retains pending MCP until cancellation actually settles', {timeout: 10000}, async t => {
  const f = await fixture(t), paused = await pauseForTool(f);
  f.holdCancel = true;
  let stopped = false;
  const stopping = f.runtime.stopNative().then(() => { stopped = true; });
  await f.cancelled.promise; await turn();
  assert.equal(stopped, false); assert.equal(paused.pending.settled, false);
  assert.equal(f.runtime.bridge.pendingCount, 1);
  paused.flight.done.resolve({stopReason: 'cancelled'});
  await stopping;
  const reply = await paused.pending.result;
  assert.equal(reply.body.result.isError, true); assert.equal(f.runtime.bridge.pendingCount, 0);
  assert.equal(f.prompts.length, 1);
});

async function readImported(f, id) {
  const resource = JSON.parse(await readFile(new URL('../resources/history-schema.json', import.meta.url), 'utf8'));
  const encrypted = await readFile(join(f.directory, 'gemini', 'antigravity-cli', 'conversations', `${id}.pb`));
  const key = Buffer.from(resource.encryptionKeyBase64, 'base64');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12));
    decipher.setAuthTag(encrypted.subarray(-16));
    return toJson(nativeTrajectorySchema, fromBinary(nativeTrajectorySchema,
      Buffer.concat([decipher.update(encrypted.subarray(12, -16)), decipher.final()])));
  } finally { key.fill(0); }
}

for (const change of ['projection', 'steering-media']) test(`${change} change stops old prompt before structured import and one wire-only continuation`, {timeout: 15000}, async t => {
  const f = await fixture(t), paused = await pauseForTool(f);
  f.holdCancel = true;
  const messages = [...paused.messages, paused.output, toolResult(paused.call)];
  if (change === 'projection') { messages[1] = user('Edited effective user history'); f.runtime.invalidateProjection(); }
  if (change === 'steering-media') messages.push(user([{type: 'text', text: 'Use the attached image'}, {type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png'}]));
  const selected = model(change === 'model' ? 'fixture-b' : 'fixture-a');
  const next = f.runtime.stream(selected, {messages});
  await f.cancelled.promise; await turn();
  assert.equal(f.prompts.length, 1); assert.equal(f.processes.length, 1);
  assert.equal(paused.pending.settled, false, 'changed context must not deliver a real/fake result into the stale prompt');
  const beforeStop = await readdir(join(f.directory, 'gemini', 'antigravity-cli', 'conversations'))
    .catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  assert.deepEqual(beforeStop, [], 'structured import must also wait for old prompt settlement');
  paused.flight.done.resolve({stopReason: 'cancelled'});
  const freshFlight = await f.waitPrompt(2);
  assert.equal((await paused.pending.result).body.result.isError, true);
  const load = f.log.find(([kind]) => kind === 'load'); assert.ok(load);
  assert.notEqual(load[1], paused.flight.sessionId);
  const imported = await readImported(f, load[1]);
  assert.equal(imported.cascadeId, load[1]);
  assert.equal(imported.steps[0].userInput.userResponse,
    change === 'projection' ? 'Edited effective user history' : 'Do the fixture task');
  const importedCall = imported.steps.find(s => s.mcpTool)?.mcpTool;
  assert.equal(importedCall.toolCall.id, paused.call.id);
  assert.equal(importedCall.resultString, 'REAL_PI_RESULT');
  assert.equal(imported.steps.filter(s => s.userInput).length, 1, 'host continuation is not imported as user history');
  assert.deepEqual(freshFlight.content, change === 'steering-media' ? messages.at(-1).content : [{type: 'text', text: HOST_CONTINUATION}]);
  assert.equal(f.runtime.snapshot().wireOnlyInput, change !== 'steering-media');
  assert.equal(f.processes.at(-1).configOptions.find(option => option.id === 'model').currentValue, selected.id);
  const kinds = f.log.map(([kind]) => kind);
  assert.ok(kinds.indexOf('cancel') < kinds.indexOf('close'));
  assert.ok(kinds.indexOf('close') < kinds.indexOf('load'));
  assert.equal(imported.metadata.agentScript.name, 'offline-agent');
  assert.deepEqual(imported.metadata.staticConfig.agentConfig.mixinConfig.tools, [{name: 'read_file', builtin: true}]);
  f.update({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'rebuilt answer'}});
  freshFlight.done.resolve({stopReason: 'end_turn'});
  const output = await next.result();
  assert.equal(output.stopReason, 'stop'); assert.equal(output.content[0].text, 'rebuilt answer');
  assert.equal(f.prompts.length, 2);
});

for (const blockedHook of [false, true]) test(`long Pi tool has no plugin total deadline (hook=${blockedHook})`, {timeout: 10000}, async t => {
  const f = await fixture(t);
  t.mock.timers.enable({apis: ['setTimeout']});
  const paused = await pauseForTool(f);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let next;
  const messages = [...paused.messages, paused.output, toolResult(paused.call)];
  if (blockedHook) {
    next = f.runtime.stream(model(), {messages}, {onResponse: async () => {entered.resolve(); await release.promise;}});
    await entered.promise;
  }
  t.mock.timers.tick(3_600_000);
  await turn();
  assert.equal(f.log.some(([kind]) => kind === 'cancel'), false);
  assert.equal(paused.pending.settled, false);
  if (blockedHook) release.resolve();
  else next = f.runtime.stream(model(), {messages});
  assert.equal((await paused.pending.result).body.result.content[0].text, 'REAL_PI_RESULT');
  paused.flight.done.resolve({stopReason: 'end_turn'});
  assert.equal((await next.result()).stopReason, 'stop');
  assert.equal(f.prompts.length, 1);
});
test('a new Pi owner can cancel the already-running native prompt with its own signal',async t=>{
  const f=await fixture(t),paused=await pauseForTool(f);
  const controller=new AbortController();
  const next=f.runtime.stream(model(),{messages:[...paused.messages,paused.output,toolResult(paused.call)]},{signal:controller.signal});
  assert.equal((await paused.pending.result).body.result.content[0].text,'REAL_PI_RESULT');
  controller.abort(new Error('owner cancelled'));
  const output=await next.result();
  assert.equal(output.stopReason,'aborted');assert.equal(f.prompts.length,1);
  assert.ok(f.log.some(([kind,id])=>kind==='cancel'&&id===paused.flight.sessionId));
});

test('transport loss between owners closes native before the next real result is imported',async t=>{
  const f=await fixture(t),paused=await pauseForTool(f);
  t.mock.method(console,'warn',()=>{});
  f.holdClose=true;
  paused.flight.done.reject(new Error('fixture transport lost'));
  await f.closeEntered.promise;
  const next=f.runtime.stream(model(),{messages:[...paused.messages,paused.output,toolResult(paused.call)]});
  await turn();
  assert.equal(f.processes.length,1);assert.equal(paused.pending.settled,false);
  f.closeRelease.resolve();
  assert.equal((await paused.pending.result).body.result.isError,true);
  const fresh=await f.waitPrompt(2),load=f.log.find(([kind])=>kind==='load');
  assert.equal((await readImported(f,load[1])).steps.find(s=>s.mcpTool).mcpTool.resultString,'REAL_PI_RESULT');
  f.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'recovered after disconnect'}});
  fresh.done.resolve({stopReason:'end_turn'});
  assert.equal((await next.result()).stopReason,'stop');assert.equal(f.prompts.length,2);
});

for (const vision of [false, true]) test(`real MCP media is delivered without a model-family admission check (vision=${vision})`, async t => {
  const f = await fixture(t), selected = {...model(), input: vision ? ['text','image'] : ['text']};
  const paused = await pauseForTool(f, initial(), selected);
  const result = {...toolResult(paused.call), content: [{type:'image', data:'aGk', mimeType:'image/png'},
    {type:'resource', resource:{uri:'file:///fixture', text:'REAL_RESOURCE'}}]};
  const next = f.runtime.stream(selected, {messages:[...paused.messages, paused.output, result]});
  const content = (await paused.pending.result).body.result.content;
  assert.equal(content[0].data, 'aGk=');
  assert.ok(content[1].text.includes('REAL_RESOURCE'));
  paused.flight.done.resolve({stopReason:'end_turn'});
  assert.equal((await next.result()).stopReason, 'stop');
  assert.equal(f.prompts.length, 1);
});
test('native read cards persist snapshots without Pi execution, extra prompts or new assistant content types', {timeout: 10000}, async t => {
  const f = await fixture(t), messages = initial(), original = structuredClone(messages);
  const stream = f.runtime.stream(model(), {messages});
  const events = [];
  const collected = (async () => { for await (const event of stream) events.push(event); })();
  const flight = await f.waitPrompt(1);
  f.update({sessionUpdate: 'agent_thought_chunk', content: {type: 'text', text: 'public thought'}});
  f.update({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'before native read'}});
  const read = {sessionUpdate: 'tool_call', toolCallId: 'native-read', name: 'read_file',
    title: 'File /fixture/probe.mp4', status: 'pending', rawInput: {Path: '/fixture/probe.mp4'}};
  f.update(read);
  f.update(read); // A repeated snapshot cannot create a second entry/block boundary.
  f.update({sessionUpdate: 'tool_call_update', toolCallId: 'native-read', status: 'in_progress'});
  f.update({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'after native read'}});
  for (const name of ['pi__read_file', 'mcp__read_file', 'pi-acp.read_file']) {
    f.update({...read, name, toolCallId: name});
  }
  // Only a real MCP tools/call goes to Pi for execution.
  await turn();
  const pending = f.rpc('tools/call', {name: 'probe', arguments: {x: 7}});
  const first = await stream.result();
  await collected;
  assert.deepEqual(first.content.slice(0, 3), [
    {type: 'thinking', thinking: 'public thought'},
    {type: 'text', text: 'before native read'},
    {type: 'text', text: 'after native read'},
  ]);
  const call = first.content[3];
  assert.equal(call.type, 'toolCall'); assert.equal(call.name, 'probe');
  assert.deepEqual(first.content.map(part => part.type), ['thinking', 'text', 'text', 'toolCall']);
  assert.equal(events.filter(e => e.type === 'text_end' && e.contentIndex === 1).length, 1);
  assert.equal(f.nativeTools.length, 2);
  const anchor = {messageTimestamp: first.timestamp, contentIndex: 2};
  for (const activity of f.nativeTools) {
    assert.equal(activity.messageTimestamp, anchor.messageTimestamp);
    assert.equal(activity.contentIndex, anchor.contentIndex);
    assert.equal(activity.id, `${flight.sessionId}:native-read`);
  }
  const second = f.runtime.stream(model(), {messages: [...messages, first, toolResult(call)]});
  assert.equal((await pending.result).body.result.isError, false);
  f.update({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'continued '}});
  f.update({sessionUpdate: 'tool_call_update', toolCallId: 'native-read', status: 'completed'});
  f.update({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'answer'}});
  flight.done.resolve({stopReason: 'end_turn'});
  const output = await second.result();
  assert.deepEqual(output.content, [{type: 'text', text: 'continued answer'}]);
  assert.equal(f.nativeTools.length, 3);
  assert.deepEqual(f.nativeTools.map(a => a.status), ['pending', 'in_progress', 'completed']);
  assert.equal(f.nativeTools[2].messageTimestamp, first.timestamp, 'later owner cannot move the first anchor');
  assert.equal(f.nativeTools[2].contentIndex, 2);
  assert.equal(f.nativeTools[2].output, undefined, 'completed without rawOutput is not invented video content');
  assert.equal(f.prompts.length, 1); assert.equal(f.processes.length, 1);
  assert.equal(f.runtime.bridge.pendingCount, 0);
  assert.deepEqual(messages, original);
});

test('native cards ignore replay, idle, wrong sessions and old process notifications', {timeout: 10000}, async t => {
  const f = await fixture(t);
  const first = f.runtime.stream(model(), {messages: initial()});
  const oldFlight = await f.waitPrompt(1);
  const read = {sessionUpdate: 'tool_call', toolCallId: 'read', name: 'read_file',
    title: 'File /fixture/input.txt', rawInput: {Path: '/fixture/input.txt'}, status: 'completed'};
  f.notify(read, {phase: 'replay'});
  f.notify(read, {phase: 'idle'});
  f.notify(read, {sessionId: 'another-native-session'});
  oldFlight.done.resolve({stopReason: 'end_turn'});
  assert.equal((await first.result()).stopReason, 'stop');
  assert.deepEqual(f.nativeTools, []);
  f.notify(read); // Finished owner cannot create cards, even if a mock mislabels phase.
  await turn();
  const second = f.runtime.stream(model(), {messages: [system('Changed instructions'), user('New task')]});
  const fresh = await f.waitPrompt(2);
  assert.equal(f.processes.length, 2);
  f.notify(read, {processIndex: 0, sessionId: fresh.sessionId});
  f.notify(read, {sessionId: oldFlight.sessionId});
  f.update({...read, status: 'failed', rawOutput: 'Permission denied'});
  fresh.done.resolve({stopReason: 'end_turn'});
  const output = await second.result();
  assert.deepEqual(output.content, []);
  assert.equal(f.nativeTools.length, 1);
  assert.equal(f.nativeTools[0].id, `${fresh.sessionId}:read`);
  assert.equal(f.nativeTools[0].status, 'failed');
  assert.equal(f.nativeTools[0].output, 'Permission denied');
  assert.equal(f.nativeTools[0].messageTimestamp, output.timestamp);
});

test('cancelling a native read leaves its last real state incomplete, not successful', async t => {
  const f = await fixture(t), controller = new AbortController();
  const stream = f.runtime.stream(model(), {messages: initial()}, {signal: controller.signal});
  await f.waitPrompt(1);
  f.update({sessionUpdate: 'tool_call', toolCallId: 'cancelled-read', name: 'read_file',
    status: 'in_progress', rawInput: {Path: '/fixture/probe.mp4'}});
  await turn();
  controller.abort(new Error('fixture cancellation'));
  const output = await stream.result();
  assert.equal(output.stopReason, 'aborted');
  assert.equal(f.nativeTools.length, 1);
  assert.equal(f.nativeTools[0].status, 'in_progress');
  assert.equal(f.nativeTools[0].output, undefined);
  assert.deepEqual(output.content, []);
  assert.equal(f.prompts.length, 1);
});

test('display persistence failure reports a diagnostic without failing generation or rerunning tools', async t => {
  const f = await fixture(t);
  f.runtime.settings.onNativeTool = () => { throw new Error('fixture storage unavailable'); };
  const stream = f.runtime.stream(model(), {messages: initial()});
  const flight = await f.waitPrompt(1);
  f.update({sessionUpdate: 'tool_call', toolCallId: 'read', name: 'read_file', status: 'completed'});
  f.update({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'real answer'}});
  flight.done.resolve({stopReason: 'end_turn'});
  const output = await stream.result();
  assert.equal(output.stopReason, 'stop');
  assert.deepEqual(output.content, [{type: 'text', text: 'real answer'}]);
  const diagnostic = output.diagnostics.find(d => d.type === 'agy_acp_native_tool_persist_failed');
  assert.ok(diagnostic);
  assert.match(diagnostic.error.message, /storage unavailable/);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.runtime.bridge.pendingCount, 0);
});

test('index uses appendEntry only for its own visible session, never compaction runtimes', async t => {
  const {default: extension} = await import('../index.ts');
  const handlers = new Map(), entries = [], owners = [];
  let provider, sessionId = 'pi-a';
  const pi = {
    registerProvider(_name, config) { provider = config; },
    on(name, handler) { handlers.set(name, handler); },
    registerCommand() {},
    appendEntry(type, data) { entries.push({sessionId, type, data}); },
  };
  t.mock.method(AcpRuntime.prototype, 'stream', function () {
    owners.push(this);
    return {result: async () => ({content: []})};
  });
  extension(pi);
  t.after(async () => { await handlers.get('session_shutdown')(); });
  const context = {cwd: resolve('.'), sessionManager: {getSessionId: () => sessionId, getBranch: () => []}};
  await handlers.get('session_start')({}, context);
  provider.streamSimple(model(), {messages: initial()});
  const first = owners.at(-1), activity = {version: 1, id: 'native:read'};
  first.settings.onNativeTool(activity);
  assert.deepEqual(entries, [{sessionId: 'pi-a', type: 'pi-native-tool', data: activity}]);
  sessionId = 'pi-b';
  await handlers.get('session_start')({}, context);
  first.settings.onNativeTool(activity);
  assert.equal(entries.length, 1, 'old runtime cannot append into the new Pi session');
  provider.streamSimple(model(), {messages: initial()});
  owners.at(-1).settings.onNativeTool(activity);
  assert.equal(entries.at(-1).sessionId, 'pi-b');
  assert.equal(entries.length, 2);
  provider.streamSimple(model(), {messages: initial()}, {requestIdentity: {requestKind: 'compaction'}});
  assert.equal(owners.at(-1).settings.onNativeTool, undefined);
  await turn();
  assert.equal(entries.length, 2);
});

const doneStep = text => ({status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: {response: text}});
async function completedTurn(f, messages = initial(), selected = model(), options = {}) {
  const count = f.prompts.length + 1;
  const stream = f.runtime.stream(selected, {messages}, options);
  const flight = await f.waitPrompt(count);
  f.update({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: `reply-${count}`}});
  f.nativeSteps.push(doneStep(`native-${count}`));
  flight.done.resolve({stopReason: 'end_turn'});
  const output = await stream.result();
  assert.equal(output.stopReason, 'stop');
  return {output, messages: [...messages, output], flight, binding: f.runtime.snapshot()};
}
for (const forkFirst of [false, true]) test(`structured native 400 fails without accepting its DONE error cursor (fork=${forkFirst})`, async t => {
  const f = await fixture(t), first = await completedTurn(f);
  if (forkFirst) await f.runtime.closeProcess();
  const messages = [...first.messages, user('request rejected by native')];
  const stream = f.runtime.stream(model(), {messages});
  const events = [], collected = (async () => { for await (const event of stream) events.push(event); })();
  const flight = await f.waitPrompt(2);
  const realError = JSON.parse(await readFile(new URL('./fixtures/native-error-step.json', import.meta.url), 'utf8'));
  f.nativeSteps.push(realError);
  f.update({sessionUpdate: 'agent_message_chunk', content: {type: 'text', text: 'Native error warning'}});
  flight.done.resolve({stopReason: 'end_turn'});
  const failure = await stream.result(); await collected;
  assert.equal(failure.stopReason, 'error');
  assert.equal(failure.errorMessage, NATIVE_FAILURE_SUMMARY);
  const original = `${realError.errorMessage.error.shortError}\n${realError.errorMessage.error.details}`;
  assert.ok(failure.content.some(part => part.type === 'text' && part.text.includes(original)));
  assert.equal(failure.diagnostics.find(entry => entry.type === 'agy_acp_native_recovery_finished').error.message, original);
  assert.equal(events.at(-1).type, 'error'); assert.ok(!events.some(event => event.type === 'done'));
  assert.deepEqual(f.runtime.snapshot(), first.binding); assert.equal(f.bindings.length, 1);
  const retried = await completedTurn(f, [...messages, failure, user('retry native request')]);
  assert.equal(retried.flight.sessionId, `fork-${first.flight.sessionId}`);
  assert.equal(f.log.filter(([kind]) => kind === 'fork').at(-1)[1].forkAtStepIndex, first.binding.stepIndex);
});

test('historical and healed ERROR_MESSAGE steps do not poison a later successful prompt', async t => {
  const f = await fixture(t);
  const error = {type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE', status: 'CORTEX_STEP_STATUS_DONE', errorMessage: {error: {shortError: 'old error'}}};
  f.nativeSteps.push(error);
  const first = await completedTurn(f);
  const stream = f.runtime.stream(model(), {messages: [...first.messages, user('healed in turn')]});
  const flight = await f.waitPrompt(2);
  f.nativeSteps.push(error, doneStep('recovered normal completion'));
  flight.done.resolve({stopReason: 'end_turn'});
  const output = await stream.result();
  assert.equal(output.stopReason, 'stop'); assert.equal(f.runtime.snapshot().stepIndex, 3);
  await completedTurn(f, [...first.messages, user('healed in turn'), output, user('ordinary follow-up')]);
});

for (const reopen of [false, true]) test(`manual reset preserves Pi history, skips old native import once, and resumes normally (reopen=${reopen})`, async t => {
  const f = await fixture(t), first = await completedTurn(f);
  await f.runtime.reset();
  assert.equal(f.runtime.snapshot(), undefined); assert.equal(f.runtime.hasLiveNativeControl(), false);
  if (reopen) {
    const entries = [...r1Entries(first.messages, first.binding), {type: 'custom', id: 'manual-reset', customType: RESET_ENTRY, data: {version: 1}}];
    await f.runtime.close(); f.runtime = new AcpRuntime(f.runtime.settings); t.after(() => f.runtime.close());
    f.runtime.restore(entries);
    assert.equal(f.runtime.snapshot(), undefined, 'reset marker wins over older checkpoints');
  }
  const messages = [...first.messages, user('Only the new request')];
  const after = await completedTurn(f, messages);
  assert.deepEqual(after.flight.content, [{type: 'text', text: 'Only the new request'}]);
  assert.ok(f.log.some(([kind, index]) => kind === 'new' && index === 1));
  assert.ok(!f.log.some(([kind]) => kind === 'fork' || kind === 'load'));
  assert.deepEqual(messages.slice(0, first.messages.length), first.messages, 'Pi history is untouched');
  const next = await completedTurn(f, [...after.messages, user('normal continuation')]);
  assert.equal(next.flight.sessionId, after.flight.sessionId);
  assert.equal(f.processes.length, 2);
  // Reset is not a permanent filter: a later real projection change imports its effective context.
  f.runtime.invalidateProjection();
  const compacted = await completedTurn(f, [system(), user('COMPACTED_CONTEXT'), next.output, user('after compaction')]);
  assert.equal((await readImported(f, compacted.flight.sessionId)).steps[0].userInput.userResponse, 'COMPACTED_CONTEXT');
});

test('local diagnostics report active native settings and pending tools without sampling or prompting', async t => {
  const f = await fixture(t), paused = await pauseForTool(f, initial(), model('fixture-b'));
  const before = f.log.length;
  const report = f.runtime.diagnostics();
  assert.equal(report.promptActive, true); assert.equal(report.live, true); assert.equal(report.pendingTools, 1);
  assert.deepEqual(report.requested, {model: 'fixture-b', reasoning: null});
  assert.equal(report.reported.find(option => option.id === 'model').value, 'fixture-b');
  assert.equal(report.binding.conversationId, paused.flight.sessionId);
  assert.equal(f.log.length, before, 'doctor state must not sample native HTTP or generate');
  assert.ok(!JSON.stringify(report).includes(f.runtime.token));
});

test('reset cancels a native prompt still waiting for a real MCP result', async t => {
  const f = await fixture(t), paused = await pauseForTool(f);
  await f.runtime.reset();
  assert.equal(f.runtime.bridge.pendingCount, 0);
  assert.equal(f.runtime.snapshot(), undefined);
  assert.ok(f.log.some(([kind]) => kind === 'cancel'));
  await paused.pending.result;
});

const restoreBinding = (f, binding) => {
  const messages = f.branchMessages ?? f.runtime.acceptedHistory;
  const entries = messages.map((message, i) => ({type: 'message', id: `message-${i}`, parentId: i ? `message-${i-1}` : null, message}));
  const piEntryId = entries.at(-1)?.id;
  f.runtime.restore([...entries, {type: 'custom', id: 'binding', parentId: piEntryId,
    customType: 'pi-antigravity-acp-checkpoint', data: {...binding, piEntryId}}]);
};

test('idle model and effort changes preserve native identity with history and model-specific xhigh', async t => {
  const f = await fixture(t);
  let previous = await completedTurn(f);
  const id = previous.flight.sessionId;
  for (const [idSuffix, reasoning] of [['b', 'xhigh'], ['a', 'high'], ['b', 'max']]) {
    previous = await completedTurn(f, [...previous.messages, user('continue')], model(`fixture-${idSuffix}`), {reasoning});
    assert.equal(previous.flight.sessionId, id);
  }
  const settings = f.log.filter(([kind]) => kind === 'config').map(([, p]) => [p.configId, p.value]);
  assert.deepEqual(settings, [['model', 'fixture-a'], ['model', 'fixture-b'], ['thought_level', 'xhigh'],
    ['model', 'fixture-a'], ['thought_level', 'high'], ['model', 'fixture-b'], ['thought_level', 'xhigh']]);
  assert.equal(f.processes.length, 1);
  assert.equal(f.log.filter(([kind]) => ['load', 'fork', 'cancel'].includes(kind)).length, 0);
  assert.equal(previous.binding.version, 3);
});

test('off/minimal aliases and unchanged history do not recreate a session', async t => {
  const f = await fixture(t);
  const first = await completedTurn(f, initial(), model(), {reasoning: 'off'});
  const second = await completedTurn(f, [...first.messages, user('continue')], model(), {reasoning: 'minimal'});
  assert.equal(first.flight.sessionId, second.flight.sessionId);
  assert.equal(f.processes.length, 1);
  assert.deepEqual(f.log.filter(([kind,p]) => kind === 'config' && p.configId === 'thought_level').map(([,p]) => p.value), ['low','low']);
});

test('waiting MCP confirms model and refreshed xhigh before releasing the real result', async t => {
  const f = await fixture(t), paused = await pauseForTool(f);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.onConfig = async params => {
    if (params.configId === 'thought_level') { entered.resolve(); await release.promise; }
  };
  const next = f.runtime.stream(model('fixture-b'), {messages: [...paused.messages, paused.output, toolResult(paused.call)]}, {reasoning: 'xhigh'});
  await entered.promise; await turn();
  assert.equal(paused.pending.settled, false);
  assert.equal(f.log.some(([kind]) => kind === 'cancel'), false);
  release.resolve();
  assert.deepEqual((await paused.pending.result).body.result.content, [{type: 'text', text: 'REAL_PI_RESULT'}]);
  assert.equal(f.processes[0].configOptions.find(o => o.id === 'thought_level').currentValue, 'xhigh');
  paused.flight.done.resolve({stopReason: 'end_turn'});
  assert.equal((await next.result()).stopReason, 'stop');
  assert.equal(f.prompts.length, 1); assert.equal(f.processes.length, 1);
  assert.equal(f.runtime.snapshot().conversationId, paused.flight.sessionId);
});

test('explicit native busy rejection defers settings without cancellation or invented results', async t => {
  const f = await fixture(t), paused = await pauseForTool(f);
  f.onConfig = async () => { throw new Error('AGY session busy: prompt is running'); };
  const next = f.runtime.stream(model('fixture-b'), {messages: [...paused.messages, paused.output, toolResult(paused.call)]}, {reasoning: 'xhigh'});
  assert.deepEqual((await paused.pending.result).body.result.content, [{type: 'text', text: 'REAL_PI_RESULT'}]);
  paused.flight.done.resolve({stopReason: 'end_turn'});
  const output = await next.result();
  assert.equal(output.stopReason, 'stop');
  const deferred = output.diagnostics.find(d => d.type === 'agy_acp_settings_deferred');
  assert.equal(deferred.details.reported.find(o => o.id === 'model').currentValue, 'fixture-a');
  assert.equal(deferred.details.until, 'next idle Pi request');
  assert.equal(f.log.some(([kind]) => kind === 'cancel'), false);
  f.onConfig = undefined;
  await completedTurn(f, [...paused.messages, paused.output, toolResult(paused.call), output, user('next idle turn')], model('fixture-b'), {reasoning: 'xhigh'});
  assert.equal(f.processes[0].configOptions.find(o => o.id === 'thought_level').currentValue, 'xhigh');
  assert.equal(f.processes.length, 1);
});

test('unadvertised effort reaches the real native setter instead of a local veto', async t => {
  const f = await fixture(t), paused = await pauseForTool(f);
  const next = f.runtime.stream(model(), {messages:[...paused.messages, paused.output, toolResult(paused.call)]}, {reasoning:'xhigh'});
  assert.equal((await paused.pending.result).body.result.content[0].text, 'REAL_PI_RESULT');
  paused.flight.done.resolve({stopReason:'end_turn'});
  const output = await next.result();
  assert.equal(output.stopReason, 'stop');
  assert.ok(f.log.some(([kind,p]) => kind === 'config' && p.configId === 'thought_level' && p.value === 'xhigh'));
  assert.equal(output.diagnostics.findLast(d => d.type === 'agy_acp_native_settings').details.effectiveValue, 'xhigh');
});
test('native canonical value is reported without pretending requested xhigh took effect', async t => {
  const f = await fixture(t);
  f.onConfig = async (params, fake) => params.configId === 'thought_level'
    ? {configOptions: fake.configOptions.map(o => o.id === 'thought_level' ? {...o, currentValue: {value:'high'}} : o)} : undefined;
  const stream = f.runtime.stream(model('fixture-b'), {messages:initial()}, {reasoning:'xhigh'});
  const flight = await f.waitPrompt(1);
  f.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'REAL_REPLY'}});
  flight.done.resolve({stopReason:'end_turn'});
  const output = await stream.result();
  assert.equal(output.stopReason,'stop');
  const reported = output.diagnostics.findLast(d => d.type === 'agy_acp_native_settings').details;
  assert.equal(reported.submitted,'xhigh');
  assert.deepEqual(reported.effectiveValue,{value:'high'});
  assert.equal(output.content[0].text,'REAL_REPLY');
});
test('new worker restores native stepIndex without a steps hash', async t => {
  const f = await fixture(t), first = await completedTurn(f);
  assert.equal(first.binding.stepIndex,0);
  await f.runtime.closeProcess();
  const second = await completedTurn(f,[...first.messages,user('after restart')]);
  assert.equal(second.flight.sessionId,`fork-${first.flight.sessionId}`);
  assert.ok(f.log.some(([kind,p])=>kind==='fork'&&p.forkAtStepIndex===0));
  assert.equal(second.output.diagnostics.some(d=>d.details?.action==='cold_import'),false);
});
test('unaccepted native tail is forked/reverted at the Pi checkpoint, never loaded blind', async t => {
  const f = await fixture(t), first = await completedTurn(f);
  await f.runtime.closeProcess();
  f.nativeSteps.push(doneStep('unaccepted native output'));
  const second = await completedTurn(f, [...first.messages, user('after restart')]);
  const fork = f.log.find(([kind]) => kind === 'fork')[1];
  assert.equal(fork.sourceCascadeId, first.flight.sessionId); assert.equal(fork.forkAtStepIndex, 0);
  assert.equal(second.flight.sessionId, `fork-${first.flight.sessionId}`);
  assert.equal(f.log.find(([kind]) => kind === 'revert')[1].cascadeId, second.flight.sessionId);
  assert.equal(f.log.some(([kind, id]) => kind === 'load' && id === first.flight.sessionId), false);
  assert.equal(second.output.diagnostics.find(d => d.type === 'agy_acp_recovery').details.action, 'fork_checkpoint');
});

test('legacy sessionId without stepIndex imports Pi history without a local proof requirement', async t => {
  const f = await fixture(t), first = await completedTurn(f);
  const binding = {...first.binding}; delete binding.stepIndex;
  await f.runtime.closeProcess(); restoreBinding(f,binding);
  const second = await completedTurn(f,[...first.messages,user('resume native session')]);
  assert.notEqual(second.flight.sessionId,first.flight.sessionId);
  assert.equal(f.log.some(([kind,id])=>kind==='load'&&id===first.flight.sessionId),false);
  assert.ok(second.output.diagnostics.some(d=>d.details?.action==='cold_import'));
});
for (const change of ['model', 'effort']) test(`v1 checkpoint survives ${change} selection via native fork, not cold import`, async t => {
  const f = await fixture(t), first = await completedTurn(f);
  const legacy = {...first.binding, version: 1};
  await f.runtime.closeProcess(); restoreBinding(f, legacy);
  const second = await completedTurn(f, [...first.messages, user('switch after upgrade')],
    model(change === 'model' ? 'fixture-b' : 'fixture-a'), {reasoning: change === 'effort' ? 'high' : undefined});
  assert.equal(second.flight.sessionId, `fork-${first.flight.sessionId}`);
  assert.equal(second.binding.version, 3);
  assert.equal(second.output.diagnostics.some(d => d.details?.action === 'cold_import'), false);
  assert.equal(f.log.some(([kind]) => kind === 'fork'), true);
});

test('tree navigation uses the matched older checkpoint instead of the current native tail', async t => {
  const f = await fixture(t), first = await completedTurn(f);
  await completedTurn(f, [...first.messages, user('other branch')]);
  f.branchMessages = first.messages;
  restoreBinding(f, first.binding); // Pi selected this accepted entry on the target branch.
  const branch = await completedTurn(f, [...first.messages, user('new branch')]);
  assert.equal(branch.flight.sessionId, `fork-${first.flight.sessionId}`);
  assert.equal(f.log.find(([kind]) => kind === 'fork')[1].forkAtStepIndex, first.binding.stepIndex);
  const forkAt = f.log.findIndex(([kind]) => kind === 'fork');
  const closeAt = f.log.findIndex(([kind]) => kind === 'close');
  const loadAt = f.log.findIndex(([kind, id]) => kind === 'load' && id === branch.flight.sessionId);
  assert.ok(forkAt < closeAt && closeAt < loadAt, 'retire the source worker before loading its fork');
});

for (const change of ['system', 'tools']) test(`${change} changes compile fresh metadata and start a new MCP catalog`, async t => {
  const f = await fixture(t), first = await completedTurn(f);
  f.compiledName = `fresh-${change}-agent`;
  const changedTool = {...tool, name: 'fresh_probe', description: 'Fresh tool description'};
  const messages = [...first.messages, user('continue')];
  messages[0] = change === 'system' ? system('New instructions') : {...system(), toolsAdded: [changedTool]};
  const second = await completedTurn(f, messages);
  assert.notEqual(second.flight.sessionId, first.flight.sessionId);
  const imported = await readImported(f, second.flight.sessionId);
  assert.equal(imported.metadata.agentScript.name, `fresh-${change}-agent`);
  assert.equal(second.output.diagnostics.find(d => d.type === 'agy_acp_recovery').details.reason, 'agent_system_or_tools_changed');
  assert.equal(f.prepared.at(-1).prompt, change === 'system' ? 'New instructions' : 'Fixture instructions');
  const catalog = (await f.rpc('tools/list').result).body.result.tools;
  assert.deepEqual(catalog.map(t => t.name), [change === 'tools' ? 'fresh_probe' : 'probe']);
  assert.ok(f.log.filter(([kind]) => kind === 'create').length >= 3, 'fresh compiler and loaded worker, not only catalogRevision');
});

test('actual transport env change restarts the worker without a file hash admission check', async t => {
  const f = await fixture(t), first = await completedTurn(f);
  f.runtime.processEnv = {...f.runtime.processEnv, HTTP_PROXY:'http://old-fixture-proxy'};
  const second = await completedTurn(f,[...first.messages,user('new transport')]);
  assert.ok(second.output.diagnostics.some(d=>d.details?.action==='restart_process'));
  assert.equal(second.output.diagnostics.some(d=>d.details?.action==='cold_import'),false);
});
test('external provider history and compacted context cannot return to an obsolete native tail', async t => {
  const f = await fixture(t), first = await completedTurn(f);
  const foreign = {...first.output, provider: 'external-provider', content: [{type: 'text', text: 'external provider reply'}]};
  const second = await completedTurn(f, [...first.messages, user('external turn'), foreign, user('back to AGY')]);
  assert.notEqual(second.flight.sessionId, first.flight.sessionId);
  const imported = await readImported(f, second.flight.sessionId);
  assert.ok(imported.steps.some(s => s.plannerResponse?.response === 'external provider reply'));
  f.runtime.invalidateProjection();
  const compacted = await completedTurn(f, [system(), user('Effective compacted summary'), user('next task')]);
  assert.notEqual(compacted.flight.sessionId, second.flight.sessionId);
  assert.equal(compacted.flight.content.map(p => p.text).join('\n'), 'Effective compacted summary\nnext task');
});

test('telemetry loss imports accepted Pi content instead of blindly loading native tail', async t => {
  const f = await fixture(t); f.telemetryError = new Error('fixture telemetry unavailable');
  const first = await completedTurn(f);
  assert.equal(first.binding.stepIndex,undefined);
  f.telemetryError = undefined; await f.runtime.closeProcess();
  const second = await completedTurn(f,[...first.messages,user('recover')]);
  assert.notEqual(second.flight.sessionId,first.flight.sessionId);
  assert.equal(f.log.some(([kind,id])=>kind==='load'&&id===first.flight.sessionId),false);
  assert.ok((await readImported(f,second.flight.sessionId)).steps.some(s=>s.plannerResponse?.response==='reply-1'));
});
test('slow native settings never acquire a replacement total tool deadline', async t => {
  const f = await fixture(t); t.mock.timers.enable({apis:['setTimeout']});
  const paused = await pauseForTool(f), entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.onConfig = async params => {if(params.configId==='thought_level'){entered.resolve();await release.promise;}};
  const next = f.runtime.stream(model('fixture-b'),{messages:[...paused.messages,paused.output,toolResult(paused.call)]},{reasoning:'xhigh'});
  await entered.promise; t.mock.timers.tick(3_600_000); await turn();
  assert.equal(f.log.some(([kind])=>kind==='cancel'),false);
  assert.equal(paused.pending.settled,false);
  release.resolve(); assert.equal((await paused.pending.result).body.result.content[0].text,'REAL_PI_RESULT');
  paused.flight.done.resolve({stopReason:'end_turn'});
  assert.equal((await next.result()).stopReason,'stop'); assert.equal(f.prompts.length,1);
});
test('any native settings failure stays visible without discarding a real waiting tool result', async t => {
  const f = await fixture(t), paused = await pauseForTool(f);
  f.onConfig = async () => {throw new Error('原生设置暂不可用');};
  const next = f.runtime.stream(model('fixture-b'),{messages:[...paused.messages,paused.output,toolResult(paused.call)]});
  assert.equal((await paused.pending.result).body.result.content[0].text,'REAL_PI_RESULT');
  paused.flight.done.resolve({stopReason:'end_turn'});
  const output=await next.result(); assert.equal(output.stopReason,'stop');
  assert.equal(output.diagnostics.find(d=>d.type==='agy_acp_settings_deferred').error.message,'原生设置暂不可用');
  assert.equal(f.log.some(([kind])=>kind==='cancel'),false);
});
test('real native fork errors remain visible rather than faking successful recovery', async t => {
  const f=await fixture(t),first=await completedTurn(f);await f.runtime.closeProcess();
  f.forkError=new Error('fixture actual ForkConversation failure');
  const output=await f.runtime.stream(model(),{messages:[...first.messages,user('recover')]}).result();
  assert.equal(output.stopReason,'error');assert.match(output.errorMessage,/actual ForkConversation/);
  assert.equal(f.prompts.length,1);
});
test('cancelled generation restores the last accepted checkpoint before retrying user input', async t => {
  const f = await fixture(t), first = await completedTurn(f);
  const messages = [...first.messages, user('retry this once')], controller = new AbortController();
  const attempt = f.runtime.stream(model(), {messages}, {signal: controller.signal});
  await f.waitPrompt(2);
  f.nativeSteps.push({status: 'CORTEX_STEP_STATUS_RUNNING', userInput: {userResponse: 'retry this once'}});
  controller.abort(new Error('fixture cancelled'));
  assert.equal((await attempt.result()).stopReason, 'aborted');
  const failedAttempt = {...first.output, stopReason: 'aborted', content: [{type: 'text', text: 'unaccepted output'}]};
  const retry = await completedTurn(f, [...first.messages, failedAttempt, messages.at(-1)]);
  assert.equal(retry.flight.sessionId, `fork-${first.flight.sessionId}`);
  assert.deepEqual(retry.flight.content, [{type: 'text', text: 'retry this once'}]);
  assert.equal(f.log.find(([kind]) => kind === 'fork')[1].forkAtStepIndex, first.binding.stepIndex);
});

test('invalid usage preserves generated text and reports unknown, not zero', async t => {
 const f=await fixture(t);f.nativeUsage=[{chatModel:{usage:{inputTokens:'9007199254740993',outputTokens:'12'}}}];
 const stream=f.runtime.stream(model(),{messages:initial()}),flight=await f.waitPrompt(1);
 f.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'NORMAL_TEXT_SURVIVES'}});
 flight.done.resolve({stopReason:'end_turn'});const output=await stream.result();
 assert.equal(output.stopReason,'stop');assert.equal(output.content[0].text,'NORMAL_TEXT_SURVIVES');
 assert.ok(Number.isNaN(output.usage.input));assert.ok(output.diagnostics.some(d=>d.type==='agy_acp_usage_unknown'&&d.details.invalidNativeUsage.length));
});
test('native permission accepts provided allow_always regardless of presentation kind', async t => {
 const f=await fixture(t),stream=f.runtime.stream(model(),{messages:initial()}),flight=await f.waitPrompt(1);
 const response=await f.processes[0].options.requestPermission({sessionId:flight.sessionId,
  toolCall:{name:'read_file',kind:'unrecognized-native-kind'},options:[{kind:'reject_once',optionId:'no'},{kind:'allow_always',optionId:'native-allow'}]});
 assert.equal(response.outcome.optionId,'native-allow');flight.done.resolve({stopReason:'end_turn'});
 assert.equal((await stream.result()).stopReason,'stop');
});
test('non-text content stays visible but late content is diagnostic-only without disconnecting', async t => {
 const f=await fixture(t),messages=initial(),first=f.runtime.stream(model(),{messages}),flight=await f.waitPrompt(1);
 f.update({sessionUpdate:'agent_message_chunk',content:{type:'resource',resource:{uri:'file:///actual',text:'VISIBLE_RESOURCE'}}});
 flight.done.resolve({stopReason:'end_turn'});const output=await first.result();
 assert.equal(output.stopReason,'stop');assert.ok(output.content[0].text.includes('VISIBLE_RESOURCE'));
 f.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'VISIBLE_LATE_BLOCK'}});
 const next=f.runtime.stream(model(),{messages:[...messages,output,user('continue')]});
 const second=await f.waitPrompt(2);second.done.resolve({stopReason:'end_turn'});
 const reply=await next.result();assert.equal(reply.stopReason,'stop');
 assert.equal(reply.content.some(part=>part.text?.includes('VISIBLE_LATE_BLOCK')),false);
 assert.ok(reply.diagnostics.some(d=>d.type==='agy_acp_late_content'&&d.details.content.text==='VISIBLE_LATE_BLOCK'));assert.equal(f.processes.length,1);
});
test('missing native configOptions and unadvertised IDs do not veto a prompt', async t => {
 const f=await fixture(t);f.onConfig=async()=>({});
 const stream=f.runtime.stream(model('not-in-local-options'),{messages:initial()},{reasoning:'xhigh'});
 const flight=await f.waitPrompt(1);flight.done.resolve({stopReason:'end_turn'});const output=await stream.result();
 assert.equal(output.stopReason,'stop');assert.ok(f.log.some(([kind,p])=>kind==='config'&&p.value==='not-in-local-options'));
 const report=output.diagnostics.findLast(d=>d.type==='agy_acp_native_settings').details;
 assert.equal(report.submitted,'xhigh');assert.equal(report.effectiveValue,null);
});


async function r1Finish(f, messages = initial(), options = {}, selected = model()) {
  const count = f.prompts.length + 1, stream = f.runtime.stream(selected, {messages}, options);
  const flight = await f.waitPrompt(count);
  f.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:`accepted-${count}`}});
  f.nativeSteps.push({status:'CORTEX_STEP_STATUS_DONE',plannerResponse:{response:`accepted-${count}`}});
  flight.done.resolve({stopReason:'end_turn'});
  const output = await stream.result();
  assert.equal(output.stopReason,'stop');
  return {messages:[...messages,output], output, binding:f.runtime.snapshot(), flight};
}
function r1Entries(messages, binding) {
  const entries = messages.map((message,i)=>({type:'message',id:`r1-${i}`,parentId:i?`r1-${i-1}`:null,message}));
  return [...entries,{type:'custom',id:'r1-checkpoint',parentId:entries.at(-1).id,
    customType:'pi-antigravity-acp-checkpoint',data:{...binding,piEntryId:entries.at(-1).id}}];
}
for (const change of ['none','edited','external','system','tools']) test(`reopened Pi branch reconstructs its own prefix: ${change}`,{timeout:10000},async t=>{
  const f=await fixture(t),first=await r1Finish(f);
  const entries=r1Entries(first.messages,first.binding);
  await f.runtime.close();
  f.runtime=new AcpRuntime(f.runtime.settings);t.after(()=>f.runtime.close());
  f.runtime.restore(entries);
  let messages=[...first.messages,user('next real input')];
  if(change==='edited') messages[1]=user('EDITED_PREFIX');
  if(change==='external') messages.splice(-1,0,user('foreign question'),{...first.output,provider:'external',content:[{type:'text',text:'FOREIGN_REPLY'}]});
  if(change==='system') messages[0]=system('NEW_SYSTEM');
  if(change==='tools') messages[0]={...system(),toolsAdded:[{...tool,description:'NEW_TOOL'}]};
  const second=await r1Finish(f,messages,{reasoning:'high'},model('fixture-b'));
  if(change==='none') {
    assert.ok(f.log.some(([kind,p])=>kind==='fork'&&p.forkAtStepIndex===first.binding.stepIndex));
    assert.equal(second.output.diagnostics.some(d=>d.details?.action==='cold_import'),false);
  } else {
    const imported=await readImported(f,second.flight.sessionId);
    assert.ok(second.output.diagnostics.some(d=>d.details?.action==='cold_import'));
    if(change==='edited') assert.equal(imported.steps[0].userInput.userResponse,'EDITED_PREFIX');
    if(change==='external') assert.ok(imported.steps.some(s=>s.plannerResponse?.response==='FOREIGN_REPLY'));
    if(change==='system') assert.equal(f.prepared.at(-1).prompt,'NEW_SYSTEM');
    if(change==='tools') assert.equal(f.prepared.at(-1).tools[0].description,'NEW_TOOL');
  }
});
test('restore preserves the live accepted baseline instead of forgetting edits',async t=>{
  const f=await fixture(t),first=await r1Finish(f);
  f.runtime.restore(r1Entries(first.messages,first.binding));
  const second=await r1Finish(f,[system(),user('EDIT_AFTER_RESTORE'),first.output,user('continue')]);
  assert.equal((await readImported(f,second.flight.sessionId)).steps[0].userInput.userResponse,'EDIT_AFTER_RESTORE');
});

test('legacy checkpoint after tool results cannot mistake those results for an accepted native prefix',async t=>{
  const f=await fixture(t),first=await r1Finish(f);
  await f.runtime.close();
  f.runtime=new AcpRuntime(f.runtime.settings);t.after(()=>f.runtime.close());
  const call={type:'toolCall',id:'legacy-real-call',name:'probe',arguments:{x:7}};
  const accepted={...first.output,stopReason:'toolUse',content:[call]};
  const messages=[...first.messages,user('later tool'),accepted,toolResult(call,'LEGACY_REAL_RESULT')];
  const entries=r1Entries(messages,{...first.binding,messageCount:messages.length});
  delete entries.at(-1).data.piEntryId; // Legacy checkpoint's parent is the result, not the assistant/cursor anchor.
  f.runtime.restore(entries);
  const next=await r1Finish(f,[...messages,user('continue')]);
  assert.ok((await readImported(f,next.flight.sessionId)).steps.some(s=>s.mcpTool?.resultString==='LEGACY_REAL_RESULT'));
});

test('missing telemetry preserves the accepted cursor and imports newer accepted Pi output on reopen',async t=>{
  const f=await fixture(t),first=await r1Finish(f);
  const count=f.prompts.length+1,messages=[...first.messages,user('accepted despite missing telemetry')];
  const stream=f.runtime.stream(model(),{messages}),flight=await f.waitPrompt(count);
  f.telemetryError=new Error('offline unavailable');
  f.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'TELEMETRY_LOSS_ACCEPTED'}});
  flight.done.resolve({stopReason:'end_turn'});const output=await stream.result();
  const binding=f.runtime.snapshot();
  assert.equal(binding.stepIndex,first.binding.stepIndex);assert.equal(binding.historyNeedsImport,true);
  f.telemetryError=undefined;await f.runtime.closeProcess();
  f.runtime.restore(r1Entries([...messages,output],binding));
  const next=await r1Finish(f,[...messages,output,user('next')]);
  assert.notEqual(next.flight.sessionId,first.flight.sessionId);
  assert.ok((await readImported(f,next.flight.sessionId)).steps.some(s=>s.plannerResponse?.response==='TELEMETRY_LOSS_ACCEPTED'));
});
test('process settings cache cannot turn an absent native report into old model confirmation',async t=>{
  const f=await fixture(t);f.onConfig=async p=>({configOptions:[{id:'model',currentValue:'old-native-model'}]});
  const first=await r1Finish(f);await f.runtime.closeProcess();
  assert.deepEqual(f.runtime.configOptions,[]);assert.equal(f.runtime.processEnv,undefined);
  f.onConfig=async()=>({});
  const second=await r1Finish(f,[...first.messages,user('new setting')],{},model('requested-new'));
  assert.equal(second.binding.model,'requested-new');
  assert.equal(second.binding.requestedModel,'requested-new');assert.equal(second.binding.reportedModel,undefined);
  assert.equal(second.output.diagnostics.find(d=>d.type==='agy_acp_native_settings').details.effectiveValue,null);
});
test('foreign and ended prompt notifications never become current text or context usage',async t=>{
  const f=await fixture(t),stream=f.runtime.stream(model(),{messages:initial()}),flight=await f.waitPrompt(1);
  const notify=(sessionId,phase,update)=>f.processes.at(-1).options.onUpdate({sessionId,update},{phase});
  notify('foreign','prompt',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'FOREIGN'}});
  notify('foreign','prompt',{sessionUpdate:'usage_update',used:424242});
  f.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OWN'}});
  flight.done.resolve({stopReason:'end_turn'});const output=await stream.result();
  notify(flight.sessionId,'idle',{sessionUpdate:'usage_update',used:434343});
  notify(flight.sessionId,'prompt',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ENDED'}});
  const second=await r1Finish(f,[...initial(),output,user('continue')]);
  assert.equal(output.content[0].text,'OWN');
  assert.equal(second.output.content[0].text,'accepted-2');
  assert.notEqual(output.usage.totalTokens,424242);assert.notEqual(second.output.usage.totalTokens,434343);
  assert.ok(second.output.diagnostics.some(d=>d.type==='agy_acp_late_content'));
  assert.equal(f.processes.length,1);
});
test('permission uses partial ACP call state and the read-only profile, not a mandatory name field',async t=>{
  const f=await fixture(t),stream=f.runtime.stream(model(),{messages:initial()}),flight=await f.waitPrompt(1);
  const request=(toolCall,sessionId=flight.sessionId)=>f.processes[0].options.requestPermission({sessionId,toolCall,
    options:[{optionId:'no',kind:'reject_once'},{optionId:'yes',kind:'allow_always'}]});
  assert.equal((await request({toolCallId:'nameless',kind:'read',rawInput:{Path:'/fixture/file'}})).outcome.optionId,'yes');
  f.update({sessionUpdate:'tool_call',toolCallId:'partial',name:'read_file',kind:'read'});
  assert.equal((await request({toolCallId:'partial'})).outcome.optionId,'yes');
  assert.equal((await request({toolCallId:'bridge',name:'mcp_acp-tools_probe',kind:'other'})).outcome.optionId,'yes');
  assert.equal((await request({toolCallId:'foreign-bridge',name:'mcp_other_probe',kind:'other'})).outcome.outcome,'cancelled');
  assert.equal((await request({toolCallId:'unknown-bridge',name:'mcp_acp-tools_unpublished',kind:'other'})).outcome.outcome,'cancelled');
  assert.equal((await request({toolCallId:'shell',name:'run_command',kind:'execute'})).outcome.outcome,'cancelled');
  assert.equal((await request({toolCallId:'read',name:'read_file'},'foreign')).outcome.outcome,'cancelled');
  flight.done.resolve({stopReason:'end_turn'});assert.equal((await stream.result()).stopReason,'stop');
});

test('optional malformed monitor configuration cannot veto a generated reply or erase inherited proxy intent',async t=>{
 const f=await fixture(t),prior=process.env.HTTPS_PROXY;
 process.env.HTTPS_PROXY='http://fixture-inherited-proxy';
 t.after(()=>{if(prior===undefined)delete process.env.HTTPS_PROXY;else process.env.HTTPS_PROXY=prior;});
 await writeFile(process.env.PI_AGY_NETWORK_MONITOR_CONFIG,'{invalid json');
 const stream=f.runtime.stream(model(),{messages:initial()}),flight=await f.waitPrompt(1);
 assert.equal(f.processes[0].options.env.HTTPS_PROXY,'http://fixture-inherited-proxy');
 f.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'NORMAL_WITH_MONITOR_ERROR'}});
 flight.done.resolve({stopReason:'end_turn'});const output=await stream.result();
 assert.equal(output.stopReason,'stop');assert.equal(output.content[0].text,'NORMAL_WITH_MONITOR_ERROR');
 assert.ok(output.diagnostics.some(d=>d.type==='agy_acp_monitor_unavailable'));
});

test('mid-turn dynamic tool activation updates live MCP bridge without cancelling the active native turn',async t=>{
  const f=await fixture(t),lateTool={name:'late_fixture',description:'Dynamically activated tool',
    parameters:{type:'object',properties:{y:{type:'string'}},required:['y']}};
  const codemodeTool={name:'codemode',description:'Run JS sandbox',
    parameters:{type:'object',properties:{code:{type:'string'}},required:['code']}};
  const sys1={role:'system',content:'Fixture instructions',toolsAdded:[tool,codemodeTool],timestamp:0};
  const s1=f.runtime.stream(model(),{messages:[sys1,user('Enable and call late_fixture')]}),flight=await f.waitPrompt(1);
  const enableRpc=f.rpc('tools/call',{name:'codemode',arguments:{code:'await tools.enable_fixture({})'}});
  const r1=await s1.result();
  assert.equal(r1.stopReason,'toolUse');
  const firstCall=r1.content.find(part=>part.type==='toolCall');
  assert.equal(firstCall.name,'codemode');

  // Simulate codemode calling pi.setActiveTools to add late_fixture before returning its toolResult.
  const sys2={role:'system',content:'Fixture instructions',toolsAdded:[tool,codemodeTool,lateTool],timestamp:2};
  const messagesAfterEnable=[sys1,user('Enable and call late_fixture'),r1,sys2,toolResult(firstCall,'enabled')];
  const s2=f.runtime.stream(model(),{messages:messagesAfterEnable});
  const enableBody=(await enableRpc.result).body.result;
  assert.equal(enableBody.content[0].text,'enabled');
  assert.equal(f.processes.length,1,'must not restart AGY process mid-turn');
  assert.equal(f.prompts.length,1,'must keep the same in-flight ACP prompt');
  assert.ok(!f.log.some(entry=>entry[0]==='cancel'),'must not cancel the active native turn');

  // Newly activated tool is immediately listed on MCP, permitted via call_mcp_tool, and has a synced schema file.
  const listed=(await f.rpc('tools/list').result).body.result.tools.map(entry=>entry.name);
  assert.ok(listed.includes('late_fixture'));
  const schemaJson=JSON.parse(await readFile(join(f.directory,'schemas','acp-tools','late_fixture.json'),'utf8'));
  assert.equal(schemaJson.targetName,'late_fixture');
  const permission=await f.processes[0].options.requestPermission({
    sessionId:flight.sessionId,
    toolCall:{toolCallId:'late-perm',name:'call_mcp_tool',kind:'other',
      rawInput:{ServerName:'acp-tools',ToolName:'late_fixture',Arguments:{y:'ok'}}},
    options:[{optionId:'allow',kind:'allow_always'}],
  });
  assert.equal(permission.outcome.optionId,'allow');

  // Invoke late_fixture in the same native turn and finish cleanly.
  const lateRpc=f.rpc('tools/call',{name:'late_fixture',arguments:{y:'ok'}});
  const r2=await s2.result();
  assert.equal(r2.stopReason,'toolUse');
  const secondCall=r2.content.find(part=>part.type==='toolCall');
  assert.equal(secondCall.name,'late_fixture');
  const messagesAfterLate=[...messagesAfterEnable,r2,toolResult(secondCall,'LATE_OK')];
  const s3=f.runtime.stream(model(),{messages:messagesAfterLate});
  assert.equal((await lateRpc.result).body.result.content[0].text,'LATE_OK');
  f.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'DONE_SAME_TURN'}});
  flight.done.resolve({stopReason:'end_turn'});
  const r3=await s3.result();
  assert.equal(r3.stopReason,'stop');
  assert.equal(r3.content[0].text,'DONE_SAME_TURN');
  assert.equal(f.runtime.snapshot().historyNeedsImport,true,'compiled agent snapshot lags dynamic tools until next idle turn');

  // Next idle user turn refreshes agent.md with late_fixture and imports call_mcp_tool history cleanly.
  const s4=f.runtime.stream(model(),{messages:[...messagesAfterLate,r3,user('Next turn')]});
  const nextFlight=await f.waitPrompt(2);
  assert.equal(f.prepared.at(-1).tools.some(entry=>entry.name==='late_fixture'),true);
  f.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'NEXT_OK'}});
  nextFlight.done.resolve({stopReason:'end_turn'});
  assert.equal((await s4.result()).content[0].text,'NEXT_OK');
});

test('legacy pi-acp checkpoint upgrades via cold_import to acp-tools without losing history',async t=>{
  const f=await fixture(t),first=await completedTurn(f);
  const legacy={...first.binding};delete legacy.bridgeServer;
  const legacyAgentDir=join(f.directory,'gemini','config','agents','pi-acp-pi-acp');
  await mkdir(legacyAgentDir,{recursive:true});
  await writeFile(join(legacyAgentDir,'agent.md'),'legacy pi-acp agent');
  await f.runtime.closeProcess();restoreBinding(f,legacy);
  const second=await completedTurn(f,[...first.messages,user('upgrade to acp-tools')]);
  assert.notEqual(second.flight.sessionId,first.flight.sessionId);
  assert.equal(f.log.some(([kind])=>kind==='fork'),false,'must cold-import instead of forking stale pi-acp agent');
  assert.ok(second.output.diagnostics.some(d=>d.details?.action==='cold_import'));
  assert.equal(second.binding.bridgeServer,'acp-tools');
});
