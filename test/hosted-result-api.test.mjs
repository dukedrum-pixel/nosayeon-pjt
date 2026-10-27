import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostedResultApi } from '../src/hosted-result-api.mjs';
import { resultApiUrl } from '../web/js/result-api.mjs';
const origin='https://nosayeon-result-check.cw-lee.chatgpt.site';
const request=(path,init={})=>new Request(`https://edge.example.com/nosayeon-result-api${path}`,init);
test('hosted API restricts CORS/preflight, hides operational rows, and keeps token authentication',async()=>{
 let reads=0;
 const handler=createHostedResultApi({origin,backend:{notificationCandidates:async()=>{reads++;return [{secret:'PRIVATE'}];},resultLink:async()=>null}});
 assert.equal((await handler(request('/healthz'))).status,200);assert.equal(reads,1);
 assert.doesNotMatch(await (await handler(request('/healthz'))).text(),/PRIVATE/);
 assert.equal((await handler(request('/api/result',{headers:{Origin:'https://wrong.example.com'}}))).status,403);
 assert.equal((await handler(request('/api/admin/dashboard'))).status,404);
 const options=await handler(request('/api/result',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'authorization'}}));
 assert.equal(options.status,204);assert.equal(options.headers.get('Access-Control-Allow-Origin'),origin);
 assert.equal((await handler(request('/api/result',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'DELETE'}}))).status,403);
 assert.equal((await handler(request('/api/result?id=11111111-1111-4111-8111-111111111111',{headers:{Origin:origin}}))).status,401);
});
test('result API origin cannot be replaced by an untrusted destination',()=>{
 assert.equal(resultApiUrl('/api/result?id=x'),'/api/result?id=x');
 assert.throws(()=>resultApiUrl('/api/result?id=x','https://attacker.example.com'));
 assert.throws(()=>resultApiUrl('/api/admin/dashboard?x=1'));
});

test('hosted playback preserves download permission; download consumes once and schedules cleanup',async()=>{
 const { sha256 }=await import('../src/storage-import.mjs');
 const { hashResultToken }=await import('../src/identifiers.mjs');
 const id='11111111-1111-4111-8111-111111111111',token='a'.repeat(43),hash=await hashResultToken(token);
 const bytes=new TextEncoder().encode('existing-test-audio'),digest=await sha256(bytes);
 let consumed=false,claims=0,cleanup=0;
 const tasks=[];
 const metadata={file_index:1,mime_type:'audio/mpeg',byte_length:bytes.length,sha256:digest,bucket_id:'nosayeon-audio',storage_path:`${id}/original/1-${digest}.mp3`,delivery_version:0};
 const backend={
  resultLink:async(songId,provided)=>songId===id&&provided===hash?{song_id:id,issued_at:new Date(Date.now()-1000).toISOString(),expires_at:new Date(Math.floor(Date.now()/86400000)*86400000+2*86400000).toISOString(),delivery_version:0,page_issued:true,consumed_at:consumed?new Date().toISOString():null,songs:{generated_at:new Date(Date.now()-86400000).toISOString(),storage_status:'stored'}}:null,
  files:async()=>[metadata],download:async()=>bytes,
  claimDownloadVersion:async()=>{claims++;return 'claim';},consumeDownload:async()=>{consumed=true;return true;},
  claimCleanup:async()=>{cleanup++;return null;},
 };
 const handler=createHostedResultApi({origin,backend,waitUntil:promise=>tasks.push(promise)});
 const auth={Authorization:`Bearer ${token}`,Origin:origin};
 const view=await handler(request(`/api/result?id=${id}`,{headers:auth}));
 assert.equal(view.status,200);assert.equal((await view.json()).canRestore,false);
 const audio=await handler(request(`/api/audio?id=${id}&file=1&version=0`,{headers:auth}));
 assert.equal(audio.status,200);assert.deepEqual(new Uint8Array(await audio.arrayBuffer()),bytes);
 assert.equal(consumed,false);assert.equal(claims,0);
 const saved=await handler(request(`/api/download?id=${id}&version=0`,{method:'POST',headers:auth}));
 assert.equal(saved.status,200);assert.deepEqual(new Uint8Array(await saved.arrayBuffer()),bytes);
 assert.equal(consumed,true);assert.equal(claims,1);await Promise.all(tasks);assert.equal(cleanup,1);
 assert.equal((await handler(request(`/api/download?id=${id}&version=0`,{method:'POST',headers:auth}))).status,410);
 assert.equal(claims,1);
});
