import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,stat,copyFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execSync,spawnSync} from 'node:child_process';

// npx runs this file for users, and it edits their provider settings. Every run
// below points HOME, USERPROFILE, Herdr and state paths at a temporary folder.
const project=fileURLToPath(new URL('..',import.meta.url));
const bin=join(project,'bin/herdr-context-bridge.mjs');
const original={permissions:{allow:['Read']},statusLine:{type:'command',command:'printf original',padding:1},hooks:{Stop:[{hooks:[{type:'command',command:'printf existing'}]}]}};
const layout={id:'root',type:'row',children:[{id:'terminal',type:'block',content:{tab:'active'}}]};
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'bridge-package-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const home=join(root,'home'),appHome=join(root,'app'),stateDir=join(root,'state');
  await mkdir(join(appHome,'layouts'),{recursive:true});
  await writeFile(join(appHome,'layouts/main.json'),JSON.stringify(layout));
  await mkdir(join(home,'.claude'),{recursive:true});
  await writeFile(join(home,'.claude/settings.json'),JSON.stringify(original));
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(HOME|USERPROFILE|HERDR_APP_HOME|HERDR_BRIDGE_STATE_DIR|XDG_CONFIG_HOME)$/i.test(key)));
  return {root,home,appHome,stateDir,env:{...env,HOME:home,USERPROFILE:home,HERDR_APP_HOME:appHome,HERDR_BRIDGE_STATE_DIR:stateDir}};
}
async function snapshot(root) {
  const out={};
  for(const name of (await readdir(root,{recursive:true})).sort()) if((await stat(join(root,name))).isFile()) out[name]=await readFile(join(root,name),'utf8');
  return out;
}
const run=(f,args,cli=bin)=>spawnSync(process.execPath,[cli,...args],{env:f.env,encoding:'utf8'});
const claudeSettings=async f=>JSON.parse(await readFile(join(f.home,'.claude/settings.json'),'utf8'));

test('the published package alone can install the mod and a working helper',async t=>{
  // npm on Windows is a .cmd shim, so it has to go through a shell.
  const [pack]=JSON.parse(execSync('npm pack --dry-run --json',{cwd:project,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  const files=pack.files.map(file=>file.path.replaceAll('\\','/'));
  for(const required of ['package.json','LICENSE','README.md','bin/herdr-context-bridge.mjs','scripts/install.mjs','src/cli.mjs','mods/context-bridge/main.js','mods/context-bridge/mod.json']) assert.ok(files.includes(required),required);
  // Tests, CI and internal notes are not needed to install and only enlarge the download.
  for(const excluded of ['test/','docs/','.github/','RECIPE.md','AGENTS.md']) assert.equal(files.some(path=>path===excluded||path.startsWith(excluded)),false,excluded);
  const f=await fixture(t),pkg=join(f.root,'package');
  for(const path of files) {await mkdir(dirname(join(pkg,path)),{recursive:true});await copyFile(join(project,path),join(pkg,path));}
  const result=run(f,['install'],join(pkg,'bin/herdr-context-bridge.mjs'));
  assert.equal(result.status,0,result.stderr);
  const mod=join(f.appHome,'mods/context-bridge');
  for(const path of ['main.js','mod.json','helper/cli.mjs']) await access(join(mod,path));
  assert.ok(JSON.parse(result.stdout).files.includes(join(mod,'helper/cli.mjs')));
  // The installed helper must have every module it imports, or hooks fail after install.
  const locale=spawnSync(process.execPath,[join(mod,'helper/cli.mjs'),'locale'],{env:f.env,encoding:'utf8'});
  assert.equal(locale.status,0,locale.stderr);
  assert.deepEqual(Object.keys(JSON.parse(locale.stdout)),['locale']);
});

test('help and no arguments only print usage and change nothing',async t=>{
  const f=await fixture(t),before=await snapshot(f.root);
  for(const args of [[],['--help'],['-h']]) {
    const result=run(f,args);
    assert.equal(result.status,0,result.stderr);
    assert.match(result.stdout,/herdr-context-bridge install/);
    assert.deepEqual(await snapshot(f.root),before,args.join(' '));
  }
});

test('typos and unknown commands fail without installing anything',async t=>{
  // A mistyped --dry-run must never fall through to a real install of user settings.
  const f=await fixture(t),before=await snapshot(f.root);
  for(const args of [['install','--dryrun'],['install','--dry-run','extra'],['uninstall','-n'],['frobnicate'],['--uninstall'],['install','install'],['--help','extra'],['--version','x']]) {
    const result=run(f,args);
    assert.equal(result.status,1,args.join(' '));
    // The error names the argument that was not understood, so the user can fix that one.
    assert.ok(JSON.parse(result.stderr).error.includes(args.at(-1)),args.join(' '));
    assert.equal(result.stdout,'');
    assert.deepEqual(await snapshot(f.root),before,args.join(' '));
  }
});

test('dry run writes nothing, and uninstall restores the settings install changed',async t=>{
  const f=await fixture(t),before=await snapshot(f.root);
  const plan=run(f,['install','--dry-run']);
  assert.equal(plan.status,0,plan.stderr);
  assert.ok(JSON.parse(plan.stdout).files.includes(join(f.home,'.claude/settings.json')));
  assert.deepEqual(await snapshot(f.root),before);
  assert.equal(run(f,['install']).status,0);
  assert.notDeepEqual(await claudeSettings(f),original);
  const preview=await snapshot(f.root);
  assert.equal(run(f,['uninstall','--dry-run']).status,0);
  assert.deepEqual(await snapshot(f.root),preview);
  const removed=run(f,['uninstall']);
  assert.equal(removed.status,0,removed.stderr);
  assert.ok(JSON.parse(removed.stdout).removed.length>0);
  assert.deepEqual(await claudeSettings(f),original);
  await assert.rejects(access(join(f.appHome,'mods/context-bridge/main.js')),{code:'ENOENT'});
});

test('version matches the published package version',async t=>{
  const f=await fixture(t),{version}=JSON.parse(await readFile(join(project,'package.json'),'utf8'));
  for(const flag of ['--version','-v']) {
    const result=run(f,[flag]);
    assert.equal(result.status,0,result.stderr);
    assert.equal(result.stdout.trim(),version);
  }
});
