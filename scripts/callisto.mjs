#!/usr/bin/env node
// Stable stdio launcher for the two supported backend families.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
if(process.env.CALLISTO_INSTALL_ROOT && process.argv[2]!=='doctor'){
  const checker=spawn(process.execPath,[fileURLToPath(new URL('./install-release.mjs',import.meta.url)),'--check','--prefix',process.env.CALLISTO_INSTALL_ROOT],{stdio:'ignore',detached:true});
  checker.on('error',()=>{});checker.unref();
}
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if(args[0]==='doctor') {
  const {diagnose}=await import('./doctor.mjs');
  const report=await diagnose(root,{backend:args[1]||'zen'});console.log(JSON.stringify(report,null,2));process.exitCode=report.ready?0:1;
} else if(args[0]==='setup') {
  const backend=args[1],host=args[2];
  if(!['zen','firefox','chromium'].includes(backend)||!['codex','claude'].includes(host)||args.length!==3){console.error('Usage: callisto setup <chromium|firefox|zen> <codex|claude>');process.exit(2);}
  const name='callisto-'+backend;
  const command=[process.execPath,process.env.CALLISTO_INSTALL_ROOT?resolve(process.env.CALLISTO_INSTALL_ROOT,'bin/callisto.mjs'):fileURLToPath(import.meta.url),backend];
  const flags=host==='codex'?['mcp','add',name,'--',...command]:['mcp','add','--scope','user','--transport','stdio',name,'--',...command];
  const setup=spawn(host,flags,{stdio:'inherit'});
  setup.on('error',error=>{console.error(error.message);process.exitCode=1;});
  setup.on('exit',code=>{process.exitCode=code??1;if(code===0)console.error('MCP entry registered. Restart MCP servers in your host to load it. Firefox/Zen still requires extension installation and initial pairing.');});
} else {
const backend = args[0] || process.env.CALLISTO_BROWSER || 'chromium';
if (!['chromium','firefox','zen','firefox-bidi','zen-bidi'].includes(backend) || args.length > 1) {
  console.error('Usage: node scripts/callisto.mjs [chromium|firefox|zen|firefox-bidi|zen-bidi]'); process.exit(2);
}
const firefox = backend !== 'chromium';
const bidi = backend.endsWith('-bidi');
const target = firefox
  ? (bidi ? process.env.CALLISTO_BIDI_BINARY : process.env.CALLISTO_FIREFOX_BINARY) || resolve(root,`packages/firefox-rs/target/release/${bidi?'callisto-firefox-mcp':'callisto-firefox-tab-mcp'}`)
  : resolve(root,'packages/mini/dist/mcp.js');
if (!existsSync(target)) {
  console.error(firefox ? `Build the runtime: cargo build --locked --release --manifest-path packages/firefox-rs/Cargo.toml --bin ${bidi?'callisto-firefox-mcp':'callisto-firefox-tab-mcp'}` : 'Build Mini: npm --prefix packages/mini ci && npm --prefix packages/mini run build');
  process.exit(1);
}
const child = spawn(firefox ? target : process.execPath, firefox ? [] : [target], {stdio:'inherit',env:bidi?{...process.env,CALLISTO_BROWSER:backend.split('-')[0],CALLISTO_MCP_BROWSER:process.env.CALLISTO_MCP_BROWSER||'connected'}:process.env});
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill(signal));
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',(code,signal)=>{process.exitCode=code ?? (signal ? 1 : 0);});
}
