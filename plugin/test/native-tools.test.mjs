import assert from 'node:assert/strict';
import test from 'node:test';
import {NativeToolRecords} from '../src/native-tools.ts';

const start = (extra = {}) => ({sessionUpdate: 'tool_call', toolCallId: 'read-1', name: 'read_file',
  title: 'File /fixture/probe.mp4', status: 'pending', rawInput: {Path: '/fixture/probe.mp4'}, ...extra});
const update = extra => ({sessionUpdate: 'tool_call_update', toolCallId: 'read-1', ...extra});
const anchor = () => ({messageTimestamp: 42, contentIndex: 2});

test('read_file snapshots fix the first anchor, preserve path/line bounds and omit unchanged notifications', () => {
  const records = new NativeToolRecords();
  let anchors = 0;
  const first = records.reduce('native', start({rawInput: {Path: '/fixture/probe.mp4', StartLine: 1, EndLine: 400}}), () => { anchors++; return anchor(); }, 100);
  assert.deepEqual(first, {version: 1, id: 'native:read-1', provider: 'antigravity-acp', ...anchor(),
    toolName: 'read_file', title: 'File /fixture/probe.mp4', status: 'pending',
    input: {Path: '/fixture/probe.mp4', StartLine: 1, EndLine: 400}, startedAt: 100, updatedAt: 100});
  const neverAnchor = () => assert.fail('updates cannot move the anchor');
  assert.equal(records.reduce('native', start({rawInput: {Path: '/fixture/probe.mp4', StartLine: 1, EndLine: 400}}), neverAnchor, 101), undefined);
  const running = records.reduce('native', update({status: 'in_progress'}), neverAnchor, 102);
  const done = records.reduce('native', update({status: 'completed'}), neverAnchor, 103);
  assert.deepEqual([first, running, done].map(x => x.status), ['pending', 'in_progress', 'completed']);
  assert.equal(new Set([first.id, running.id, done.id]).size, 1);
  assert.deepEqual(done, {...first, status: 'completed', updatedAt: 103});
  assert.equal(done.output, undefined, 'no video output or frames were supplied');
  assert.equal(records.reduce('native', update({status: 'completed'}), neverAnchor, 104), undefined);
  assert.equal(anchors, 1);
  done.input.Path = 'callback mutation';
  assert.equal(records.reduce('native', update({status: 'failed'}), neverAnchor, 105).input.Path, '/fixture/probe.mp4');
});

test('failure retains real text, not arbitrary raw JSON or hidden reasoning', () => {
  const records = new NativeToolRecords();
  records.reduce('native', start(), anchor, 100);
  const failure = records.reduce('native', update({status: 'failed', rawOutput: [
    {type: 'text', text: 'File does not exist'}, {type: 'thinking', thinking: 'HIDDEN_REASONING'},
  ]}), anchor, 101);
  assert.equal(failure.status, 'failed');
  assert.equal(failure.output, 'File does not exist');
  const opaque = records.reduce('native', start({toolCallId: 'opaque', status: 'completed',
    rawOutput: {text: 'not a typed text result', reasoning: 'SECRET', data: 'BASE64'}}), anchor);
  assert.equal(opaque.output, undefined);
  assert.doesNotMatch(JSON.stringify(opaque), /BASE64|SECRET|typed text result/);
});

test('raw JSON envelopes are not copied; only their explicit text content is selected', () => {
  for (const rawOutput of [{data: 'MEDIA_SECRET', reasoning: 'HIDDEN'},
    JSON.stringify({data: 'MEDIA_SECRET', reasoning: 'HIDDEN'})]) {
    const record = new NativeToolRecords().reduce('native', start({rawOutput}), anchor);
    assert.equal(record.output, undefined);
  }
  for (const output of [{content: [{type: 'text', text: 'Actual text'}], data: 'MEDIA_SECRET'},
    {type: 'text', text: 'Actual text'}]) {
    for (const rawOutput of [output, JSON.stringify(output)]) {
      const record = new NativeToolRecords().reduce('native', start({rawOutput}), anchor);
      assert.equal(record.output, 'Actual text');
      assert.doesNotMatch(JSON.stringify(record), /MEDIA_SECRET/);
    }
  }
  const jsonFile = '{"userData": "a text file"}';
  const record = new NativeToolRecords().reduce('native', start({content: [
    {type: 'content', content: {type: 'text', text: jsonFile}},
  ]}), anchor);
  assert.equal(record.output, jsonFile, 'explicit text file content is not a raw transport envelope');
});

test('only exact native name starts a record; no title guessing or bridge/MCP aliases', () => {
  const records = new NativeToolRecords();
  for (const name of ['pi__read_file', 'mcp__read_file', 'pi-acp.read_file', 'read', 'write_file', undefined]) {
    assert.equal(records.reduce('native', start({name}), () => assert.fail('ignored calls do not close blocks')), undefined);
  }
  assert.equal(records.reduce('native', update({status: 'completed'}), anchor), undefined);
  assert.equal(records.reduce('native', start({toolCallId: ''}), anchor), undefined);
  const first = records.reduce('native-a', start(), anchor, 1);
  const second = records.reduce('native-b', start(), anchor, 2);
  assert.notEqual(first.id, second.id, 'native session is part of identity');
});

test('verified completed shape without rawOutput preserves only real path/status/title', () => {
  const record = new NativeToolRecords().reduce('native', start({status: 'completed', rawInput: undefined,
    locations: [{path: '/fixture/probe.mp4'}]}), anchor, 100);
  assert.equal(record.status, 'completed');
  assert.deepEqual(record.input, {Path: '/fixture/probe.mp4'});
  assert.equal(record.title, 'File /fixture/probe.mp4');
  assert.equal(record.output, undefined);
  assert.equal(record.outputTruncated, undefined);
});

test('content snapshots/chunks extract text and media types without copying data', () => {
  const records = new NativeToolRecords();
  const first = records.reduce('native', start({rawInput: {Path: '/fixture/probe.mp4', data: 'INPUT_SECRET'},
    content: [{type: 'content', content: {type: 'text', text: 'prefix'}}]}), anchor, 100);
  assert.equal(first.output, 'prefix');
  const chunk = records.reduce('native', {sessionUpdate: 'tool_call_content_chunk', toolCallId: 'read-1',
    content: {type: 'content', content: {type: 'text', text: ' suffix'}}}, anchor, 101);
  assert.equal(chunk.output, 'prefix suffix');
  const completed = records.reduce('native', update({status: 'completed', content: [
    {type: 'content', content: {type: 'text', text: 'Real text'}},
    ...['image', 'audio', 'video'].map(type => ({type: 'content', content: {type, data: 'MEDIA_SECRET', mimeType: 'secret/type'}})),
    {type: 'content', content: {type: 'resource', resource: {uri: 'secret', blob: 'BLOB_SECRET'}}},
    {type: 'content', content: {type: 'resource', resource: {text: 'Resource text', mimeType: 'text/plain'}}},
  ], rawOutput: {data: 'RAW_SECRET', reasoning: 'THOUGHT_SECRET'}}), anchor, 102);
  assert.equal(completed.output, 'Real text\n[image]\n[audio]\n[video]\nResource text');
  assert.doesNotMatch(JSON.stringify(completed), /SECRET|mimeType|blob|data/);
});

test('outputs are bounded, chunk truncation survives updates, replacement can reset it', () => {
  const records = new NativeToolRecords();
  const text = 'file line\n'.repeat(3000);
  const first = records.reduce('native', start({rawOutput: text}), anchor, 1);
  assert.equal(first.output, text.slice(0, 16384));
  assert.equal(first.outputTruncated, true);
  assert.equal(records.reduce('native', update({rawOutput: text}), anchor, 2), undefined);
  assert.equal(records.reduce('native', {sessionUpdate: 'tool_call_content_chunk', toolCallId: 'read-1',
    content: {type: 'text', text: 'more'}}, anchor, 3), undefined, 'clipped output has no visible change');
  const last = records.reduce('native', update({status: 'completed', rawOutput: 'short result'}), anchor, 4);
  assert.equal(last.output, 'short result');
  assert.equal(last.outputTruncated, false);
});

test('opaque base64/binary and inline media data are not persisted as output', () => {
  for (const rawOutput of ['A'.repeat(256), 'binary\u0000data']) {
    const record = new NativeToolRecords().reduce('native', start({rawOutput}), anchor);
    assert.equal(record.output, undefined);
  }
  const record = new NativeToolRecords().reduce('native', start({rawOutput: 'Text data:image/png;base64,QUJDRA== done'}), anchor);
  assert.equal(record.output, 'Text [media data omitted] done');
});
