import assert from 'node:assert/strict';
import test from 'node:test';
import {toProviderModel} from '../src/models.ts';

test('parallel ACP models have distinct labels without changing wire model IDs', () => {
  const original = {id:'gemini-4-hydrogen',name:'Gemini 4 Hydrogen',supportedEfforts:['low','high','xhigh']};
  const model = toProviderModel(original);
  assert.equal(model.id, original.id);
  assert.equal(model.name, 'Gemini 4 Hydrogen (ACP)');
  assert.equal(original.name, 'Gemini 4 Hydrogen');
  assert.deepEqual(model.thinkingLevelMap, {xhigh:'xhigh'});
});

test('a stale local effort table does not hide the requested native xhigh setting',()=>{
 const model=toProviderModel({id:'unknown-native-model',name:'Native model',supportedEfforts:[]});
 assert.deepEqual(model.thinkingLevelMap,{xhigh:'xhigh'});
 assert.deepEqual(model.input,['text','image']);
});
