import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import test from 'node:test';
import {build} from 'esbuild';
import {chromium} from 'playwright';

// Exercise the real hydrated component, not a copy of its markup or click handlers.
test('native card state, disclosure and long Chinese paths work on phones and desktop',{timeout:60000},async()=>{
 const componentDir=path.dirname(fileURLToPath(import.meta.url));
 const web=path.resolve(componentDir,'..');
 const activity={version:1,id:'native-browser:read-1',provider:'antigravity-acp',messageTimestamp:100,contentIndex:1,
  toolName:'read_file',title:'File probe.mp4',status:'in_progress',
  input:{Path:'E:/pi-stack/notes/verify/evidence/agy-acp-media-cache-20261113/带有中文说明的原生视频读取探针-probe.mp4'},startedAt:110,updatedAt:110};
 const bundle=await build({absWorkingDir:web,stdin:{resolveDir:componentDir,sourcefile:'native-card-fixture.tsx',contents:`
 import React from 'react';
 import {createRoot} from 'react-dom/client';
 import {I18nProvider} from '../hooks/useI18n';
 import {MessageView} from './MessageView';
 localStorage.setItem('pi-locale','zh-CN');
 const root=createRoot(document.getElementById('fixture'));
 let activity=${JSON.stringify(activity)};
 let entryId;
 const render=()=>root.render(<I18nProvider><div id="reference"><MessageView message={{role:'assistant',content:[{type:'toolCall',toolCallId:'reference:read',toolName:'read',input:activity.input}]}}/></div><MessageView entryId={entryId} message={{role:'assistant',provider:'antigravity-acp',model:'gemini-4-hydrogen',timestamp:100,content:[{type:'text',text:'BEFORE_NATIVE_BROWSER'},{type:'text',text:'AFTER_NATIVE_BROWSER'}],nativeTools:[activity]}} isStreaming={true}/></I18nProvider>);
 window.persistEntry=()=>{entryId='persisted-entry-id';render();};
 window.updateNative=(change)=>{activity={...activity,...change};render();};render();`,loader:'tsx'},
  bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}});
 const js=bundle.outputFiles[0].text;
 const css=readFileSync(path.join(web,'app/globals.css'),'utf8').replace(/^@import .*;$/gm,'');
 const server=createServer((req,res)=>{
  if(req.url==='/fixture.js'){res.setHeader('Content-Type','application/javascript; charset=utf-8');res.end(js);return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.end(`<!doctype html><html lang="zh-CN" data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}*{box-sizing:border-box}body{display:block;margin:0;font:14px system-ui,sans-serif}#fixture{margin:16px;max-width:900px}</style><main id="fixture"></main><script src="/fixture.js"></script></html>`);
 });
 const artifacts=process.env.PIWEB_NATIVE_CARD_ARTIFACTS;
 if(artifacts)mkdirSync(artifacts,{recursive:true});
 const measurements=[],errors=[];let browser;
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true,channel:process.env.PIWEB_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined)});
  for(const width of [390,1280]){
   const page=await browser.newPage({viewport:{width,height:700},isMobile:width<600,hasTouch:width<600});
   page.on('pageerror',error=>errors.push(error.message));
   await page.goto(`http://127.0.0.1:${server.address().port}`);
   const card=page.locator('[data-native-tool-id]');const disclosure=card.getByRole('button');
   await page.getByText('读取中',{exact:true}).waitFor();
   assert.equal(await card.count(),1);
   await disclosure.click();
   assert.equal(await disclosure.getAttribute('aria-expanded'),'true');
   assert.match(await card.innerText(),/中文说明/);
   assert.equal(await card.locator('table').count(),1,'use the existing input rows rather than another JSON card');
   assert.doesNotMatch(await disclosure.innerText(),/AGY 原生|AGY native/);
   const reference=page.locator('#reference button[data-tool-call-id]');
   const headerStyle=element=>{const s=getComputedStyle(element);return {fontSize:s.fontSize,padding:s.padding,color:s.color,background:s.backgroundColor,border:s.border};};
   assert.deepEqual(await disclosure.evaluate(headerStyle),await reference.evaluate(headerStyle),'native and Pi calls use the same tool-card header');
   const firstText=page.locator('[data-message-text]').first();
   await firstText.evaluate(element=>element.dataset.mountIdentity='same-block');
   await page.evaluate(()=>window.persistEntry());
   assert.equal(await firstText.getAttribute('data-mount-identity'),'same-block','persisting the entry id must not remount blocks (#1184)');
   const layout=await page.locator('#fixture').evaluate(element=>({client:element.clientWidth,scroll:element.scrollWidth,document:document.documentElement.scrollWidth,viewport:innerWidth}));
   assert.ok(layout.scroll<=layout.client&&layout.document<=layout.viewport,JSON.stringify(layout));
   measurements.push({width,expanded:layout});
   if(artifacts)await card.screenshot({path:path.join(artifacts,`native-card-${width}-expanded.png`)});
   await page.evaluate(()=>window.updateNative({status:'completed',updatedAt:120}));
   await page.locator('[data-native-tool-status="completed"]').waitFor();
   assert.doesNotMatch(await disclosure.innerText(),/已完成|AGY 原生/);
   assert.equal(await card.count(),1);assert.equal(await disclosure.getAttribute('aria-expanded'),'true');
   if(artifacts){
    await card.screenshot({path:path.join(artifacts,`native-card-${width}-completed.png`)});
    await reference.click();
    await page.locator('#fixture').screenshot({path:path.join(artifacts,`native-card-${width}-reference.png`)});
   }
   await page.evaluate(()=>window.updateNative({status:'failed',output:'原生读取失败：文件不存在。',updatedAt:130}));
   await page.getByText('失败',{exact:true}).waitFor();
   assert.match(await card.innerText(),/文件不存在/);
   assert.equal(await card.getByRole('button').count(),1,'only disclosure is offered, not a tool execution button');
   if(artifacts)await card.screenshot({path:path.join(artifacts,`native-card-${width}-failed.png`)});
   await page.close();
  }
  assert.deepEqual(errors,[]);
 }finally{
  if(artifacts)writeFileSync(path.join(artifacts,'layout.json'),JSON.stringify({measurements,errors},null,2)+'\n');
  await browser?.close();await new Promise(resolve=>server.close(resolve));
 }
});
