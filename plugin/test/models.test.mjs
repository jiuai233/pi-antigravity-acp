import assert from 'node:assert/strict';
import test from 'node:test';
import {pricingForModel, toProviderModel} from '../src/models.ts';

test('Gemini 4 Neon uses standard API pricing for estimates', () => {
  const pricing = {input: 3, output: 15, cacheRead: 0.15, cacheWrite: 0};
  assert.deepEqual(pricingForModel('gemini-4-neon'), pricing);
  assert.deepEqual(toProviderModel({id: 'gemini-4-neon', name: 'Neon', supportedEfforts: []}).cost, pricing);
});

test('parallel ACP models have distinct labels without changing wire model IDs', () => {
  const original = {id:'gemini-4-hydrogen',name:'Gemini 4 Hydrogen',supportedEfforts:['low','high','xhigh']};
  const model = toProviderModel(original);
  assert.equal(model.id, original.id);
  assert.equal(model.name, 'Gemini 4 Hydrogen (ACP)');
  assert.equal(original.name, 'Gemini 4 Hydrogen');
  assert.deepEqual(model.thinkingLevelMap, {xhigh:'xhigh'});
});

test('Claude 5.5 uses the observed 840K window; Gemini and GPT retain their limits', () => {
  for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5']) {
    assert.equal(toProviderModel({id, name: id, supportedEfforts: []}).contextWindow, 840_000);
  }
  assert.equal(toProviderModel({id: 'gemini-4-neon', name: 'Neon', supportedEfforts: []}).contextWindow, 512_000);
  assert.equal(toProviderModel({id: 'gpt-oss-120b', name: 'GPT', supportedEfforts: []}).contextWindow, 98_304);
});

test('a stale local effort table does not hide the requested native xhigh setting',()=>{
 const model=toProviderModel({id:'unknown-native-model',name:'Native model',supportedEfforts:[]});
 assert.deepEqual(model.thinkingLevelMap,{xhigh:'xhigh'});
 assert.deepEqual(model.input,['text','image']);
});
