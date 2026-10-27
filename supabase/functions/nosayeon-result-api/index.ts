import { createStorageBackend } from '../../../src/supabase-storage.mjs';
import { createHostedResultApi } from '../../../src/hosted-result-api.mjs';
import { handleRequestIntake } from '../../../src/request-intake.mjs';
const origin='https://nosayeon-result-check.cw-lee.chatgpt.site';
const backend=createStorageBackend({url:Deno.env.get('SUPABASE_URL'),serviceRoleKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')});
const handle=createHostedResultApi({backend,origin,waitUntil:promise=>EdgeRuntime.waitUntil(promise)});
Deno.serve(async request=>{
 try{
  const path=new URL(request.url).pathname.replace(/^.*\/nosayeon-result-api(?=\/|$)/,'');
  if(path.startsWith('/intake/'))return await handleRequestIntake(request,backend,path);
  return await handle(request);
 }catch{return Response.json({status:'error'},{status:503,headers:{'Cache-Control':'no-store'}});}
});
