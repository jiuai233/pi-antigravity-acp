import assert from 'node:assert/strict';
import test from 'node:test';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url);
const {readNativeToolActivity,nativeToolFromEntry,withNativeTools}=await jiti.import('./native-tool-activity.ts');
const {toClientAgentEvent}=await jiti.import('./agent-event-wire.ts');
const {INITIAL_STREAMING_STATE,streamReducer}=await jiti.import('./streaming-message.ts');
const {buildSessionContext}=await jiti.import('./session-reader.ts');
const {SessionManager}=await jiti.import('@earendil-works/pi-coding-agent');

const assistant=()=>({role:'assistant',provider:'antigravity-acp',api:'antigravity-acp',model:'gemini-4-hydrogen',timestamp:100,
 content:[{type:'thinking',thinking:'Inspect the video.'},{type:'text',text:'The two scenes differ.'}],stopReason:'stop',
 usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
const activity=(status='in_progress')=>({version:1,id:'native-session:read-1',provider:'antigravity-acp',messageTimestamp:100,contentIndex:1,
 toolName:'read_file',title:'File /E:/clips/带有较长中文名称的视频.mp4',status,input:{Path:'E:/clips/带有较长中文名称的视频.mp4'},startedAt:110,updatedAt:status==='completed'?120:110});
const entry=(id,parentId,data)=>({type:'custom',customType:'pi-native-tool',id,parentId,timestamp:'2026-11-13T03:00:00.000Z',data});

test('only the v1 native entry is projected; unrelated extension payloads stay off the wire',()=>{
 const expected=activity();
 assert.deepEqual(toClientAgentEvent({type:'entry_appended',entry:entry('n','u',expected)}),{type:'native_tool_update',activity:expected});
 assert.equal(toClientAgentEvent({type:'entry_appended',entry:{type:'custom',customType:'codemode-store',data:{body:'x'.repeat(1000000)}}}),null);
 assert.equal(nativeToolFromEntry({type:'custom_message',customType:'pi-native-tool',data:expected}),null);
 assert.equal(readNativeToolActivity({...expected,version:2}),null);
});

test('streaming status updates replace one card and survive text deltas and the final message',()=>{
 const raw=assistant();const source=structuredClone(raw);
 let state=streamReducer(INITIAL_STREAMING_STATE,{type:'snapshot',message:{...raw,content:[raw.content[0]]}});
 state=streamReducer(state,{type:'native_tool',activity:activity()});
 assert.equal(state.streamingMessage.nativeTools.length,1);
 state=streamReducer(state,{type:'delta',event:{type:'text_start',contentIndex:1}});
 state=streamReducer(state,{type:'delta',event:{type:'text_delta',contentIndex:1,delta:raw.content[1].text}});
 state=streamReducer(state,{type:'native_tool',activity:activity('completed')});
 assert.equal(state.streamingMessage.nativeTools.length,1);
 assert.equal(state.streamingMessage.nativeTools[0].status,'completed');
 const final=withNativeTools(raw,state.nativeTools);
 assert.deepEqual(final.content,source.content);
 assert.equal(final.nativeTools[0].contentIndex,1);
 assert.deepEqual(raw,source);
 assert.deepEqual(streamReducer(state,{type:'end'}),INITIAL_STREAMING_STATE);
});

test('a native update received before a reconnect snapshot waits for the matching assistant only',()=>{
 let state=streamReducer(INITIAL_STREAMING_STATE,{type:'native_tool',activity:activity('completed')});
 assert.equal(state.streamingMessage,null);
 state=streamReducer(state,{type:'snapshot',message:{...assistant(),provider:'anthropic'}});
 assert.equal(state.streamingMessage.nativeTools,undefined);
 state=streamReducer(state,{type:'snapshot',message:assistant()});
 assert.equal(state.streamingMessage.nativeTools[0].status,'completed');
});

test('one-message history pages include preceding native records but not an abandoned branch update',()=>{
 const raw=assistant();
 const entries=[{type:'message',id:'u',parentId:null,timestamp:'2026-11-13T03:00:00Z',message:{role:'user',content:'Read this video',timestamp:90}},
  entry('n1','u',activity()),entry('n2','n1',activity('completed')),
  {type:'message',id:'a',parentId:'n2',timestamp:'2026-11-13T03:00:01Z',message:raw},
  entry('abandoned','n1',{...activity('failed'),updatedAt:999})];
 const before=structuredClone(entries);
 const context=buildSessionContext(entries,'a',{tail:1,deferThinking:true});
 assert.equal(context.messages.length,1);
 assert.deepEqual(context.entryIds,['a']);
 assert.equal(context.messages[0].nativeTools.length,1);
 assert.equal(context.messages[0].nativeTools[0].status,'completed');
 assert.equal(context.messages[0].nativeTools[0].contentIndex,1);
 assert.equal(context.messages[0].content[0].deferred,true);
 assert.deepEqual(entries,before);
});

test('official appendCustomEntry persists native records without adding model messages or executable calls',()=>{
 const manager=SessionManager.inMemory('E:/pi-stack');
 manager.appendMessage({role:'user',content:'Read this video',timestamp:90});
 manager.appendCustomEntry('pi-native-tool',activity());
 manager.appendCustomEntry('pi-native-tool',activity('completed'));
 const raw=assistant();manager.appendMessage(raw);
 const modelMessages=manager.buildSessionContext().messages;
 assert.equal(modelMessages.length,2);
 assert.deepEqual(modelMessages.at(-1).content,raw.content);
 assert.equal(modelMessages.at(-1).nativeTools,undefined);
 assert.equal(modelMessages.some(message=>Array.isArray(message.content)&&message.content.some(block=>block.type==='toolCall')),false);
 const ui=buildSessionContext(manager.getEntries(),manager.getLeafId());
 assert.equal(ui.messages.at(-1).nativeTools.length,1);
 assert.equal(ui.messages.at(-1).nativeTools[0].status,'completed');
});
