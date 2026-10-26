import { validateAudioFiles,readVerifiedAudio } from './audio-files.mjs';
import { cleanupResultSong } from './result-cleanup.mjs';
import { RestoreError } from './lyria-restore.mjs';
import { sha256 } from './storage-import.mjs';

export async function reissueSong({backend,restoreClient,songId,tokenHash,version}){
  if(!restoreClient?.retrieve)return {result:'unavailable'};
  let job=await backend.beginRestore(songId,tokenHash,version);
  if(job?.result==='cleanup_required'){
    const cleanup=await cleanupResultSong({backend,songId});
    if(cleanup.result!=='deleted')return {result:'busy'};
    job=await backend.beginRestore(songId,tokenHash,version);
  }
  if(job?.result!=='started')return {result:['busy','stale','retention_ended','invalid_link'].includes(job?.result)?job.result:'unavailable'};
  const claim=job.claim;
  try{
    const source=validateAudioFiles(job.source_files,songId),target=validateAudioFiles(job.target_files,songId);
    if(!claim||target[0].delivery_version!==job.delivery_version)throw new Error('invalid_job');
    const lease=async()=>{if(await backend.restoreLease(songId,claim)!==true)throw new Error('lease_lost');};
    await lease();
    // Retire all previous bytes before asking Google for the existing result.
    await backend.remove(source.map(f=>f.storage_path));
    for(const file of source)if(await backend.objectExists(file.storage_path))throw new Error('delete_unconfirmed');
    await lease();
    const recovered=await restoreClient.retrieve({interactionId:job.interaction_id,model:job.model,generatedAt:job.generated_at,
      files:target.map(f=>({index:f.file_index,mime:f.mime_type,byteLength:f.byte_length,sha256:f.sha256}))});
    if(recovered.length!==target.length)throw new Error('content_mismatch');
    for(const [index,file] of target.entries())if(!(recovered[index]?.bytes instanceof Uint8Array)
      ||recovered[index].bytes.length!==file.byte_length||await sha256(recovered[index].bytes)!==file.sha256)throw new Error('content_mismatch');
    for(const [index,file] of target.entries()){
      await lease();
      let existing=await backend.download(file.storage_path,{fresh:true});
      if(existing===null)await backend.upload(file.storage_path,recovered[index].bytes,file.mime_type);
      // Verify the actual stored bytes against the immutable metadata.
      await readVerifiedAudio({download:path=>backend.download(path,{fresh:true})},file);
    }
    if(await backend.finishRestore(songId,claim)!==true)throw new Error('lease_lost');
    return {result:'ready',deliveryVersion:job.delivery_version,notificationStatus:'pending_setup'};
  }catch(error){
    const code=error instanceof RestoreError&&['content_mismatch','http_error','network_error'].includes(error.code)?error.code:'restore_failed';
    try{await backend.failRestore(songId,claim,code);}catch{}
    return {result:'failed'};
  }
}
