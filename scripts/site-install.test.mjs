import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, copyFileSync, symlinkSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const installer = resolve('site/install.sh');

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'callisto-site-install-'));
  t.after(() => rmSync(directory, {recursive:true, force:true}));
  const bin = join(directory, 'bin'), source = join(directory, 'source');
  mkdirSync(bin); mkdirSync(join(source, 'scripts'), {recursive:true});
  copyFileSync(resolve('scripts/callisto.mjs'), join(source, 'scripts/callisto.mjs'));
  const stub = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const name = path.basename(process.argv[1]), args = process.argv.slice(2);
fs.appendFileSync(process.env.INSTALL_TEST_LOG, JSON.stringify({name,args})+'\\n');
if (name === 'git' && args.includes('checkout')) {
  fs.cpSync(process.env.INSTALL_TEST_SOURCE, args[args.indexOf('-C')+1], {recursive:true});
}
if (name === 'cargo' || name === 'npm') {
  if (process.env.INSTALL_TEST_FAIL_BUILD) process.exit(9);
  if (name === 'cargo') {
    const manifest = args[args.indexOf('--manifest-path')+1];
    const target = path.join(path.dirname(manifest), 'target/release/callisto-firefox-tab-mcp');
    fs.mkdirSync(path.dirname(target), {recursive:true});
    fs.writeFileSync(target, '#!${process.execPath}\\nconsole.log("callisto-firefox-tab-mcp fixture");\\n', {mode:0o755});
  } else if (args.includes('build')) {
    const target = path.join(args[args.indexOf('--prefix')+1], 'dist/mcp.js');
    fs.mkdirSync(path.dirname(target), {recursive:true}); fs.writeFileSync(target, '// fixture');
  }
}
if (process.env.INSTALL_TEST_DESTINATION_RACE && name === 'cargo') {
  fs.mkdirSync(process.env.CALLISTO_INSTALL_DIR); fs.writeFileSync(path.join(process.env.CALLISTO_INSTALL_DIR,'keep'), 'existing');
}
`;
  for (const name of ['git','cargo','npm','codex','claude','opencode']) writeFileSync(join(bin,name), stub, {mode:0o755});
  const log = join(directory, 'commands.jsonl');
  const environment = {...process.env, PATH:bin+':'+process.env.PATH, XDG_DATA_HOME:join(directory,'data'), INSTALL_TEST_LOG:log, INSTALL_TEST_SOURCE:source};
  delete environment.CALLISTO_INSTALL_DIR;
  delete environment.CALLISTO_INSTALL_ROOT;
  return {
    directory, environment,
    run(args=[], extra={}) {return spawnSync('/bin/bash', [installer,...args], {cwd:directory, env:{...environment,...extra}, encoding:'utf8', timeout:10000});},
    calls() {return existsSync(log) ? readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line)) : [];},
  };
}

function configuration(result, backend) {
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const json = result.stdout.split('MCP configuration:\n')[1].split('\n\nOpenCode')[0];
  return JSON.parse(json).mcpServers['callisto-'+backend];
}

test('default builds the Zen bridge and prints a launcher explicitly selecting zen', t => {
  const f = fixture(t), result = f.run();
  const server = configuration(result,'zen');
  assert.equal(server.command, process.execPath);
  assert.deepEqual(server.args, [join(f.directory,'data/callisto-zen/scripts/callisto.mjs'),'zen']);
  assert.ok(existsSync(join(f.directory,'data/callisto-zen/packages/firefox-rs/target/release/callisto-firefox-tab-mcp')));
  assert.equal(f.calls().filter(call=>call.name==='cargo').length,1);
  assert.equal(f.calls().filter(call=>call.name==='npm').length,0);
  assert.match(result.stdout,/Callisto pairing code/);
  const fetch = f.calls().find(call=>call.name==='git' && call.args.includes('fetch'));
  assert.match(fetch.args.at(-1),/^[0-9a-f]{40}$/);
});

test('Chromium is explicit and does not claim to pair with the Firefox extension', t => {
  const f = fixture(t), result = f.run(['--backend','chromium']);
  assert.equal(configuration(result,'chromium').args.at(-1),'chromium');
  assert.equal(f.calls().filter(call=>call.name==='cargo').length,0);
  assert.equal(f.calls().filter(call=>call.name==='npm').length,2);
  assert.match(result.stdout,/does not pair with the Firefox\/Zen extension/);
});

test('Zen can be added alongside a legacy Mini install without changing its files', t => {
  const f = fixture(t), old = join(f.directory,'data/callisto');
  mkdirSync(old,{recursive:true}); writeFileSync(join(old,'keep'),'original');
  configuration(f.run(),'zen');
  assert.equal(readFileSync(join(old,'keep'),'utf8'),'original');
  assert.deepEqual(readdirSync(old),['keep']);
});

test('existing custom destinations are preserved before downloading or registering', t => {
  const f = fixture(t), destination = join(f.directory,'existing');
  mkdirSync(destination); writeFileSync(join(destination,'keep'),'original');
  const result = f.run(['--host','opencode'],{CALLISTO_INSTALL_DIR:destination});
  assert.equal(result.status,1); assert.match(result.stderr,/already exists/);
  assert.equal(readFileSync(join(destination,'keep'),'utf8'),'original');
  assert.deepEqual(f.calls(),[]);
});

test('a build failure removes staging and does not install or register a partial runtime', t => {
  const f = fixture(t), result = f.run(['--host','opencode'],{INSTALL_TEST_FAIL_BUILD:'1'});
  assert.equal(result.status,9);
  assert.deepEqual(readdirSync(join(f.directory,'data')),[]);
  assert.equal(f.calls().filter(call=>call.name==='opencode').length,0);
  assert.doesNotMatch(result.stdout,/is installed at/);
});

for (const host of ['codex','claude','opencode']) test(`opt-in ${host} registration uses the selected bridge and paths with spaces`, t => {
  const f = fixture(t), destination = join(f.directory,'install with spaces');
  const result = f.run(['--backend','firefox','--host',host],{CALLISTO_INSTALL_DIR:destination});
  configuration(result,'firefox');
  const registration = f.calls().find(call=>call.name===host);
  assert.ok(registration); assert.ok(registration.args.includes('callisto-firefox'));
  assert.ok(registration.args.includes(join(destination,'scripts/callisto.mjs')));
  assert.equal(registration.args.at(-1),'firefox');
});

test('a destination appearing during the build is preserved', t => {
  const f = fixture(t), destination = join(f.directory,'appeared');
  const result = f.run([],{CALLISTO_INSTALL_DIR:destination,INSTALL_TEST_DESTINATION_RACE:'1'});
  assert.equal(result.status,1); assert.match(result.stderr,/appeared during installation/);
  assert.deepEqual(readdirSync(destination),['keep']);
  assert.equal(readdirSync(f.directory).some(name=>name.startsWith('.callisto-install.')),false);
});

test('invalid arguments fail before downloading and help needs no build tools', t => {
  const f = fixture(t);
  for (const args of [['--backend','unknown'],['--host','unknown'],['--backend'],['--unknown']]) assert.equal(f.run(args).status,2);
  assert.equal(f.run(['--help']).status,0);
  assert.deepEqual(f.calls(),[]);
});

test('missing Rust fails before downloading with an actionable dependency error', t => {
  const f=fixture(t), minimal=join(f.directory,'minimal-bin'); mkdirSync(minimal);
  symlinkSync(process.execPath,join(minimal,'node'));
  symlinkSync(join(f.directory,'bin/git'),join(minimal,'git'));
  writeFileSync(join(minimal,'uname'),'#!/bin/sh\nprintf "Linux\\n"\n',{mode:0o755});
  const result=f.run([],{PATH:minimal});
  assert.equal(result.status,1); assert.match(result.stderr,/requires cargo/);
  assert.deepEqual(f.calls(),[]); assert.equal(existsSync(join(f.directory,'data')),false);
});
