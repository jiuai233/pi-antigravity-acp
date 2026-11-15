import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {ModelCatalog, defaultModelCatalogIo} from '../src/model-catalog.ts';

const models = [{id: 'fixture-live-only', name: 'Fixture live only', supportedEfforts: ['high'], defaultEffort: 'high'}];
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-acp-catalog-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}

test('successful ACP discovery survives reload, expires by TTL, and failed refresh preserves success', async t => {
  const dir = await directory(t), io = defaultModelCatalogIo(dir);
  let calls = 0, failure;
  io.listModels = async () => { calls++; if (failure) throw failure; return models; };
  const catalog = new ModelCatalog(dir, io);
  assert.equal(catalog.cache.source, 'fallback'); assert.equal(catalog.isFresh(), false);
  await catalog.refresh();
  assert.equal(calls, 1); assert.deepEqual(catalog.models, models); assert.equal(catalog.isFresh(), true);
  const saved = JSON.parse(await readFile(join(dir, 'model-list.json'), 'utf8'));
  assert.equal(saved.source, 'live'); assert.ok(saved.fetchedAt);
  const reloaded = new ModelCatalog(dir);
  assert.deepEqual(reloaded.models, models); assert.equal(reloaded.loadedFrom, 'disk'); assert.equal(reloaded.isFresh(), true);
  t.mock.method(Date, 'now', () => saved.fetchedAt + 25 * 60 * 60 * 1000);
  assert.equal(reloaded.isFresh(), false);
  failure = new Error('offline catalog unavailable');
  const result = await catalog.refresh();
  assert.equal(result.discoveryError, failure); assert.equal(result.fetchedAt, saved.fetchedAt);
  assert.deepEqual(result.models, models);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'model-list.json'), 'utf8')), saved);
  assert.equal(catalog.diagnostics().discoveryError, failure.message);
});

test('first discovery failure keeps bundled fallback without inventing a success time; concurrent refresh is shared', async t => {
  const dir = await directory(t), gate = Promise.withResolvers(); let calls = 0;
  const catalog = new ModelCatalog(dir, {readCache: () => null, writeCache: () => assert.fail('failure must not write'),
    listModels: () => { calls++; return gate.promise; }});
  const fallback = structuredClone(catalog.models), a = catalog.refresh(), b = catalog.refresh();
  assert.equal(a, b); assert.equal(calls, 1);
  gate.reject(new Error('models failed'));
  await a;
  assert.deepEqual(catalog.models, fallback); assert.equal(catalog.cache.fetchedAt, undefined); assert.equal(catalog.isFresh(), false);
});

test('empty discovery and bad cache remain visible; disk write failure does not discard usable live models', async t => {
  const dir = await directory(t);
  await writeFile(join(dir, 'model-list.json'), '{bad json');
  const io = defaultModelCatalogIo(dir); io.listModels = async () => [];
  const catalog = new ModelCatalog(dir, io);
  assert.ok(catalog.cacheReadError instanceof SyntaxError);
  await catalog.refresh(); assert.ok(catalog.cache.discoveryError); assert.equal(catalog.cache.source, 'fallback');
  io.listModels = async () => models; io.writeCache = () => { throw new Error('fixture write denied'); };
  await catalog.refresh();
  assert.deepEqual(catalog.models, models); assert.equal(catalog.cache.source, 'live');
  assert.equal(catalog.cache.discoveryError, undefined); assert.equal(catalog.diagnostics().cacheWriteError, 'fixture write denied');
  io.listModels = async () => { throw new Error('later discovery failed'); };
  await catalog.refresh(); assert.deepEqual(catalog.models, models);
});
