import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fitBridgeToolOutput, MAX_BRIDGE_OUTPUT_BYTES} from '../src/bridge/output.ts';

test('large tool output retains a readable full archive and bounded UTF-8 head/tail', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-acp-output-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const text = `HEAD\n${'正文\n'.repeat(5000)}TAIL`;
  const fitted = fitBridgeToolOutput(text, {directory});
  assert.ok(Buffer.byteLength(fitted, 'utf8') <= MAX_BRIDGE_OUTPUT_BYTES);
  const wrapped = `Created At: 2026-11-13T20:00:00+08:00\nCompleted At: 2026-11-13T20:00:01+08:00\n${fitted}`;
  assert.ok(Buffer.byteLength(wrapped, 'utf8') <= 10240);
  assert.ok(fitted.includes('HEAD') && fitted.endsWith('TAIL'));
  const file = JSON.parse(fitted.match(/Full output: (".*?")\./)[1]);
  assert.equal(await readFile(file, 'utf8'), text);
  assert.ok(fitted.includes('native read_file tool with Path='));
  assert.equal(fitted.includes('view_file'), false);
  assert.equal(fitBridgeToolOutput('small'), 'small');
});
