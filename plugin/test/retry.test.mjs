import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {findPackageJSON} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {createAssistantMessageEventStream, isContextOverflow, isRetryableAssistantError, retryAssistantCall} from '@earendil-works/pi-ai';
import {MessageWriter, NATIVE_FAILURE_SUMMARY} from '../src/message-writer.ts';

const sdkRoot = process.env.PI_STACK_PI_ROOT ?? path.dirname(findPackageJSON('@earendil-works/pi-coding-agent', import.meta.url));
const {createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager} =
  await import(pathToFileURL(path.join(sdkRoot, 'dist/index.js')).href);
const PROVIDER = 'antigravity-acp';
const raw503 = 'UNAVAILABLE (code 503): native model temporarily unavailable';
const modelDef = {id: 'offline-retry', name: 'Offline retry fixture', reasoning: false, input: ['text'], contextWindow: 10000,
  maxTokens: 1024, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};
function blank(provider = PROVIDER) {
  return {role: 'assistant', api: provider, provider, model: modelDef.id, content: [], stopReason: 'stop', timestamp: Date.now(),
    usage: {input: 11, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 13, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}};
}
function failure(raw, {native = true, aborted = false, provider = PROVIDER} = {}) {
  const stream = createAssistantMessageEventStream(), output = blank(provider), writer = new MessageWriter(output, stream);
  writer.start();
  if (native) writer.diagnostic({type: 'agy_acp_native_error', timestamp: 0, details: {error: {shortError: raw}, stepIndex: 1}});
  writer.fail(new Error(raw), aborted);
  return stream;
}

test('native terminal errors remain failures with exact visible diagnostics, not a second retry engine', async t => {
  for (const raw of [raw503, 'RESOURCE_EXHAUSTED (code 429): daily request limit reached',
    'INVALID_ARGUMENT (code 400): invalid timeout field', 'PERMISSION_DENIED (code 403): account terminated']) {
    await t.test(raw, async () => {
      const stream = failure(raw), events = [];
      for await (const event of stream) events.push(event);
      const message = await stream.result();
      assert.equal(message.stopReason, 'error');
      assert.equal(message.errorMessage, NATIVE_FAILURE_SUMMARY);
      assert.equal(isRetryableAssistantError(message), false);
      assert.ok(message.content.some(c => c.type === 'text' && c.text.includes(raw)));
      assert.equal(message.diagnostics.find(d => d.type === 'agy_acp_native_recovery_finished').error.message, raw);
      assert.equal(events.at(-1).type, 'error');
      assert.ok(events.some(e => e.type === 'text_delta' && e.delta.includes(raw)));
      assert.equal(events.filter(e => e.type === 'error').length, 1);
      assert.ok(!events.some(e => e.type === 'done'));
    });
  }
  const overflow = await failure('context_length_exceeded: input is too long').result();
  assert.equal(isContextOverflow(overflow, modelDef.contextWindow), true);
  assert.equal(overflow.errorMessage, 'context_length_exceeded: input is too long');
  const aborted = await failure(raw503, {aborted: true}).result();
  assert.equal(aborted.stopReason, 'aborted'); assert.equal(aborted.errorMessage, raw503);
  const transport = await failure('network error: ACP disconnected', {native: false}).result();
  assert.equal(transport.errorMessage, 'network error: ACP disconnected');
  assert.equal(isRetryableAssistantError(transport), true);
});

test('real Pi SDK: native terminal stops once, transport/other provider still retry, tools and next user turn remain usable', {timeout: 30000}, async t => {
  for (const kind of ['native', 'transport', 'other-provider', 'tool-then-native']) await t.test(kind, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pi-acp-retry-'));
    const agentDir = path.join(root, 'agent');
    await mkdir(agentDir); await writeFile(path.join(agentDir, 'auth.json'), '{}');
    let session, calls = 0, effects = 0, retries = 0, explicitNextTurn = false;
    const provider = kind === 'other-provider' ? 'offline-other-provider' : PROVIDER;
    const settingsManager = SettingsManager.inMemory({cacheWarming: 'off', retry: {enabled: true, maxRetries: 2, baseDelayMs: 1, maxAgentDelayMs: 2}, compaction: {enabled: false}});
    try {
      const modelRuntime = await ModelRuntime.create({authPath: path.join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false});
      modelRuntime.registerProvider(provider, {api: provider, baseUrl: 'offline://no-network', apiKey: 'offline-fixture', models: [modelDef], streamSimple() {
        calls++;
        if (explicitNextTurn || (kind === 'tool-then-native' && calls === 1)) {
          const stream = createAssistantMessageEventStream(), writer = new MessageWriter(blank(provider), stream);
          writer.start();
          if (explicitNextTurn) { writer.append('text', 'EXPLICIT_NEXT_TURN_OK'); writer.finish('stop'); }
          else { writer.tool({type: 'toolCall', id: 'one-effect', name: 'offline_effect', arguments: {}}); writer.finish('toolUse'); }
          return stream;
        }
        return failure(kind === 'transport' ? 'network error: ACP disconnected' : raw503, {provider, native: kind === 'native' || kind === 'tool-then-native'});
      }});
      const loader = new DefaultResourceLoader({cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        agentsFilesOverride: () => ({agentsFiles: []}), extensionFactories: [pi => {
          pi.registerTool({name: 'offline_effect', label: 'Offline effect', description: 'Count one isolated effect', parameters: {type: 'object', properties: {}, additionalProperties: false},
            async execute() { effects++; return {content: [{type: 'text', text: 'EFFECT_DONE'}], details: {effects}}; }});
        }]});
      await loader.reload();
      ({session} = await createAgentSession({cwd: root, agentDir, modelRuntime, model: modelRuntime.getModel(provider, modelDef.id), thinkingLevel: 'off', settingsManager,
        resourceLoader: loader, sessionManager: SessionManager.create(root, path.join(root, 'sessions')), tools: kind === 'tool-then-native' ? ['offline_effect'] : []}));
      await session.bindExtensions({});
      const ended = [];
      session.subscribe(e => { if (e.type === 'auto_retry_start') retries++; if (e.type === 'message_end' && e.message.role === 'assistant') ended.push(structuredClone(e.message)); });
      await session.prompt('Offline retry fixture');
      const native = kind === 'native' || kind === 'tool-then-native';
      assert.equal(calls, kind === 'tool-then-native' ? 2 : native ? 1 : 3);
      assert.equal(retries, native ? 0 : 2);
      const last = ended.at(-1);
      assert.equal(last.stopReason, 'error'); assert.equal(last.provider, provider); assert.equal(last.api, provider);
      if (native) {
        const stored = session.sessionManager.getBranch().findLast(e => e.type === 'message' && e.message.role === 'assistant').message;
        assert.equal(stored.errorMessage, NATIVE_FAILURE_SUMMARY);
        assert.ok(stored.content.some(c => c.type === 'text' && c.text.includes(raw503)));
        assert.equal(stored.diagnostics.find(d => d.type === 'agy_acp_native_recovery_finished').error.message, raw503);
        assert.deepEqual(stored.usage, last.usage);
        explicitNextTurn = true;
        await session.prompt('Explicit user continuation');
        assert.equal(ended.at(-1).stopReason, 'stop');
        assert.equal(calls, kind === 'tool-then-native' ? 3 : 2);
      }
      assert.equal(effects, kind === 'tool-then-native' ? 1 : 0);
      assert.equal(settingsManager.getRetryEnabled(), true);
    } finally { session?.dispose(); await rm(root, {recursive: true, force: true}); }
  });
});

test('summary retry consumer sees the same provider-level native failure policy without message_end hooks', async () => {
  for (const native of [false, true]) {
    let calls = 0;
    const result = await retryAssistantCall(async () => { calls++; return failure(raw503, {native}).result(); },
      {enabled: true, maxRetries: 2, baseDelayMs: 1, maxAgentDelayMs: 2});
    assert.equal(calls, native ? 1 : 3);
    assert.equal(result.stopReason, 'error');
  }
});
