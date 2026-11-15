import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {copyNativeConversation, removeNativeBootstrap} from '../src/store.ts';

async function fixture(t) {
 const root=await mkdtemp(path.join(os.tmpdir(),'pi-acp-store-'));
 const source=path.join(root,'source'),target=path.join(root,'target');
 await mkdir(source);await mkdir(target);
 t.after(()=>rm(root,{recursive:true,force:true}));
 return {source,target};
}

test('encrypted protobuf bootstrap is an exact exclusive copy',async t=>{
 const {source,target}=await fixture(t);
 const bytes=Buffer.from([8,3,1,4,9,5]);const original=path.join(source,'native.pb');
 await writeFile(original,bytes);
 const file=await copyNativeConversation(source,target,'native');
 assert.equal(file,path.join(target,'native.pb'));
 assert.deepEqual(await readFile(file),bytes);
 await removeNativeBootstrap(file);
 assert.deepEqual(await readFile(original),bytes);
 await assert.rejects(readFile(file),{code:'ENOENT'});
});

test('SQLite snapshot includes committed WAL while the native parent remains open',async t=>{
 const {source,target}=await fixture(t);const original=path.join(source,'native.db');
 const parent=new DatabaseSync(original);
 try {
  parent.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE steps(value TEXT); INSERT INTO steps VALUES (\'old branch\');');
  parent.exec("INSERT INTO steps VALUES ('latest committed step');");
  const before=await readFile(original),walBefore=await readFile(original+'-wal');
  const file=await copyNativeConversation(source,target,'native');
  const copy=new DatabaseSync(file,{readOnly:true});
  try {assert.deepEqual(copy.prepare('SELECT value FROM steps ORDER BY rowid').all().map(x=>x.value),['old branch','latest committed step']);}
  finally {copy.close();}
  assert.deepEqual(await readFile(original),before);
  assert.deepEqual(await readFile(original+'-wal'),walBefore);
  await removeNativeBootstrap(file);
  assert.equal(parent.prepare('SELECT count(*) AS n FROM steps').get().n,2);
 } finally {parent.close();}
});

test('neither persistence format overwrites an existing destination',async t=>{
 const {source,target}=await fixture(t);
 await writeFile(path.join(source,'protobuf.pb'),'source');
 await writeFile(path.join(target,'protobuf.pb'),'not ours');
 await assert.rejects(copyNativeConversation(source,target,'protobuf'),{code:'EEXIST'});
 assert.equal(await readFile(path.join(target,'protobuf.pb'),'utf8'),'not ours');
 const parent=new DatabaseSync(path.join(source,'sqlite.db'));
 parent.exec('CREATE TABLE steps(value TEXT)');parent.close();
 await writeFile(path.join(target,'sqlite.db'),'not ours either');
 await assert.rejects(copyNativeConversation(source,target,'sqlite'),{code:'EEXIST'});
 assert.equal(await readFile(path.join(target,'sqlite.db'),'utf8'),'not ours either');
});
