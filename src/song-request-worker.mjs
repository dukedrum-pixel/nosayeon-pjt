import { hashResultToken } from './identifiers.mjs';
import { extractAudio } from './lyria-spike.mjs';
import { importGeneratedAudio } from './storage-import.mjs';
import { openResultToken, sealResultToken } from './notification-secret.mjs';
import { deliverResultNotifications } from './result-notifications.mjs';

export async function processSongRequest({job,backend,client,mailer,key,origin,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),maxPolls=120}){
 let interaction=null,attempted=false,stage='generating',songId=null;
 try{
  const token=openResultToken({sealedToken:job.sealed_token,key,songId:job.id,recipient:job.recipient,origin});
  if(await hashResultToken(token)!==job.token_hash)throw new Error('token_mismatch');
  attempted=true;
  let response=await client.create(job.prompt); // Exactly one creation POST per durable claim.
  if(typeof response.id!=='string'||!response.id)throw new Error('missing_interaction');
  interaction=response.id;
  if(!await backend.progressRequest(job.id,'generating',interaction))throw new Error('checkpoint_failed');
  for(let i=0;response.status==='in_progress';i++){
   if(i>=maxPolls)throw new Error('poll_timeout');
   await wait(5000);response=await client.get(interaction);
   if(response.id!==interaction)throw new Error('interaction_mismatch');
  }
  if(response.status!=='completed')throw new Error('generation_failed');
  const audio=await extractAudio(response,client);
  stage='saving';if(!await backend.progressRequest(job.id,stage,interaction))throw new Error('checkpoint_failed');
  const generatedAt=typeof response.created==='string'&&Number.isFinite(Date.parse(response.created))?response.created:job.generation_reserved_at;
  const stored=await importGeneratedAudio({backend,manifest:{interactionId:interaction,model:'lyria-3.5',generatedAt,files:audio.map((file,i)=>({...file,index:i+1}))}});
  if(!['stored','already_stored'].includes(stored.result))throw new Error('storage_failed');
  songId=stored.songId;
  const link=await backend.issueResultLink(songId,job.token_hash);
  if(link?.song_id!==songId)throw new Error('link_failed');
  stage='notifying';if(!await backend.progressRequest(job.id,stage,interaction,songId))throw new Error('checkpoint_failed');
  const configured=await backend.configureSongEmail({songId,tokenHash:job.token_hash,recipient:job.recipient,sender:mailer.sender,origin,
   sealedToken:sealResultToken({token,key,songId,recipient:job.recipient,origin})});
  if(configured?.result!=='configured')throw new Error('notification_configuration_failed');
  const row=await backend.requestNotification(songId);
  if(!row)throw new Error('notification_missing');
  await deliverResultNotifications({backend:{...backend,notificationCandidates:async()=>['pending_setup','pending'].includes(row.status)?[{id:row.id}]:[]},mailer,configuration:{origin,key},limit:1});
  const status=(await backend.requestNotification(songId))?.status;
  const state=status==='sent'?'completed':status==='failed'?'mail_failed':'mail_unknown';
  if(!await backend.progressRequest(job.id,state,interaction,songId))throw new Error('checkpoint_failed');
  return {requestId:job.id,status:state,songId};
 }catch(error){
  const state=stage==='notifying'?'mail_unknown':attempted&&!interaction?'unknown':'failed';
  try{await backend.progressRequest(job.id,state,interaction,songId);}catch{}
  const http=/HTTP (\d{3})/.exec(error?.message??'');
  return {requestId:job.id,status:state,songId,stage,errorCode:['http_error','network_error','content_mismatch','invalid_response','local_error'].includes(error?.code)?error.code:'processing_failed',providerHttpStatus:http?Number(http[1]):null};
 }
}
