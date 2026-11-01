import {spawnCommand} from './commands.mjs';
import {safeId} from './storage.mjs';
import {t} from './i18n.mjs';

// Herdr tab.new accepts argv but no environment map. A Node launcher sets the
// origin before the provider starts, without shell interpolation of the prompt.
export async function launchTarget(target,jobId,automatic,prompt) {
  if(!['claude','codex'].includes(target)||!['0','1'].includes(automatic)||typeof prompt!=='string') throw new Error(t('잘못된 세션입니다.'));
  safeId(jobId);
  const child=await spawnCommand(target,[...(target==='codex'?['--no-daemon']:[]),prompt],{
    stdio:'inherit',env:{...process.env,HERDR_BRIDGE_AUTO_ORIGIN:automatic,HERDR_BRIDGE_JOB_ID:jobId},
  });
  const stop=()=>child.kill('SIGTERM');
  process.on('SIGTERM',stop);
  process.on('SIGHUP',stop);
  try {
    return await new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',code=>resolve(code??1));
    });
  } finally {
    process.off('SIGTERM',stop);
    process.off('SIGHUP',stop);
  }
}
