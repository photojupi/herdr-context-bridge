import {readFile,writeFile,mkdir,readdir,unlink} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {atomicJson,readJson,homeDirectory} from '../src/storage.mjs';
import {t} from '../src/i18n.mjs';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const digest=value=>createHash('sha256').update(value).digest('hex');
const shellQuote=value=>"'"+value.replaceAll("'","'\\''")+"'";
function paths(options={}) {
  const env=options.env||process.env,home=options.home||homeDirectory(env,options.platform);
  return {home,appHome:options.appHome||env.HERDR_APP_HOME||join(env.XDG_CONFIG_HOME||join(home,'.config'),'herdr-app'),stateDir:options.stateDir||env.HERDR_BRIDGE_STATE_DIR||join(home,'.local/state/herdr-context-bridge'),projectDir:options.projectDir||project};
}
async function maybe(path) {try{return await readFile(path);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function filesUnder(root,prefix='') {
  const out=[];
  for(const ent of await readdir(join(root,prefix),{withFileTypes:true})) {
    const path=join(prefix,ent.name);
    if(ent.isDirectory()) out.push(...await filesUnder(root,path));
    else if(ent.isFile()) out.push(path);
  }
  return out;
}
function addHooks(settings,provider,command) {
  const result=structuredClone(settings);
  result.hooks ||= {};
  for(const event of ['SessionStart','Stop',...(provider==='claude'?['StopFailure']:[])]) {
    result.hooks[event] ||= [];
    if(!result.hooks[event].some(group=>group.hooks?.some(h=>h.command===command))) result.hooks[event].push({hooks:[{type:'command',command,timeout:5}]});
  }
  return result;
}
function removeHooks(settings,command,original) {
  const result=structuredClone(settings);
  for(const [event,groups] of Object.entries(result.hooks||{})) {
    result.hooks[event]=groups.map(group=>({...group,hooks:group.hooks?.filter(h=>h.command!==command)})).filter(group=>group.hooks?.length);
    if(!result.hooks[event].length && !Object.hasOwn(original.hooks||{},event)) delete result.hooks[event];
  }
  if(result.hooks&&!Object.keys(result.hooks).length&&!Object.hasOwn(original,'hooks')) delete result.hooks;
  return result;
}
const isBridgeNode=node=>node?.id==='context-bridge-summary'||node?.id==='context-bridge-panel';
function stripSummary(node) {
  if(!Array.isArray(node?.children)) return node;
  const children=[];
  for(const raw of node.children) {
    if(isBridgeNode(raw)) continue;
    const child=stripSummary(raw);
    if(child.id==='context-bridge-status-row'&&Array.isArray(child.children)) {
      const rest=child.children.filter(c=>!isBridgeNode(c));
      if(!rest.length) continue;
      if(rest.length===1&&rest[0].type==='block'&&rest[0].content?.mod==='workspace-status') {
        const {size:_s,min:_m,max:_x,...status}=rest[0];
        children.push({...status,...(child.size===undefined?{}:{size:child.size}),...(child.min===undefined?{}:{min:child.min}),...(child.max===undefined?{}:{max:child.max})});
        continue;
      }
      children.push({...child,children:rest});
      continue;
    }
    children.push(child);
  }
  const next={...node,children};
  if(next.id==='bridge-root'&&children.length===1) {
    const inner={...children[0]};
    if(next.cloned_from&&!Object.hasOwn(inner,'cloned_from')) inner.cloned_from=next.cloned_from;
    return inner;
  }
  return next;
}
function addSummary(layout,summary) {
  for(const [index,child] of (layout.children||[]).entries()) {
    if(child.type==='block'&&child.content?.mod==='workspace-status') {
      const {size,min,max,...status}=child;
      layout.children[index]={id:'context-bridge-status-row',type:'row',size,...(min===undefined?{}:{min}),...(max===undefined?{}:{max}),resizable:false,children:[{...status,size:{weight:1},min:0},summary]};
      return true;
    }
    if(addSummary(child,summary)) return true;
  }
  return false;
}
export async function install(options={}) {
  const {home,appHome,stateDir,projectDir}=paths(options);
  const manifestPath=join(stateDir,'install.json');
  const previous=await readJson(manifestPath);
  const modDir=join(appHome,'mods/context-bridge');
  if(!previous && await maybe(join(modDir,'main.js'))) throw new Error(t('같은 이름의 mod가 이미 있습니다. 덮어쓰지 않았습니다.'));
  const helper=join(modDir,'helper/cli.mjs');
  // This bootstrap contains no user path in shell syntax. It works in cmd,
  // PowerShell and Git Bash; Windows requires node on the provider's PATH.
  const win32=(options.platform??process.platform)==='win32';
  const bootstrap=`const p=Buffer.from('${Buffer.from(helper).toString('base64')}','base64').toString();process.argv.splice(1,0,p);import(require('node:url').pathToFileURL(p).href)`;
  // AGY runs Windows statusLine via Go's exec.Command("cmd", "/c", ...), which escapes inner double quotes.
  const agyBootstrap=`process.argv.splice(1,0,Buffer.from('${Buffer.from(helper).toString('base64url')}','base64url').toString()),import(require('node:url').pathToFileURL(process.argv[1]).href)`;
  const command=mode=>win32
    ? `node -e "${bootstrap}" ${mode}`
    : `${shellQuote(process.execPath)} ${shellQuote(helper)} ${mode}`;
  const claudePath=join(home,'.claude/settings.json'),codexPath=join(home,'.codex/hooks.json'),agyPath=join(home,'.gemini/antigravity-cli/settings.json');
  const claude=await readJson(claudePath,{}),codex=await readJson(codexPath,{}),agy=await readJson(agyPath,{});
  const originalClaude=previous?.originalClaude ?? structuredClone(claude);
  const originalCodex=previous?.originalCodex ?? structuredClone(codex);
  const originalStatusLine=previous&&claude.statusLine?.command===previous.statusCommand?previous.originalStatusLine:(claude.statusLine??null);
  const agyWrapped=typeof previous?.agyStatusCommand==='string'&&agy.statusLine?.command===previous.agyStatusCommand;
  const originalAgyStatusLine=agyWrapped?previous.originalAgyStatusLine:(agy.statusLine??null);
  const agyDefaultStack=agyWrapped?previous.agyDefaultStack:!agy.statusLine?.command&&!Object.hasOwn(agy.statusLine||{},'stack_with_default');
  const claudeCommand=command('capture claude'),codexCommand=command('capture codex'),statusCommand=command('statusline'),agyStatusCommand=win32?`node -e ${agyBootstrap} statusline agy`:command('statusline agy');
  let newClaude=addHooks(claude,'claude',claudeCommand);
  newClaude.statusLine={...(claude.statusLine||{}),type:'command',command:statusCommand};
  const newCodex=addHooks(codex,'codex',codexCommand);
  const newAgy={...agy,statusLine:{...(agy.statusLine||{}),...(!agyWrapped&&agyDefaultStack?{stack_with_default:true}:{}),type:'command',command:agyStatusCommand}};
  const baseName=options.layoutName||previous?.baseLayout||'main';
  if(!/^[a-zA-Z0-9_-]+$/.test(baseName)) throw new Error(t('잘못된 레이아웃 이름입니다.'));
  const layoutPath=join(appHome,'layouts/context-bridge.json');
  const existingLayout=options.layoutName&&options.layoutName!==previous?.baseLayout?null:await readJson(layoutPath);
  const base=existingLayout??await readJson(join(appHome,'layouts',baseName+'.json'));
  if(!base) throw new Error(t('먼저 herdr-app을 한 번 실행해 주세요.'));
  const clone=stripSummary(structuredClone(base));
  if(!existingLayout) clone.cloned_from={name:baseName,version:'0.1.10'};
  else clone.cloned_from ??= {name:baseName,version:'0.1.10'};
  const summary={id:'context-bridge-summary',type:'block',size:{px:640},min:0,max:640,content:{mod:'context-bridge',props:{role:'summary',node:process.execPath,helper}}};
  let layout=clone;
  if(!addSummary(clone,summary)) {
    const bottom={id:'context-bridge-status-row',type:'row',size:{px:28},resizable:false,children:[summary]};
    if(clone.type==='column') clone.children.push(bottom);
    else {
      layout={id:'bridge-root',type:'column',cloned_from:clone.cloned_from,children:[clone,bottom]};
      for(const key of ['titlebar','traffic_lights','background','terminal_padding','terminal_menu','preview','divider']) if(Object.hasOwn(clone,key)) layout[key]=clone[key];
    }
  }
  const writes=[];
  for(const relative of await filesUnder(join(projectDir,'mods/context-bridge'))) if(relative==='mod.json'||relative.endsWith('.js')) writes.push({path:join(modDir,relative),bytes:await readFile(join(projectDir,'mods/context-bridge',relative))});
  for(const relative of await filesUnder(join(projectDir,'src'))) if(relative.endsWith('.mjs')) writes.push({path:join(modDir,'helper',relative),bytes:await readFile(join(projectDir,'src',relative))});
  writes.push({path:layoutPath,bytes:Buffer.from(JSON.stringify(layout,null,2)+'\n')});
  writes.push({path:claudePath,bytes:Buffer.from(JSON.stringify(newClaude,null,2)+'\n'),config:true});
  writes.push({path:codexPath,bytes:Buffer.from(JSON.stringify(newCodex,null,2)+'\n'),config:true});
  writes.push({path:agyPath,bytes:Buffer.from(JSON.stringify(newAgy,null,2)+'\n'),config:true});
  const report={files:writes.map(w=>w.path),baseLayout:baseName,layout:'context-bridge',hookTrustRequired:true};
  if(options.dryRun) return report;
  const records=previous?.files||{};
  // Save original state before touching any managed setting, so interrupted installs are recoverable.
  for(const w of writes) {
    if(!records[w.path]) {const before=await maybe(w.path);records[w.path]={before:before?.toString('base64')??null};}
    records[w.path].afterHash=digest(w.bytes);records[w.path].config=!!w.config;
  }
  const manifest={version:1,installedAt:previous?.installedAt||Date.now(),updatedAt:Date.now(),appHome,baseLayout:baseName,originalStatusLine,originalAgyStatusLine,agyDefaultStack,originalClaude,originalCodex,claudePath,codexPath,agyPath,claudeCommand,codexCommand,statusCommand,agyStatusCommand,files:records};
  await atomicJson(manifestPath,manifest);
  for(const w of writes) {
    await mkdir(dirname(w.path),{recursive:true,mode:0o700});
    await writeFile(w.path,w.bytes,{mode:0o600});
  }
  if(!await readJson(join(stateDir,'config.json'))) await atomicJson(join(stateDir,'config.json'),{mode:'ask',threshold:10,autoSessions:[]});
  return report;
}
export async function uninstall(options={}) {
  const {stateDir}=paths(options),manifestPath=join(stateDir,'install.json'),manifest=await readJson(manifestPath);
  if(!manifest) return {removed:[],preserved:[]};
  const removed=[],preserved=[];
  const claude=await readJson(manifest.claudePath,{});
  const restoredClaude=removeHooks(claude,manifest.claudeCommand,manifest.originalClaude);
  if(claude.statusLine?.command===manifest.statusCommand) {
    for(const key of ['type','command']) {
      if(Object.hasOwn(manifest.originalStatusLine||{},key)) restoredClaude.statusLine[key]=manifest.originalStatusLine[key];
      else delete restoredClaude.statusLine[key];
    }
    if(!Object.keys(restoredClaude.statusLine).length) delete restoredClaude.statusLine;
  }
  const restoredCodex=removeHooks(await readJson(manifest.codexPath,{}),manifest.codexCommand,manifest.originalCodex);
  let restoredAgy;
  if(manifest.agyPath) {
    restoredAgy=await readJson(manifest.agyPath,{});
    if(restoredAgy.statusLine?.command===manifest.agyStatusCommand) {
      for(const key of ['type','command']) {
        if(Object.hasOwn(manifest.originalAgyStatusLine||{},key)) restoredAgy.statusLine[key]=manifest.originalAgyStatusLine[key];
        else delete restoredAgy.statusLine[key];
      }
      if(manifest.agyDefaultStack&&restoredAgy.statusLine.stack_with_default===true) delete restoredAgy.statusLine.stack_with_default;
      if(!Object.keys(restoredAgy.statusLine).length) delete restoredAgy.statusLine;
    }
  }
  if(!options.dryRun) {
    await atomicJson(manifest.claudePath,restoredClaude);
    if(Object.keys(restoredCodex).length || manifest.files[manifest.codexPath]?.before!==null) await atomicJson(manifest.codexPath,restoredCodex);
    else await unlink(manifest.codexPath).catch(()=>{});
    if(restoredAgy) {
      if(Object.keys(restoredAgy).length || manifest.files[manifest.agyPath]?.before!==null) await atomicJson(manifest.agyPath,restoredAgy);
      else await unlink(manifest.agyPath).catch(()=>{});
    }
  }
  const layoutPath=manifest.appHome?join(manifest.appHome,'layouts/context-bridge.json'):null;
  const baseLayout=layoutPath?await readJson(join(manifest.appHome,'layouts',(manifest.baseLayout||'main')+'.json')):null;
  const withoutOrigin=value=>{if(!value||typeof value!=='object')return value;const {cloned_from:_c,...rest}=value;return rest;};
  for(const [path,record] of Object.entries(manifest.files)) {
    if(record.config) continue;
    const current=await maybe(path);
    if(!current) continue;
    let keep=digest(current)!==record.afterHash,parsedLayout=null,strippedLayout=null;
    if(path===layoutPath) {
      try {
        parsedLayout=JSON.parse(current.toString('utf8'));
        strippedLayout=stripSummary(parsedLayout);
        const reference=record.before!==null?JSON.parse(Buffer.from(record.before,'base64').toString('utf8')):baseLayout;
        if(reference&&!isDeepStrictEqual(withoutOrigin(strippedLayout),withoutOrigin(stripSummary(reference)))) keep=true;
      } catch { keep=true; }
    }
    if(keep) {
      if(path===layoutPath&&!options.dryRun&&strippedLayout&&!isDeepStrictEqual(strippedLayout,parsedLayout)) await atomicJson(path,strippedLayout);
      preserved.push(path);
      continue;
    }
    removed.push(path);
    if(!options.dryRun) {if(record.before!==null) await writeFile(path,Buffer.from(record.before,'base64'));else await unlink(path);}
  }
  if(!options.dryRun) {await atomicJson(join(stateDir,'last-install.json'),manifest);await unlink(manifestPath);}
  return {removed,preserved,baseLayout:manifest.baseLayout,dataRetained:stateDir};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const options={dryRun:process.argv.includes('--dry-run')};
  try {console.log(JSON.stringify(await (process.argv.includes('--uninstall')?uninstall(options):install(options)),null,2));}
  catch(e){console.error(JSON.stringify({error:e.message}));process.exitCode=1;}
}
