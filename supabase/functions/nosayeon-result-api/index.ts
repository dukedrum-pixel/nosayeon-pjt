import { createStorageBackend } from '../../../src/supabase-storage.mjs';
import { createHostedResultApi } from '../../../src/hosted-result-api.mjs';
import {sha256} from '../../../src/storage-import.mjs';
import { handleRequestIntake } from '../../../src/request-intake.mjs';
const origin='https://nosayeon-result-check.cw-lee.chatgpt.site';
const backend=createStorageBackend({url:Deno.env.get('SUPABASE_URL'),serviceRoleKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')});
const handle=createHostedResultApi({backend,origin,queueRestores:true,waitUntil:promise=>EdgeRuntime.waitUntil(promise)});
Deno.serve(async request=>{
 try{
  const path=new URL(request.url).pathname.replace(/^.*\/nosayeon-result-api(?=\/|$)/,'');
  if(path.startsWith('/intake/'))return await handleRequestIntake(request,backend,path);
  if(path.startsWith('/api/')){const secret=request.headers.get('x-request-secret');if(!/^[A-Za-z0-9_-]{43}$/.test(secret??'')||!await backend.requestReadiness(await sha256(new TextEncoder().encode(secret))))return Response.json({status:'invalid_link'},{status:401,headers:{'Cache-Control':'no-store'}});}
  return await handle(request);
 }catch{return Response.json({status:'error'},{status:503,headers:{'Cache-Control':'no-store'}});}
});
