import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {readAgyNetworkMonitor} from '../src/network-monitor.ts';
test('optional monitor errors retain inherited or previously effective proxy intent',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'pi-acp-monitor-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const file=join(directory,'config.json'),parent={PI_AGY_NETWORK_MONITOR_CONFIG:file,HTTPS_PROXY:'http://inherited-proxy'};
 await writeFile(file,'{bad json');const first=readAgyNetworkMonitor(parent);
 assert.equal(first.env.HTTPS_PROXY,parent.HTTPS_PROXY);assert.ok(first.warning);
 await writeFile(file,JSON.stringify({enabled:true,proxyUrl:'native-will-parse-this',caBundlePath:join(directory,'missing.pem'),certificateDirectory:join(directory,'missing')}));
 const active=readAgyNetworkMonitor(parent);assert.equal(active.env.HTTPS_PROXY,'native-will-parse-this');assert.equal(active.warning,undefined);
 for(const invalid of ['{invalid',JSON.stringify({enabled:'invalid'})]){
  await writeFile(file,invalid);const retained=readAgyNetworkMonitor(parent);
  assert.equal(retained.env.HTTPS_PROXY,active.env.HTTPS_PROXY);assert.equal(retained.env.SSL_CERT_FILE,active.env.SSL_CERT_FILE);assert.ok(retained.warning);
 }
 await rm(file);assert.equal(readAgyNetworkMonitor(parent).env.HTTPS_PROXY,active.env.HTTPS_PROXY);
});
