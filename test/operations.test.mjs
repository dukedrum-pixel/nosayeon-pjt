import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {PGlite} from '@electric-sql/pglite';
import {handleOperations} from '../src/operations-api.mjs';import {createOperationsSite} from '../src/operations-site.mjs';
const origin='https://admin.example.com',key='a'.repeat(43);
test('admin Site is identity protected and server-only key never follows redirects or accepts customer sessions',async()=>{
 let redirect=false,calls=0;const app=createOperationsSite({origin,edgeBase:'https://edge.example.com',assets:{'/':{body:'private dashboard',mime:'text/html'}},fetchImpl:async(url,init)=>{calls++;assert.equal(init.redirect,'manual');assert.equal(init.headers['x-admin-secret'],key);return redirect?new Response(null,{status:302,headers:{Location:'https://evil.example.com'}}):Response.json({observedAt:'test'});}});
 const request=(path,headers={})=>new Request(origin+path,{headers});const env={ADMIN_INGRESS_KEY:key};
 assert.equal((await app.fetch(request('/'),env)).status,401);assert.equal((await app.fetch(request('/api/admin/dashboard',{Cookie:'__Host-nosayeon_session=customer'}),env)).status,401);assert.equal(calls,0);
 assert.equal((await app.fetch(request('/',{'oai-authenticated-user-id':'private-site-owner'}),env)).status,200);
 const h={'x-admin-service-key':key};assert.equal((await app.fetch(request('/api/admin/dashboard',h),env)).status,200);redirect=true;assert.equal((await app.fetch(request('/api/admin/dashboard',h),env)).status,503);assert.equal(calls,2);
 assert.equal((await app.fetch(request('/api/admin/dashboard',{...h,Origin:'https://evil.example.com'}),env)).status,403);
});
test('admin Edge requires independent secret and supports read-only routes',async()=>{
 let calls=0;const backend={operationsDashboard:async h=>{calls++;assert.match(h,/^[a-f0-9]{64}$/);return {requests:[]};}};
 assert.equal((await handleOperations(new Request('https://edge/operations/dashboard'),backend,'/operations/dashboard')).status,401);assert.equal(calls,0);
 const headers={'x-admin-secret':key};assert.equal((await handleOperations(new Request('https://edge/operations/dashboard',{headers}),backend,'/operations/dashboard')).status,200);
 assert.equal((await handleOperations(new Request('https://edge/operations/dashboard',{headers,method:'POST'}),backend,'/operations/dashboard')).status,405);assert.equal(calls,1);
});
test('operations SQL is service-only, masks list email, excludes secrets, records safe diagnostic codes and retains failed request state',async()=>{
 const db=new PGlite();try{
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,metadata jsonb);grant usage on schema storage to service_role;grant select on storage.objects to service_role;');
  for(const name of ['20261026143658_private_audio_storage','20261026154303_result_link_access','20261026200705_single_download_cleanup','20261026203923_expired_audio_cleanup','20261026220530_stable_page_reissue','20261026230353_admin_dashboard','20261027154624_result_email_notifications','20261027224532_song_request_pipeline','20261027233531_password_access_and_restore_queue','20261028034241_request_recipient_email','20261028035241_request_limit_50','20261029071410_sequential_request_queue_eta','20261123041000_operations_dashboard'])await db.exec(await readFile(new URL(`../supabase/migrations/${name}.sql`,import.meta.url),'utf8'));
  const rpc=async(name,args=[])=>(await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) v`,args)).rows[0].v;
  const hash='b'.repeat(64),id=crypto.randomUUID(),sealed='v1.'+'a'.repeat(16)+'.'+'b'.repeat(22)+'.'+'c'.repeat(58);
  await db.query('insert into operations_access(id,secret_hash) values(true,$1)',[hash]);await db.query('insert into song_request_runtime(id,ingress_hash,enabled,worker_seen_at) values(true,$1,true,clock_timestamp())',['c'.repeat(64)]);
  await db.query("insert into song_requests(id,prompt,token_hash,sealed_token,recipient,status) values($1,'PRIVATE_STORY',$2,$3,'private@example.com','failed')",[id,'d'.repeat(64),sealed]);
  assert.equal(await rpc('operations_dashboard',['0'.repeat(64)]),null);
  const data=await rpc('operations_dashboard',[hash]);assert.equal(data.summary.total,1);assert.equal(data.summary.errors,1);assert.equal(data.runtime.workerReady,true);assert.equal(data.requests[0].recipient,'pr***@example.com');assert.doesNotMatch(JSON.stringify(data),/PRIVATE_STORY|private@example.com|sealed_token|token_hash|secret_hash/);
  await db.query("update song_request_runtime set worker_seen_at=clock_timestamp()-interval '2 minutes'");
  const offline=await rpc('operations_dashboard',[hash]);assert.equal(offline.runtime.workerReady,false);assert.equal(offline.summary.total,1);
  const detail=await rpc('operations_request_detail',[hash,id]);assert.equal(detail.prompt,'PRIVATE_STORY');assert.equal(detail.recipient,'private@example.com');assert.doesNotMatch(JSON.stringify(detail),/sealed_token|token_hash/);
  await rpc('record_song_worker_event',['request_failed','audio_validation','processing_failed',id,null]);const changed=await rpc('operations_request_detail',[hash,id]);assert.equal(changed.status,'failed');assert.equal(changed.errorCode,'audio_validation_processing_failed');
  for(const role of ['anon','authenticated'])assert.equal((await db.query("select has_function_privilege($1,'public.operations_dashboard(text)','EXECUTE') allowed",[role])).rows[0].allowed,false);
 }finally{await db.close();}
});
