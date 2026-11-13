import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const launcher=fileURLToPath(new URL('./callisto.mjs',import.meta.url));
for(const backend of ['chromium','zen']) test(`launcher forwards ${backend} MCP capabilities`,async()=>{
  const state=mkdtempSync(join(tmpdir(),'callisto-launcher-'));
  const env={...process.env,CALLISTO_FIREFOX_STATE_DIR:state};
  const child=spawn(process.execPath,[launcher,backend],{env,stdio:['pipe','pipe','pipe']});
  let output='',errors=''; child.stderr.on('data',b=>errors+=b);
  try {
    const result=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error(`MCP timeout: ${errors}`)),10000);
      child.on('error',e=>{clearTimeout(timer);reject(e)});
      child.stdout.on('data',b=>{
        output+=b;
        if(output.includes('\n')){clearTimeout(timer);resolve(JSON.parse(output.split('\n')[0]));}
      });
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'callisto_capabilities',arguments:{}}})+'\n');
    });
    const capabilities=JSON.parse(result.result.content[0].text);
    assert.equal(capabilities.schemaVersion,1);
    assert.equal(capabilities.backend,backend==='zen'?'firefox-extension':'chromium-cdp');
    assert.equal(typeof capabilities.mode,'string');
    assert.equal(typeof capabilities.snapshot,'string');
    assert.equal(typeof capabilities.sessionModel,'string');
    for (const name of ['trustedInput','openShadowRoots','upload','existingTabAdoption','cancellation','handoff']) {
      assert.equal(typeof capabilities.capabilities[name], 'boolean', `${backend}: missing boolean capability ${name}`);
    }
    assert.equal(capabilities.capabilities.frames,'same-origin');
    if (backend === 'zen') {
      assert.equal(capabilities.capabilities.trustedInput,false);
      assert.equal(capabilities.capabilities.existingTabAdoption,true);
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve=>child.once('exit',resolve));
    if(backend==='zen') spawnSync(fileURLToPath(new URL('../packages/firefox-rs/target/release/callisto-firefox-tab-mcp',import.meta.url)),['--stop-relay'],{env,timeout:5000});
    rmSync(state,{recursive:true,force:true});
  }
});

for (const backend of ['chromium', 'zen']) test(`${backend} exposes the common agent tool names and inputs`, async () => {
  const state = mkdtempSync(join(tmpdir(), 'callisto-contract-'));
  const env = {...process.env, CALLISTO_FIREFOX_STATE_DIR: state};
  const child = spawn(process.execPath, [launcher, backend], {env, stdio:['pipe','pipe','pipe']});
  let output = '', errors = '';
  child.stderr.on('data', b => errors += b);
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP timeout: ${errors}`)), 10000);
      child.on('error', e => {clearTimeout(timer); reject(e)});
      child.stdout.on('data', b => {
        output += b;
        if (output.includes('\n')) {clearTimeout(timer); resolve(JSON.parse(output.split('\n')[0]))}
      });
      child.stdin.write(JSON.stringify({jsonrpc:'2.0', id:1, method:'tools/list', params:{}}) + '\n');
    });
    const contract = {
      callisto_capabilities: [], callisto_snapshot: [], callisto_navigate: ['url'],
      callisto_find: ['query'], callisto_scroll: ['delta_y'], callisto_click: ['ref'],
      callisto_fill: ['ref','value'], callisto_press: ['key'], callisto_screenshot: [],
      callisto_close: [], callisto_handoff: ['message'],
    };
    for (const [name, properties] of Object.entries(contract)) {
      const tool = result.result.tools.find(entry => entry.name === name);
      assert.ok(tool, `${backend} lacks ${name}`);
      for (const property of properties) assert.ok(tool.inputSchema.properties?.[property], `${backend} ${name} lacks ${property}`);
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    if (backend === 'zen') spawnSync(fileURLToPath(new URL('../packages/firefox-rs/target/release/callisto-firefox-tab-mcp', import.meta.url)), ['--stop-relay'], {env, timeout:5000});
    rmSync(state, {recursive:true, force:true});
  }
});
