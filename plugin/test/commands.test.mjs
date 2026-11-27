import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import test from 'node:test';
import extension from '../index.ts';
import {ModelCatalog} from '../src/model-catalog.ts';
import {AcpRuntime, BINDING_ENTRY, PROVIDER, RESET_ENTRY} from '../src/runtime.ts';

async function fixture(t, provider = 'other') {
  const directory = await mkdtemp(join(tmpdir(), 'pi-acp-command-'));
  const previous = {state: process.env.AGY_ACP_STATE_DIR, binary: process.env.AGY_BINARY};
  process.env.AGY_ACP_STATE_DIR = directory;
  process.env.AGY_BINARY = join(directory, 'fake-binary');
  await writeFile(process.env.AGY_BINARY, 'not executable; path resolution only');
  const handlers = new Map(), commands = new Map(), entries = [], notifications = [], registered = [];
  let selected = {provider, id: 'fixture-other'}, runtime, catalog, calls = 0, failure;
  const original = ModelCatalog.prototype.refresh;
  t.mock.method(ModelCatalog.prototype, 'refresh', function () {
    catalog = this;
    this.io.listModels = async () => {
      calls++;
      if (failure) throw failure;
      return [{id: 'fixture-discovered', name: 'Discovered', supportedEfforts: ['high']}];
    };
    return original.call(this);
  });
  t.mock.method(AcpRuntime.prototype, 'restore', function () { runtime = this; });
  const lifecycle = [];
  t.mock.method(AcpRuntime.prototype, 'reset', async function () { lifecycle.push('reset'); });
  t.mock.method(AcpRuntime.prototype, 'stopNative', async () => { lifecycle.push('stop'); });
  extension({
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    registerProvider: (_name, config) => registered.push(config),
    appendEntry: (customType, data) => entries.push({type: 'custom', customType, data}),
  });
  const statuses = [];
  const ctx = {cwd: resolve('.'), hasUI: true, mode: 'tui', get model() { return selected; },
    sessionManager: {getSessionId: () => 'fixture', getBranch: () => entries},
    abort: async () => { lifecycle.push('abort'); }, waitForIdle: async () => { lifecycle.push('idle'); },
    ui: {
      notify: (text, level) => notifications.push({text, level}),
      setStatus: (key, text) => statuses.push({key, text}),
    },
  };
  t.after(async () => {
    try { await handlers.get('session_shutdown')(); }
    finally {
      if (previous.state === undefined) delete process.env.AGY_ACP_STATE_DIR; else process.env.AGY_ACP_STATE_DIR = previous.state;
      if (previous.binary === undefined) delete process.env.AGY_BINARY; else process.env.AGY_BINARY = previous.binary;
      await rm(directory, {recursive: true, force: true});
    }
  });
  await handlers.get('session_start')({}, ctx);
  return {ctx, handlers, commands, entries, notifications, statuses, registered, lifecycle,
    command: args => commands.get('agy-acp').handler(args, ctx),
    complete: prefix => commands.get('agy-acp').getArgumentCompletions(prefix),
    get calls() { return calls; }, get runtime() { return runtime; }, get catalog() { return catalog; },
    select: async provider => { selected = {provider, id: 'fixture'}; await handlers.get('model_select')({model: selected}, ctx); },
    fail: error => { failure = error; }};
}

test('automatic catalog discovery is ACP-only and TTL-gated; models forces refresh and failure retains registered models', async t => {
  const f = await fixture(t);
  assert.equal(f.calls, 0);
  await f.handlers.get('before_agent_start')({}, f.ctx); assert.equal(f.calls, 0);
  await f.select(PROVIDER); assert.equal(f.calls, 1);
  assert.ok(f.registered.at(-1).models.some(model => model.id === 'fixture-discovered'));
  await f.handlers.get('before_agent_start')({}, f.ctx); assert.equal(f.calls, 1);
  await f.select('other'); assert.equal(f.calls, 1);
  f.fail(new Error('fixture catalog offline'));
  await f.command('models'); assert.equal(f.calls, 2);
  assert.ok(f.registered.at(-1).models.some(model => model.id === 'fixture-discovered'));
  assert.equal(f.notifications.at(-1).level, 'warning'); assert.match(f.notifications.at(-1).text, /fixture catalog offline/);
  // Fresh successful disk cache is usable at a later session start without another AGY launch.
  await f.handlers.get('session_start')({}, f.ctx); assert.equal(f.calls, 2);
});

test('an ACP session start discovers a missing catalog and reload uses the persisted success', async t => {
  const f = await fixture(t, PROVIDER);
  assert.equal(f.calls, 1);
  await f.handlers.get('session_start')({}, f.ctx);
  assert.equal(f.calls, 1);
  const cached = new ModelCatalog(process.env.AGY_ACP_STATE_DIR);
  assert.equal(cached.loadedFrom, 'disk'); assert.equal(cached.isFresh(), true);
  assert.ok(cached.models.some(model => model.id === 'fixture-discovered'));
});

test('reset persists a custom marker, clears pending checkpoints and never sends a model message', async t => {
  const f = await fixture(t);
  f.runtime.settings.onBinding({conversationId: 'stale', model: 'fixture', version: 3, messageCount: 3, wireOnlyInput: false});
  await f.command('reset');
  assert.deepEqual(f.lifecycle, ['abort', 'idle', 'reset']);
  assert.equal(f.entries.at(-1).customType, RESET_ENTRY);
  await f.handlers.get('turn_end')({}, f.ctx);
  assert.ok(!f.entries.some(entry => entry.customType === BINDING_ENTRY));
  assert.equal(f.calls, 0);
});

test('doctor only reports local binary/runtime/catalog facts without starting generation or discovery', async t => {
  const f = await fixture(t);
  await f.command('doctor');
  const result = JSON.parse(f.notifications.at(-1).text);
  assert.equal(result.runtime.live, false); assert.equal(result.runtime.pendingTools, 0);
  assert.ok(result.runtime.binary.endsWith('fake-binary'));
  assert.equal(result.catalog.source, 'fallback'); assert.equal(f.calls, 0);
  assert.equal(f.entries.length, 0); assert.deepEqual(f.lifecycle, []);
  const text = f.notifications.at(-1).text;
  assert.ok(!text.includes(f.runtime.token));
  assert.ok(result.prefixAudit && typeof result.prefixAudit.summary === 'string' && Array.isArray(result.prefixAudit.details));
});

test('cache subcommand and status bar behave cleanly without registering /agy-usage', async t => {
  const f = await fixture(t, PROVIDER);
  assert.equal(f.commands.has('agy-usage'), false);
  assert.ok(f.statuses.some(s => s.key === 'agy-cache' && /AGY/.test(String(s.text))));
  await f.command('cache');
  assert.match(f.notifications.at(-1).text, /prefix audit: v1/);
  await f.select('other');
  assert.equal(f.statuses.at(-1).key, 'agy-cache');
  assert.equal(f.statuses.at(-1).text, undefined);

  const all = f.complete('');
  assert.deepEqual(all.map(item => item.value), ['status', 'cache', 'doctor', 'models', 'reset']);
  assert.deepEqual(f.complete('re').map(item => item.value), ['reset']);
  assert.equal(f.complete('unknown'), null);
});

test('reset clears in-memory prefix audit status alongside runtime binding', async t => {
  const f = await fixture(t, PROVIDER);
  await f.command('reset');
  assert.equal(f.statuses.at(-1).key, 'agy-cache');
  assert.match(String(f.statuses.at(-1).text), /等待原生采样/);
});
