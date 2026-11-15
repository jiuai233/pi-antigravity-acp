import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { BinaryWriter, WireType } from '@bufbuild/protobuf/wire';
import { AgyPrefixAudit, PREFIX_AUDIT_ENTRY } from '../src/prefix-audit.ts';

const ID = '11111111-1111-1111-1111-111111111111';
const scalar = (writer, n, value) => writer.tag(n, WireType.Varint).uint64(BigInt(value));
const blob = (writer, n, value) => writer.tag(n, WireType.LengthDelimited).bytes(value);

function metadata({ system = 'SYSTEM_SECRET\n', prompts = ['USER_SECRET'], cache = 0, output = 2, annotation = 'one', seconds = 2, nanos = 500_000_000, failed = false } = {}) {
  const usage = new BinaryWriter(); scalar(usage, 2, 10); scalar(usage, 3, output); scalar(usage, 5, cache);
  const chat = new BinaryWriter(); blob(chat, 1, Buffer.from(system)); blob(chat, 4, usage.finish()); scalar(chat, 3, 427);
  const tool = new BinaryWriter().tag(1, WireType.LengthDelimited).string('read')
    .tag(2, WireType.LengthDelimited).string('DESCRIPTION_SECRET');
  blob(chat, 8, tool.finish());
  for (const prompt of prompts) {
    const msg = new BinaryWriter().tag(1, WireType.LengthDelimited).string(annotation)
      .tag(3, WireType.LengthDelimited).string(prompt);
    scalar(msg, 2, 1); scalar(msg, 4, annotation.length);
    blob(msg, 17, Uint8Array.of(0xff, 0xfe));
    blob(chat, 2, msg.finish());
  }
  const duration = new BinaryWriter(); scalar(duration, 1, seconds); scalar(duration, 2, nanos);
  blob(chat, 11, duration.finish());
  const root = blob(new BinaryWriter(), 1, chat.finish());
  if (failed) blob(root, 5, Buffer.from('ERROR_SECRET'));
  return root.finish();
}

test('records local prefix changes without exposing raw secrets', () => {
  const events = [];
  const tool = { name: 'codemode', description: 'DESCRIPTION_SECRET', parameters: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } } };
  const agent = { name: 'acp-agent', agentBody: 'AGENT_SECRET' };
  const audit = new AgyPrefixAudit(e => events.push(e));
  audit.recordLocal('SYSTEM_SECRET\r\n', [tool], agent);
  audit.recordLocal('SYSTEM_SECRET\r\n', [tool], agent);
  assert.equal(events.length, 1);

  const reordered = { ...tool, parameters: { properties: { b: { type: 'number' }, a: { type: 'string' } }, type: 'object' } };
  audit.recordLocal('SYSTEM_SECRET\n', [reordered], { ...agent, name: 'acp-other', agentBody: 'changed' });
  assert.deepEqual(events.at(-1).changes, ['system_line_endings', 'bridge_identity', 'schema_order:codemode', 'agent_body']);
  assert.doesNotMatch(JSON.stringify(events), /SYSTEM_SECRET|DESCRIPTION_SECRET|AGENT_SECRET/);
});

test('samples gen_metadata from ACP geminiDir SQLite and restores from session entries', t => {
  const geminiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-acp-audit-'));
  const convDir = path.join(geminiDir, 'antigravity-cli', 'conversations');
  fs.mkdirSync(convDir, { recursive: true });
  const dbPath = path.join(convDir, `${ID}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
  const put = (idx, opts) => db.prepare('INSERT OR REPLACE INTO gen_metadata VALUES (?, ?)').run(idx, metadata(opts));
  t.after(() => {
    db.close();
    fs.rmSync(geminiDir, { recursive: true, force: true });
  });

  const events = [];
  let refreshes = 0;
  const audit = new AgyPrefixAudit(e => events.push(e), () => refreshes++);
  put(0, { cache: 0 });
  put(1, { prompts: ['USER_SECRET', 'ANSWER_SECRET'], cache: 990 });
  audit.sample(ID, geminiDir);
  assert.equal(events.length, 2);
  assert.equal(events.at(-1).historyPrefixPreserved, true);
  assert.match(audit.summary(), /99\.0%/);
  assert.match(audit.details().join('\n'), /读取=990 未缓存输入=10 输出=2/);
  assert.match(audit.details().join('\n'), /原生首 token 等待: 2\.500 秒/);

  put(2, { failed: true });
  audit.sample(ID, geminiDir);
  assert.equal(events.at(-1).kind, 'native_observation');
  assert.equal(events.at(-1).status, 'failed');

  const restored = new AgyPrefixAudit(() => { throw new Error('restore must not journal'); });
  restored.restore(events.map(data => ({ type: 'custom', customType: PREFIX_AUDIT_ENTRY, data })));
  assert.match(restored.summary(), /99\.0%/);
  assert.ok(refreshes >= 1);
});

test('ignores missing or non-UUID conversation IDs and isolates UI/journal errors', () => {
  const broken = new AgyPrefixAudit(() => { throw new Error('disk full'); }, () => { throw new Error('UI detached'); });
  broken.recordLocal('sys', [], { name: 'acp-agent' });
  broken.sample('non-uuid-id', '/tmp/does-not-exist');
  broken.sample(ID, '/tmp/does-not-exist');
  assert.match(broken.summary(), /审计暂不可用|等待原生采样/);
});

test('reset clears audit state and restore drops entries prior to reset marker', () => {
  const events = [];
  let updates = 0;
  const audit = new AgyPrefixAudit(e => events.push(e), () => updates++);
  audit.recordLocal('sys-before', [], { name: 'acp-agent' });
  assert.equal(events.length, 1);

  const geminiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-acp-audit-reset-'));
  try {
    const convDir = path.join(geminiDir, 'antigravity-cli', 'conversations');
    fs.mkdirSync(convDir, { recursive: true });
    const db = new DatabaseSync(path.join(convDir, `${ID}.db`));
    db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
    db.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(0, metadata({ cache: 800 }));
    db.close();
    audit.sample(ID, geminiDir);
  } finally {
    fs.rmSync(geminiDir, { recursive: true, force: true });
  }
  assert.match(audit.summary(), /98\.8%/);

  const beforeUpdates = updates;
  audit.reset();
  assert.ok(updates > beforeUpdates);
  assert.match(audit.summary(), /等待原生采样/);

  const entries = [
    ...events.map(data => ({ type: 'custom', customType: PREFIX_AUDIT_ENTRY, data })),
    { type: 'custom', customType: 'antigravity-acp:reset', data: { version: 1 } },
  ];
  const restored = new AgyPrefixAudit(() => { throw new Error('restore must not journal'); });
  restored.restore(entries);
  assert.match(restored.summary(), /等待原生采样/);
});
