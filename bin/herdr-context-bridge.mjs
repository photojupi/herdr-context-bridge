#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {install,uninstall} from '../scripts/install.mjs';
import {t} from '../src/i18n.mjs';

// npx runs this through a symlink or cmd shim, so there is no direct-run guard.
// Anything unrecognized stops before touching user settings: a typo such as
// --dryrun must never become a real install.
const args=process.argv.slice(2),[command,...rest]=args;
try {
  if(!args.length||(args.length===1&&['--help','-h'].includes(command))) console.log(t('cli.usage'));
  else if(args.length===1&&['--version','-v'].includes(command)) console.log(JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version);
  else if(['install','uninstall'].includes(command)&&(!rest.length||(rest.length===1&&rest[0]==='--dry-run'))) console.log(JSON.stringify(await (command==='install'?install:uninstall)({dryRun:rest.length===1}),null,2));
  else throw new Error(t('알 수 없는 명령 또는 옵션입니다: {arg}. --help로 사용법을 확인해 주세요.',{arg:['install','uninstall'].includes(command)?rest.find(arg=>arg!=='--dry-run')??rest.at(-1):['--help','-h','--version','-v'].includes(command)?rest[0]:command}));
} catch(e){console.error(JSON.stringify({error:e.message}));process.exitCode=1;}
