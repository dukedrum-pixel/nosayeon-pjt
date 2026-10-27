import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {hasAccessSession,issueAccessCookie,passwordMatches} from '../src/site-access.mjs';
import {createRequestSite} from '../src/request-site-runtime.mjs';
import {hashResultToken} from '../src/identifiers.mjs';
import {sealResultToken} from '../src/notification-secret.mjs';
import {sha256} from '../src/storage-import.mjs';
import {processQueuedRestore} from '../src/queued-song-restore.mjs';
const origin='https://nosayeon-result-check.cw-lee.chatgpt.site',key=Buffer.alloc(32,11).toString('base64url'),password='fixture-password';
test('password session is signed, expiring, HTTP-only and invalidated by password/key/origin changes',async()=>{
 assert.equal(await passwordMatches('wrong',password),false);assert.equal(await passwordMatches(password,password),true);
 const issued=await issueAccessCookie({password,secret:key,origin});assert.match(issued,/Secure; HttpOnly; SameSite=Lax/);
 const request=new Request(origin,{headers:{Cookie:issued.split(';')[0]}});
 assert.equal(await hasAccessSession(request,{password,secret:key,origin}),true);
 for(const changed of [{password:'changed'},{secret:Buffer.alloc(32,12).toString('base64url')},{origin:'https://other.example.com'},{now:Date.now()+9*3600000}])assert.equal(await hasAccessSession(request,{password,secret:key,origin,...changed}),false);
 assert.doesNotMatch(issued,new RegExp(password));
});
test('anonymous visitors see the password gate; page/API protection cannot be bypassed with identity headers',async()=>{
 let calls=0;
 const app=createRequestSite({assets:{'/access.html':{body:'password gate',mime:'text/html'},'/result.html':{body:'private player',mime:'text/html'}},origin,edgeBase:'https://edge.example.com',fetchImpl:async(url,init)=>{
  calls++;assert.equal(init.redirect,'manual');if(url.endsWith('/intake/login')){const body=JSON.parse(init.body);assert.equal(body.password,undefined);return Response.json({allowed:body.success,blocked:false});}return Response.json({enabled:true,workerReady:true});
 }});
 const env={SITE_PASSWORD:password,SITE_SESSION_KEY:key,REQUEST_INGRESS_KEY:'i'.repeat(43),REQUEST_ENCRYPTION_KEY:key};
 const page=await app.fetch(new Request(origin+'/result.html?id=example'),env);assert.equal(await page.text(),'password gate');
 assert.equal((await app.fetch(new Request(origin+'/api/request/health',{headers:{'oai-authenticated-user-id':'forged'}}),env)).status,401);assert.equal(calls,0);
 const login=value=>new Request(origin+'/api/session/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({password:value})});
 assert.equal((await app.fetch(login('wrong'),env)).status,401);
 const good=await app.fetch(login(password),env);assert.equal(good.status,200);const cookie=good.headers.get('Set-Cookie').split(';')[0];
 assert.equal(await (await app.fetch(new Request(origin+'/result.html?id=example',{headers:{Cookie:cookie}}),env)).text(),'private player');
});
test('password attempts and queued restore run with service-only SQL; same audio returns with a new download version',async()=>{
 const db=new PGlite(),objects=new Map();
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
  for(const name of ['20261026143658_private_audio_storage','20261026154303_result_link_access','20261026200705_single_download_cleanup','20261026203923_expired_audio_cleanup','20261026220530_stable_page_reissue','20261027224532_song_request_pipeline','20261027233531_password_access_and_restore_queue'])await db.exec(await readFile(new URL(`../supabase/migrations/${name}.sql`,import.meta.url),'utf8'));
  const rpc=async(name,args=[])=>(await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) v`,args)).rows[0].v;
  const clientHash='c'.repeat(64);for(let i=0;i<5;i++)await rpc('check_site_login_attempt',[clientHash,false]);assert.equal((await rpc('check_site_login_attempt',[clientHash,true])).blocked,true);
  await db.query("update public.site_login_attempts set blocked_until=clock_timestamp()-interval '1 second' where client_hash=$1",[clientHash]);assert.equal((await rpc('check_site_login_attempt',[clientHash,true])).allowed,true);
  const id=crypto.randomUUID(),token='a'.repeat(43),tokenHash=await hashResultToken(token),bytes=new TextEncoder().encode('the same immutable music'),digest=await sha256(bytes);
  const original=`${id}/original/1-${digest}.mp3`;
  await db.query("insert into public.songs(id,google_interaction_id,generated_at,storage_status,stored_at) values($1,$2,clock_timestamp(),'stored',clock_timestamp())",[id,id]);
  await db.query("insert into public.song_files(song_id,file_index,mime_type,byte_length,sha256,storage_path) values($1,1,'audio/mpeg',$2,$3,$4)",[id,bytes.length,digest,original]);
  await rpc('issue_initial_result_link',[id,tokenHash]);await db.query('update public.song_result_links set consumed_at=clock_timestamp() where song_id=$1',[id]);
  await db.query("insert into public.song_request_runtime(id,ingress_hash,enabled,worker_seen_at) values(true,$1,true,clock_timestamp())",['b'.repeat(64)]);
  const sealed=sealResultToken({token,key,songId:id,recipient:'dukedrum@gmail.com',origin});
  assert.equal((await rpc('enqueue_song_restore',[id,'0'.repeat(64),0,sealed])).result,'invalid_link');
  assert.equal((await rpc('enqueue_song_restore',[id,tokenHash,0,sealed])).result,'queued');
  assert.equal((await rpc('enqueue_song_restore',[id,tokenHash,0,sealed])).result,'busy');
  assert.equal(await rpc('has_queued_song_restore',[id]),true);assert.equal(await rpc('claim_versioned_download',[id,tokenHash,0]),null);
  const job=await rpc('claim_queued_song_restore');assert.equal(await rpc('claim_queued_song_restore'),null);objects.set(original,bytes);
  const backend={beginRestore:(...a)=>rpc('begin_song_restore',a),restoreLease:(...a)=>rpc('check_song_restore',a),finishRestore:(...a)=>rpc('finish_song_restore',a),failRestore:(...a)=>rpc('fail_song_restore',a),
   remove:async paths=>{for(const p of paths)objects.delete(p);},objectExists:async p=>objects.has(p),download:async p=>objects.get(p)??null,upload:async(p,data)=>objects.set(p,data),finishQueuedRestore:(...a)=>rpc('finish_queued_song_restore',a),requestNotification:async()=>({status:'pending_setup'})};
  let retrievals=0;
  const result=await processQueuedRestore({job,backend,key,origin,restoreClient:{retrieve:async baseline=>{retrievals++;assert.equal(baseline.interactionId,id);assert.equal(objects.has(original),false);return [{bytes}];}}});
  assert.equal(result.status,'ready');assert.equal(retrievals,1);assert.equal(await rpc('has_queued_song_restore',[id]),false);
  const link=(await db.query('select delivery_version,consumed_at,token_hash from public.song_result_links where song_id=$1',[id])).rows[0];assert.deepEqual(link,{delivery_version:1,consumed_at:null,token_hash:tokenHash});
  const file=(await db.query('select storage_path,sha256 from public.song_files where song_id=$1',[id])).rows[0];assert.equal(file.sha256,digest);assert.deepEqual(objects.get(file.storage_path),bytes);
  assert.equal((await rpc('enqueue_song_restore',[id,tokenHash,0,sealed])).result,'stale');
  for(const role of ['anon','authenticated'])assert.equal((await db.query("select has_table_privilege($1,'public.song_restore_queue','SELECT') allowed",[role])).rows[0].allowed,false);
 }finally{await db.close();}
});
