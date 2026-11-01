import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {install,uninstall} from '../scripts/install.mjs';

async function fixture(layout={id:'root',type:'row',children:[{id:'terminal',type:'block',content:{tab:'active'}}]}){
  const home=await mkdtemp(join(tmpdir(),'bridge-install-'));
  const appHome=join(home,'.config/herdr-app'),stateDir=join(home,'.local/state/herdr-context-bridge');
  await mkdir(join(appHome,'layouts'),{recursive:true});
  await writeFile(join(appHome,'layouts/main.json'),JSON.stringify(layout));
  await mkdir(join(home,'.claude'),{recursive:true});
  const original={permissions:{allow:['Read']},statusLine:{type:'command',command:'printf original',padding:1},hooks:{Stop:[{hooks:[{type:'command',command:'printf existing'}]}]}};
  await writeFile(join(home,'.claude/settings.json'),JSON.stringify(original));
  return {home,appHome,stateDir,projectDir:resolve('.'),original};
}
const workspaceLayout={
  id:'root',type:'row',titlebar:'none',traffic_lights:[12,16],background:'canvas',terminal_padding:[14,12],divider:{width:1,color:'border'},
  children:[
    {id:'sidebar',type:'column',size:{px:268},min:44,max:480,children:[{id:'spaces',type:'block',content:{mod:'spaces'}}]},
    {id:'work',type:'column',resizable:false,children:[
      {id:'tabs',type:'block',size:{px:42},content:{mod:'tabs'}},
      {id:'work-body',type:'row',padding:8,gap:8,children:[{id:'terminal',type:'block',content:{tab:'active'}}]},
      {id:'status',type:'block',size:{px:28},content:{mod:'workspace-status',props:{custom:true}}},
    ]},
  ],
};
function blocks(layout){return [layout,...(layout.children||[]).flatMap(blocks)];}
async function installedLayout(o){return JSON.parse(await readFile(join(o.appHome,'layouts/context-bridge.json'),'utf8'));}
test('install shares the existing bottom status height without changing main or other workspace nodes',async()=>{
  const o=await fixture(workspaceLayout),main=join(o.appHome,'layouts/main.json');
  const before=await readFile(main);
  await install(o);
  const layout=await installedLayout(o),nodes=blocks(layout);
  assert.deepEqual(await readFile(main),before);
  const row=layout.children[1].children[2];
  assert.equal(row.type,'row');
  assert.deepEqual(row.size,{px:28});
  assert.equal(row.children.length,2);
  const [status,summary]=row.children;
  assert.equal(status.id,'status');
  assert.deepEqual(status.content,workspaceLayout.children[1].children[2].content);
  assert.deepEqual(status.size,{weight:1});
  assert.equal(status.min,0);
  assert.equal(summary.id,'context-bridge-summary');
  assert.deepEqual(summary.size,{px:460});
  assert.ok(summary.min<=280);
  assert.deepEqual(summary.content,{mod:'context-bridge',props:{role:'summary',node:process.execPath,helper:join(o.appHome,'mods/context-bridge/helper/cli.mjs')}});
  assert.equal(nodes.some(node=>node.id==='context-bridge-panel'),false);
  assert.equal(nodes.length,new Set(nodes.map(node=>node.id)).size);
  assert.deepEqual(layout.children[0],workspaceLayout.children[0]);
  assert.deepEqual(layout.children[1].children.slice(0,2),workspaceLayout.children[1].children.slice(0,2));
  for(const key of ['id','type','titlebar','traffic_lights','background','terminal_padding','divider']) assert.deepEqual(layout[key],workspaceLayout[key]);
});
test('reinstall replaces a previous right panel from the saved main layout without duplicate summaries',async()=>{
  const o=await fixture(workspaceLayout);
  await install(o);
  const old=structuredClone(workspaceLayout);
  old.children.push({id:'context-bridge-panel',type:'block',size:{px:320},content:{mod:'context-bridge'}});
  await writeFile(join(o.appHome,'layouts/context-bridge.json'),JSON.stringify(old));
  await install(o);
  const once=await installedLayout(o);
  await install(o);
  assert.deepEqual(await installedLayout(o),once);
  assert.equal(blocks(once).filter(node=>node.id==='context-bridge-summary').length,1);
  assert.equal(blocks(once).some(node=>node.id==='context-bridge-panel'),false);
  assert.equal(JSON.parse(await readFile(join(o.stateDir,'install.json'),'utf8')).baseLayout,'main');
});
test('layouts without a status bar get one bottom row and retain root window properties',async()=>{
  for(const type of ['row','column','block']) {
    const base={id:'custom-root',type,titlebar:'none',traffic_lights:[10,15],background:'canvas',terminal_padding:[9,7],terminal_menu:{position:'bottom'},preview:{background:'canvas'},divider:{width:1,color:'border'},
      ...(type==='block'?{content:{tab:'active'}}:{children:[{id:'terminal',type:'block',content:{tab:'active'}}]})};
    const o=await fixture(base),before=await readFile(join(o.appHome,'layouts/main.json'));
    await install(o);
    const layout=await installedLayout(o),nodes=blocks(layout);
    assert.equal(layout.type,'column');
    const bottom=layout.children.at(-1);
    assert.deepEqual(bottom.size,{px:28});
    assert.equal(bottom.id==='context-bridge-summary'||bottom.children?.at(-1).id==='context-bridge-summary',true);
    for(const key of ['titlebar','traffic_lights','background','terminal_padding','terminal_menu','preview','divider']) assert.deepEqual(layout[key],base[key]);
    assert.equal(nodes.filter(node=>node.content?.tab==='active').length,1);
    assert.equal(nodes.length,new Set(nodes.map(node=>node.id)).size);
    assert.deepEqual(await readFile(join(o.appHome,'layouts/main.json')),before);
  }
});
test('dry run does not change user files',async()=>{
  const o=await fixture(),before=await readFile(join(o.home,'.claude/settings.json'),'utf8');
  const plan=await install({...o,dryRun:true});
  assert.ok(plan.files.length>3);
  assert.equal(await readFile(join(o.home,'.claude/settings.json'),'utf8'),before);
  await assert.rejects(access(join(o.appHome,'mods/context-bridge/main.js')));
});
test('installed localization modules load and locale inspection leaves state untouched',async()=>{
  const o=await fixture();
  await install(o);
  const mod=join(o.appHome,'mods/context-bridge');
  for(const [installed,source] of [
    [join(mod,'i18n.js'),join(o.projectDir,'mods/context-bridge/i18n.js')],
    [join(mod,'helper/i18n.mjs'),join(o.projectDir,'src/i18n.mjs')],
  ]) assert.equal(await readFile(installed,'utf8'),await readFile(source,'utf8'));
  const unusedState=join(o.home,'locale-only-state');
  const output=execFileSync(process.execPath,[join(mod,'helper/cli.mjs'),'locale'],{
    encoding:'utf8',env:{HOME:o.home,PATH:'',LANG:'en_US.UTF-8',HERDR_BRIDGE_STATE_DIR:unusedState},
  });
  assert.deepEqual(Object.keys(JSON.parse(output)),['locale']);
  assert.ok(['en','ko','ja','zh-CN'].includes(JSON.parse(output).locale));
  await assert.rejects(access(unusedState),{code:'ENOENT'});
  await uninstall(o);
  await assert.rejects(access(join(mod,'i18n.js')),{code:'ENOENT'});
  await assert.rejects(access(join(mod,'helper/i18n.mjs')),{code:'ENOENT'});
});
test('install preserves existing hooks and statusLine options; uninstall restores originals',async()=>{
  const o=await fixture();
  await install(o);
  let settings=JSON.parse(await readFile(join(o.home,'.claude/settings.json'),'utf8'));
  assert.equal(settings.statusLine.padding,1);
  assert.equal(settings.hooks.Stop[0].hooks[0].command,'printf existing');
  assert.ok(settings.hooks.Stop.length>1);
  const saved=JSON.parse(await readFile(join(o.stateDir,'install.json'),'utf8'));
  assert.deepEqual(saved.originalStatusLine,o.original.statusLine);
  assert.equal(JSON.parse(await readFile(join(o.stateDir,'config.json'),'utf8')).mode,'ask');
  await uninstall(o);
  settings=JSON.parse(await readFile(join(o.home,'.claude/settings.json'),'utf8'));
  assert.deepEqual(settings,o.original);
  await assert.rejects(access(join(o.appHome,'mods/context-bridge/main.js')));
});
test('reinstall does not wrap itself; uninstall preserves unrelated later changes',async()=>{
  const o=await fixture(); await install(o); await install(o);
  const path=join(o.home,'.claude/settings.json');
  const settings=JSON.parse(await readFile(path,'utf8'));
  settings.newUserSetting=true;
  await writeFile(path,JSON.stringify(settings));
  await uninstall(o);
  const restored=JSON.parse(await readFile(path,'utf8'));
  assert.equal(restored.newUserSetting,true);
  assert.deepEqual(restored.statusLine,o.original.statusLine);
  assert.deepEqual(restored.hooks,o.original.hooks);
});
test('uninstall preserves later statusLine options and option removals',async()=>{
  const o=await fixture(); await install(o);
  const path=join(o.home,'.claude/settings.json');
  const settings=JSON.parse(await readFile(path,'utf8'));
  settings.statusLine.padding=7;
  settings.statusLine.refreshInterval=5;
  await writeFile(path,JSON.stringify(settings));
  await uninstall(o);
  let restored=JSON.parse(await readFile(path,'utf8'));
  assert.deepEqual(restored.statusLine,{...o.original.statusLine,padding:7,refreshInterval:5});
  await install(o);
  const installed=JSON.parse(await readFile(path,'utf8'));
  delete installed.statusLine.padding;
  await writeFile(path,JSON.stringify(installed));
  await uninstall(o);
  restored=JSON.parse(await readFile(path,'utf8'));
  assert.equal(Object.hasOwn(restored.statusLine,'padding'),false);
  assert.equal(restored.statusLine.command,o.original.statusLine.command);
});
test('reinstall wraps the latest user command while retaining the initial backup',async()=>{
  const o=await fixture(); await install(o);
  const path=join(o.home,'.claude/settings.json');
  const initial=JSON.parse(await readFile(join(o.stateDir,'install.json'),'utf8'));
  const settings=JSON.parse(await readFile(path,'utf8'));
  settings.statusLine={type:'command',command:'printf replacement',padding:9};
  settings.hooks.Stop.push({hooks:[{type:'command',command:'printf later-hook'}]});
  await writeFile(path,JSON.stringify(settings));
  await install(o);
  const saved=JSON.parse(await readFile(join(o.stateDir,'install.json'),'utf8'));
  assert.deepEqual(saved.originalStatusLine,settings.statusLine);
  assert.deepEqual(saved.originalClaude,initial.originalClaude);
  assert.equal(saved.files[path].before,initial.files[path].before);
  const output=execFileSync(process.execPath,[join(o.appHome,'mods/context-bridge/helper/cli.mjs'),'statusline'],{input:'{}',encoding:'utf8',env:{...process.env,HERDR_BRIDGE_STATE_DIR:o.stateDir}});
  assert.equal(output,'replacement');
  await uninstall(o);
  const restored=JSON.parse(await readFile(path,'utf8'));
  assert.deepEqual(restored.statusLine,settings.statusLine);
  assert.equal(restored.hooks.Stop.at(-1).hooks[0].command,'printf later-hook');
});
test('reinstall respects a removed statusLine instead of reviving the initial command',async()=>{
  const o=await fixture(); await install(o);
  const path=join(o.home,'.claude/settings.json');
  const settings=JSON.parse(await readFile(path,'utf8'));
  delete settings.statusLine;
  await writeFile(path,JSON.stringify(settings));
  await install(o);
  assert.equal(JSON.parse(await readFile(join(o.stateDir,'install.json'),'utf8')).originalStatusLine,null);
  await uninstall(o);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(path,'utf8')),'statusLine'),false);
});
