import assert from 'node:assert/strict';
import test from 'node:test';
import {bridgeToolName, bridgeToolNames} from '../src/bridge/names.ts';

test('invalid and long names receive stateless readable deterministic aliases instead of vetoing their catalog', () => {
  const longA = `${'mcp__provider_alpha__'.repeat(3)}query_records_alpha`;
  const longB = `${'mcp__provider_alpha__'.repeat(3)}query_records_bravo`;
  const raw = ['ordinary', '工具.读取', longA, longB, 'pi_tool_1'];
  const aliases = bridgeToolNames('pi-acp', raw, '');
  const reversed = bridgeToolNames('pi-acp', [...raw].reverse(), '');
  assert.equal(aliases.size, raw.length);
  for (const name of raw) {
    const alias = bridgeToolName('pi-acp', name, '');
    assert.match('mcp_pi-acp_' + alias, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.equal(aliases.get(alias), name);
    assert.equal(reversed.get(alias), name, 'aliases must not depend on registration order');
  }
  assert.ok(bridgeToolName('pi-acp', longA, '').startsWith('mcp__provider_alpha__'));
  assert.notEqual(bridgeToolName('pi-acp', longA, ''), bridgeToolName('pi-acp', longB, ''));

  const literalCollision = bridgeToolName('pi-acp', longA, '');
  assert.throws(
    () => bridgeToolNames('pi-acp', [longA, literalCollision], ''),
    /collision/i,
  );
});
