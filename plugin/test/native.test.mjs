import assert from 'node:assert/strict';
import {mkdtemp, rm, utimes, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {NativeControl, readNativeHttpPort} from '../src/native.ts';

test('native port follows the latest worker, not the lexical PID order',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'pi-acp-native-port-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const old=path.join(directory,'acp-worker-20261113_050000-9999.log');
 const current=path.join(directory,'acp-worker-20261113_050000-1000.log');
 const front=path.join(directory,'acp-front-20261113_050000-2000.log');
 await writeFile(old,'listening on random port at 11111 for HTTP\n');
 await writeFile(current,'listening on random port at 22222 for HTTP\n');
 await writeFile(front,'front process has no native server\n');
 const now=Date.now()/1000;
 await utimes(old,now-20,now-20);await utimes(current,now-10,now-10);await utimes(front,now,now);
 assert.equal(await readNativeHttpPort(directory,2000),22222);
});

test('native tree fork reverts only the new conversation, never the source',async t=>{
 const requests=[];
 t.mock.method(globalThis,'fetch',async (url,options)=>{
  requests.push({url:String(url),body:JSON.parse(options.body)});
  return {ok:true,json:async()=>requests.length===1?{newCascadeId:'new-branch'}:{}};
 });
 const native=new NativeControl(12345);
 assert.equal(await native.fork('original',7),'new-branch');
 assert.deepEqual(requests.map(x=>x.url.split('/').at(-1)),['ForkConversation','RevertToCascadeStep']);
 assert.equal(requests[0].body.sourceCascadeId,'original');
 assert.equal(requests[0].body.forkAtStepIndex,7);
 assert.deepEqual(requests[1].body,{cascadeId:'new-branch',stepIndex:7,conversationOnly:true,suppressErrorStep:true});
});
