import {readFile} from 'node:fs/promises';
import {createStorageBackend} from '../src/supabase-storage.mjs';
import {createClient} from '../src/lyria-spike.mjs';
import {createGmailDelivery} from '../src/gmail-delivery.mjs';
import {loadGmailConfiguration} from '../src/gmail-auth.mjs';
import {processSongRequest} from '../src/song-request-worker.mjs';
import {createGoogleRestoreClient} from '../src/lyria-restore.mjs';
import {processQueuedRestore} from '../src/queued-song-restore.mjs';
import {validateNotificationKey} from '../src/notification-secret.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let startupPhase='runtime_config',backend;
try{
 const config=JSON.parse(await readFile(new URL('../artifacts/request-service/runtime.json',import.meta.url),'utf8'));
 validateNotificationKey(config.key);
 startupPhase='database_config';backend=createStorageBackend({url:process.env.SUPABASE_URL||'https://fuvgpqkyhuyanbfavwcg.supabase.co',serviceRoleKey:process.env.SUPABASE_SERVICE_ROLE_KEY});
 startupPhase='gmail_config';const gmail=await loadGmailConfiguration();if(!gmail)throw new Error();
 startupPhase='gmail_auth';const mailer=createGmailDelivery(gmail);await mailer.checkConnection();
 startupPhase='generation_config';const client=createClient({apiKey:process.env.GEMINI_API_KEY});
 const restoreClient=createGoogleRestoreClient({apiKey:process.env.GEMINI_API_KEY});
 let running=true,heartbeatBusy=false;
 for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{running=false;});
 const beat=async()=>{if(heartbeatBusy)return;heartbeatBusy=true;try{await backend.touchRequestWorker();}catch{}finally{heartbeatBusy=false;}};
 startupPhase='heartbeat';if(!await backend.touchRequestWorker())throw new Error('heartbeat_not_ready');
 await backend.recordWorkerEvent({kind:'started',phase:'ready',code:'worker_started'});
 const timer=setInterval(beat,10000);
 console.log('Song request worker ready. Credentials verified; no music or mail yet.');
 try{while(running){
  let job;try{const restore=await backend.claimQueuedRestore();if(restore){console.log(JSON.stringify(await processQueuedRestore({job:restore,backend,restoreClient,mailer,key:config.key,origin:config.origin})));continue;}job=await backend.claimRequest();}catch{console.error('Request queue read failed. No generation retried.');await pause(5000);continue;}
  if(job){console.log(JSON.stringify(await processSongRequest({job,backend,client,mailer,key:config.key,origin:config.origin})));}
  else await pause(2000);
 }}finally{clearInterval(timer);}
}catch(error){const code=startupPhase==='gmail_auth'?'mail_auth_failed':startupPhase==='heartbeat'?'heartbeat_failed':'startup_failed';
 console.error(JSON.stringify({event:'worker_start_failed',phase:startupPhase,code,errorType:['Error','TypeError','RangeError','GmailDeliveryError','GmailAuthError'].includes(error?.name)?error.name:'Error'}));
 try{await backend?.recordWorkerEvent({kind:'startup_failed',phase:startupPhase,code});}catch{}process.exitCode=1;}
