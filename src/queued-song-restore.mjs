import {hashResultToken} from './identifiers.mjs';
import {openResultToken,sealResultToken} from './notification-secret.mjs';
import {reissueSong} from './song-reissue.mjs';
import {deliverResultNotifications} from './result-notifications.mjs';
export async function processQueuedRestore({job,backend,restoreClient,mailer,key,origin}){
 let ready=false;
 try{
  const recipient='dukedrum@gmail.com';
  const token=openResultToken({sealedToken:job.sealed_token,key,songId:job.song_id,recipient,origin});
  if(await hashResultToken(token)!==job.token_hash)throw new Error('token_mismatch');
  const result=await reissueSong({backend,restoreClient,songId:job.song_id,tokenHash:job.token_hash,version:job.requested_version});
  if(result.result!=='ready')throw new Error('restore_failed');ready=true;
  if(mailer){
   const settings=await backend.configureSongEmail({songId:job.song_id,tokenHash:job.token_hash,recipient,sender:mailer.sender,origin,
    sealedToken:sealResultToken({token,key,songId:job.song_id,recipient,origin})});
   if(settings?.result!=='configured')throw new Error('notification_not_configured');
   const row=await backend.requestNotification(job.song_id);
   if(row)await deliverResultNotifications({backend:{...backend,notificationCandidates:async()=>['pending_setup','pending'].includes(row.status)?[{id:row.id}]:[]},mailer,configuration:{origin,key},limit:1});
  }
  const notificationStatus=(await backend.requestNotification(job.song_id))?.status??'pending_setup';
  await backend.finishQueuedRestore(job.id,job.claim_id,true);
  return {restoreId:job.id,songId:job.song_id,status:'ready',deliveryVersion:result.deliveryVersion,notificationStatus};
 }catch{
  try{await backend.finishQueuedRestore(job.id,job.claim_id,ready);}catch{}
  return {restoreId:job.id,songId:job.song_id,status:ready?'ready':'failed',notificationStatus:ready?'not_confirmed':undefined};
 }
}
