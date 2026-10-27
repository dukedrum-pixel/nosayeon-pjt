import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {sealResultToken,openResultToken} from '../src/notification-secret.mjs';
import {sealRequestToken,openRequestToken,createRequestSite} from '../src/request-site-runtime.mjs';
import {hashResultToken} from '../src/identifiers.mjs';
import {sha256} from '../src/storage-import.mjs';
import {processSongRequest} from '../src/song-request-worker.mjs';
const origin='https://nosayeon-result-check.cw-lee.chatgpt.site',id='11111111-1111-4111-8111-111111111111',key=Buffer.alloc(32,9).toString('base64url'),token='a'.repeat(43),recipient='dukedrum@gmail.com';
test('Site WebCrypto and cloud worker share authenticated encryption without persisting raw page token',async()=>{
 const sealed=await sealRequestToken(token,id,key,origin);assert.equal(openResultToken({sealedToken:sealed,key,songId:id,recipient,origin}),token);
 const node=sealResultToken({token,key,songId:id,recipient,origin});assert.equal(await openRequestToken(node,id,key,origin),token);
 await assert.rejects(openRequestToken(node,crypto.randomUUID(),key,origin));
});
test('request Site requires a platform-signed visitor, same-origin POST and fixed recipient; duplicate submission reads the same request',async()=>{
 let submissions=0;
 const handler=createRequestSite({origin,ownerId:'owner',edgeBase:'https://edge.example.com',assets:{},fetchImpl:async(url,init)=>{
  assert.equal(init.headers['x-request-secret'],'i'.repeat(43));
  if(url.includes('/health'))return Response.json({enabled:true,workerReady:true});
  if(url.includes('/status'))return submissions?Response.json({id,status:'generating'}):new Response(null,{status:404});
  submissions++;const body=JSON.parse(init.body);assert.equal(body.recipient,undefined);assert.equal(body.token,undefined);assert.ok(body.sealedToken);return Response.json({status:'accepted'});
 }});
 const env={REQUEST_INGRESS_KEY:'i'.repeat(43),REQUEST_ENCRYPTION_KEY:key};
 const submit=(extra={})=>new Request(origin+'/api/request/submit',{method:'POST',headers:{Origin:origin,'oai-authenticated-user-id':'owner',...extra},body:JSON.stringify({id,story:'고마운 친구에게',options:{}})});
 assert.equal((await handler.fetch(submit({'oai-authenticated-user-id':''}),env)).status,401);
 assert.equal((await handler.fetch(submit({Origin:'https://wrong.example.com'}),env)).status,403);
 assert.equal((await handler.fetch(submit(),env)).status,200);assert.equal((await handler.fetch(submit(),env)).status,200);assert.equal(submissions,1);
 const health=extra=>new Request(origin+'/api/request/health',{headers:extra});
 assert.equal((await handler.fetch(health({'oai-authenticated-user-id':'pairwise-site-visitor'}),env)).status,200);
 assert.equal((await handler.fetch(health({'x-request-service-key':'wrong'}),env)).status,401);
 assert.equal((await handler.fetch(health({'x-request-service-key':env.REQUEST_INGRESS_KEY}),env)).status,200);
});
test('one durable request creates once, verifies/stores audio, issues a new link and sends exactly one result mail',async()=>{
 let creates=0,sends=0,notification='pending_setup',savedConfig;
 const bytes=Buffer.from('original new test audio'),digest=await sha256(bytes),songId=crypto.randomUUID(),claim=crypto.randomUUID(),objects=new Map(),states=[];
 const path=`${songId}/original/1-${digest}.mp3`,hash=await hashResultToken(token);
 const backend={progressRequest:async(_,status)=>{states.push(status);return true;},register:async()=>({id:songId,storage_status:'pending'}),claim:async()=>({id:songId,storage_claim:claim}),
  files:async()=>[{file_index:1,mime_type:'audio/mpeg',byte_length:bytes.length,sha256:digest,bucket_id:'nosayeon-audio',storage_path:path}],download:async p=>objects.get(p)??null,upload:async(p,b)=>objects.set(p,b),finish:async()=>({id:songId,storage_status:'stored'}),
  issueResultLink:async(_,h)=>{assert.equal(h,hash);return {song_id:songId};},configureSongEmail:async c=>{savedConfig=c;return {result:'configured'};},requestNotification:async()=>({id,status:notification}),
  beginResultNotification:async()=>{notification='sending';return {result:'started',song_id:songId,operation_id:id,recipient,sender:'peter@humansyntax.kr',public_origin:origin,sealed_token:savedConfig.sealedToken,token_hash:hash,expires_at:new Date(Date.now()+86400000).toISOString(),event:'initial_ready'};},finishResultNotification:async(_,__,s)=>{notification=s;return true;}};
 const job={id,prompt:'new story',recipient,token_hash:hash,sealed_token:sealResultToken({token,key,songId:id,recipient,origin}),generation_reserved_at:new Date().toISOString()};
 const client={create:async()=>{creates++;return {id:'new-interaction',status:'completed',created:job.generation_reserved_at,steps:[{type:'model_output',content:[{type:'audio',mime_type:'audio/mpeg',data:bytes.toString('base64')}]}]};}};
 const result=await processSongRequest({job,backend,client,key,origin,mailer:{sender:'peter@humansyntax.kr',sendResultLink:async data=>{sends++;assert.equal(data.recipient,recipient);assert.equal(data.token,token);return {providerMessageId:'gmail123'};}}});
 assert.equal(result.status,'completed');assert.equal(creates,1);assert.equal(sends,1);assert.deepEqual(objects.get(path),bytes);assert.deepEqual(states,['generating','saving','notifying','completed']);
 let attempted=0;const unknown=await processSongRequest({job,backend:{progressRequest:async()=>true},client:{create:async()=>{attempted++;throw new Error('lost response');}},key,origin});assert.equal(unknown.status,'unknown');assert.equal(attempted,1);
});
test('request SQL is service-only, claim-once, idempotent and keeps offline/duplicate/limit cases from charging',async()=>{
 const db=new PGlite();try{
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create table public.songs(id uuid primary key);');
  await db.exec(await readFile(new URL('../supabase/migrations/20261027224532_song_request_pipeline.sql',import.meta.url),'utf8'));
  const rpc=async(n,args=[])=> (await db.query(`select public.${n}(${args.map((_,i)=>'$'+(i+1)).join(',')}) v`,args)).rows[0].v;
  const ingress='b'.repeat(64),sealed=sealResultToken({token,key,songId:id,recipient,origin}),hash=await hashResultToken(token),args=[id,'prompt',hash,sealed,ingress];
  await db.query('insert into public.song_request_runtime(id,ingress_hash,enabled) values(true,$1,true)',[ingress]);
  assert.equal((await rpc('submit_song_request',args)).result,'worker_unavailable');
  assert.equal(await rpc('touch_song_request_worker'),true);
  assert.equal((await rpc('submit_song_request',args)).result,'accepted');assert.equal((await rpc('submit_song_request',args)).result,'existing');
  assert.equal((await rpc('submit_song_request',[...args.slice(0,4),'c'.repeat(64)])).result,'unauthorized');
  assert.equal((await rpc('claim_song_request')).id,id);assert.equal(await rpc('claim_song_request'),null);
  assert.equal(await rpc('progress_song_request',[id,'unknown',null,null]),true);assert.equal(await rpc('claim_song_request'),null);
  assert.equal((await rpc('read_song_request',[id,ingress])).status,'unknown');
  for(const role of ['anon','authenticated']){assert.equal((await db.query("select has_table_privilege($1,'public.song_requests','SELECT') allowed",[role])).rows[0].allowed,false);}
 }finally{await db.close();}
});
