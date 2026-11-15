import assert from 'node:assert/strict';
import test from 'node:test';
import {emptyUsage, UsageLedger} from '../src/usage.ts';

const pricing={input:1,output:2,cacheRead:0.1,cacheWrite:1};
const message=()=>({usage:emptyUsage()});
const gen=(id,input,output,extra={})=>({chatModel:{usage:{messageId:id,inputTokens:String(input),outputTokens:String(output),...extra}}});

test('actual two-inference shape: bill all new generations but context is only the last',()=>{
 const ledger=new UsageLedger();const output=message();
 ledger.apply(output,{generatorMetadata:[gen('a',10366,4261,{thinkingOutputTokens:'4261'}),gen('b',10383,21692,{thinkingOutputTokens:'21658'})]},pricing,{totalTokens:46702});
 assert.equal(output.usage.input,20749);assert.equal(output.usage.output,25953);
 assert.equal(output.usage.reasoning,25919);assert.equal(output.usage.totalTokens,32075);
 assert.notEqual(output.usage.totalTokens,46702);assert.equal(output.usage.cost.totalFromProvider,false);
});

test('same native generations are never billed twice; cached context and restored baseline remain distinct',()=>{
 const ledger=new UsageLedger();const old={generatorMetadata:[gen('old',100,20)]};ledger.baseline(old);
 const trajectory={generatorMetadata:[...old.generatorMetadata,gen('new',100,10,{cacheReadTokens:'900'})]};
 const first=message();ledger.apply(first,trajectory,pricing);assert.equal(first.usage.input,100);assert.equal(first.usage.cacheRead,900);assert.equal(first.usage.totalTokens,1010);
 const second=message();ledger.apply(second,trajectory,pricing);assert.equal(second.usage.input,0);assert.equal(second.usage.output,0);assert.equal(second.usage.totalTokens,1010);
});

test('public context update wins over cumulative totals; absent counters remain explicitly unknown',()=>{
 const ledger=new UsageLedger();ledger.setContext(2222);const output=message();ledger.apply(output,{generatorMetadata:[gen('a',100,10)]},pricing,{totalTokens:999999});
 assert.equal(output.usage.totalTokens,2222);
 const unknown=message();new UsageLedger().apply(unknown,undefined,pricing,{totalTokens:999999});
 assert.ok(Number.isNaN(unknown.usage.totalTokens));assert.ok(Number.isNaN(unknown.usage.input));assert.equal(unknown.diagnostics[0].type,'agy_acp_usage_unknown');
});

test('unexpected accounting input reports its actual error without invalidating text',()=>{
 const output={...message(),content:[{type:'text',text:'NORMAL_REPLY'}],stopReason:'stop'};
 const ledger=new UsageLedger();ledger.baseline({generatorMetadata:{}});
 ledger.apply(output,{generatorMetadata:{}},pricing);
 assert.equal(output.stopReason,'stop');assert.equal(output.content[0].text,'NORMAL_REPLY');
 assert.ok(Number.isNaN(output.usage.input));
 assert.ok(output.diagnostics[0].details.invalidNativeUsage[0].error.message);
 assert.equal(JSON.parse(JSON.stringify(output)).usage.input,null);
});
