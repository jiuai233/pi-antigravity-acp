import assert from 'node:assert/strict';
import test from 'node:test';
import {acpContent,nativeBase64} from '../src/content.ts';
test('base64 spelling normalization preserves bytes and never silently erases bad payload characters',()=>{
 const bytes=Buffer.from([251,255,0]);
 const standard=bytes.toString('base64');
 for(const spelling of [standard,standard.replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,''),' \n'+standard+'\t','data:image/png;base64,'+standard]){
  assert.equal(nativeBase64(spelling),standard);
 }
 assert.ok(nativeBase64('!bad!').includes('!'));
});
test('unknown native content is retained visibly rather than disappearing',()=>{
 const block={type:'future_resource',uri:'file:///actual',value:'REAL_CONTENT'};
 assert.deepEqual(acpContent([block]),[{type:'text',text:JSON.stringify(block)}]);
});
