import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {AgyPiBridge,resolveBridgeResultsFromContext} from '../src/bridge/bridge.ts';

function transport(){
 let handler;
 const server=new EventEmitter();
 server.listen=(...args)=>{args.at(-1)();};server.address=()=>({port:12345});server.close=cb=>cb();
 return {factory:fn=>{handler=fn;return server;},send(body,token='secret'){
  const req=new EventEmitter();req.method='POST';req.headers={'x-pi-bridge-token':token};
  let status;let settled=false;let headersFlushed=false;
  const result=new Promise(resolve=>{
   const res={headersSent:false,writeHead(code){status=code;this.headersSent=true;},flushHeaders(){headersFlushed=true;},end(text){settled=true;resolve({status,body:text?JSON.parse(text):null});}};
   handler(req,res);req.emit('data',Buffer.from(JSON.stringify(body)));req.emit('end');
  });
  return {result,get settled(){return settled;},get headersFlushed(){return headersFlushed;}};
 }};
}
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
const tool={name:'probe',description:'test probe',parameters:{type:'object',properties:{x:{type:'number'}},required:['x']}};

for(const owner of [false,true])test(`MCP waits for real owner/result beyond former 480s cap (initial owner=${owner})`,async t=>{
 const io=transport();const bridge=new AgyPiBridge('test',io.factory);let call;
 bridge.requireToken('secret');bridge.setToolPrefix('');bridge.setToolSource(()=>[tool]);bridge.setOnCall(value=>{call=value;return owner;});bridge.refreshTools();
 await bridge.start();
 t.mock.timers.enable({apis:['setTimeout']});
 const pending=io.send({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'probe',arguments:{x:7}}});
 await flush();assert.ok(call);assert.equal(bridge.pendingCount,1);assert.equal(pending.headersFlushed,true);assert.equal(pending.settled,false);
 t.mock.timers.tick(480_001);await flush();assert.equal(pending.settled,false);assert.equal(bridge.pendingCount,1);
 const messages=[{role:'assistant',content:[{type:'toolCall',id:call.id,name:'probe',arguments:{x:7}}]},
  {role:'toolResult',toolCallId:call.id,toolName:'probe',content:[{type:'text',text:'REAL_RESULT'}],isError:false}];
 assert.equal(resolveBridgeResultsFromContext(bridge,messages),1);
 const reply=await pending.result;assert.equal(reply.status,200);assert.equal(reply.body.result.isError,false);assert.equal(reply.body.result.content[0].text,'REAL_RESULT');
 assert.equal(resolveBridgeResultsFromContext(bridge,messages),0);await bridge.close();
});

test('wrong tool identity/arguments cannot consume pending call; cancelled native may clean it',async()=>{
 const io=transport();const bridge=new AgyPiBridge('test',io.factory);let call;
 bridge.requireToken('secret');bridge.setToolPrefix('');bridge.setToolSource(()=>[tool]);bridge.setOnCall(c=>{call=c;return true;});bridge.refreshTools();await bridge.start();
 const pending=io.send({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'probe',arguments:{x:7}}});await flush();
 const result={role:'toolResult',toolCallId:call.id,toolName:'other',content:[{type:'text',text:'WRONG'}]};
 assert.throws(()=>resolveBridgeResultsFromContext(bridge,[result]),/name/);assert.equal(bridge.pendingCount,1);
 result.toolName='probe';assert.throws(()=>resolveBridgeResultsFromContext(bridge,[{role:'assistant',content:[{type:'toolCall',id:call.id,name:'probe',arguments:{x:8}}]},result]),/arguments/);
 // Runtime calls this only after ACP has reached a stopped terminal state.
 bridge.cancelPending('Native cancelled');assert.equal((await pending.result).body.result.isError,true);await bridge.close();
});

test('loopback token and canonical tool catalog are enforced',async()=>{
 const io=transport();const bridge=new AgyPiBridge('test',io.factory);bridge.requireToken('secret');bridge.setToolPrefix('');bridge.setToolSource(()=>[tool]);bridge.refreshTools();await bridge.start();
 assert.equal((await io.send({jsonrpc:'2.0',id:1,method:'tools/list'},'bad').result).status,403);
 const reply=await io.send({jsonrpc:'2.0',id:2,method:'tools/list'}).result;
 assert.equal(reply.body.result.tools[0].name,'probe');assert.deepEqual(reply.body.result.tools[0].inputSchema,tool.parameters);await bridge.close();
});

test('a non-native Pi tool name is mapped and routed without losing the catalog',async()=>{
 const io=transport(),bridge=new AgyPiBridge('pi-acp',io.factory);let call;
 bridge.requireToken('secret');bridge.setToolPrefix('');bridge.setToolSource(()=>[{...tool,name:'文件.读取'}]);
 bridge.setOnCall(value=>{call=value;return true;});bridge.refreshTools();await bridge.start();
 try{
  const listed=(await io.send({jsonrpc:'2.0',id:1,method:'tools/list'}).result).body.result.tools;
  assert.equal(listed.length,1);assert.match(listed[0].name,/^[a-zA-Z0-9_-]+$/);
  const pending=io.send({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:listed[0].name,arguments:{x:7}}});
  await flush();assert.equal(call.tool,'文件.读取');
  bridge.resolveCall(call.id,{content:'ACTUAL_RESULT',isError:false});
  assert.equal((await pending.result).body.result.content[0].text,'ACTUAL_RESULT');
 }finally{await bridge.close();}
});
