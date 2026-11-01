import {readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
async function check(dir){for(const ent of await readdir(dir,{withFileTypes:true})){const path=join(dir,ent.name);if(ent.isDirectory())await check(path);else if(/\.(mjs|js)$/.test(path))execFileSync(process.execPath,['--check',path],{stdio:'pipe'});}}
for(const dir of ['src','scripts','mods','test'])await check(resolve(dir));
console.log('모든 JavaScript 구문 검사 통과');
