import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleRestoreClient,RestoreError } from '../src/lyria-restore.mjs';
import { sha256 } from '../src/storage-import.mjs';

const original=new TextEncoder().encode('original-audio');
const generatedAt='2026-10-26T14:06:27Z';
const baseline={interactionId:'existing/id?opaque',model:'lyria-3.5',generatedAt,
  files:[{index:1,mime:'audio/mpeg',byteLength:original.length,sha256:await sha256(original)}]};
const block={type:'audio',mime_type:'audio/mpeg',data:Buffer.from(original).toString('base64')};
const interaction=(blocks=[block])=>({id:baseline.interactionId,model:baseline.model,created:generatedAt,status:'completed',
  steps:[{type:'user_input',content:[{...block,data:'NOT_AUDIO'}]},{type:'model_output',content:blocks}]});

test('복구 클라이언트는 GET 조회만 제공하고 원본 ID·모델·시각·해시를 모두 검증한다',async()=>{
  const calls=[];
  const client=createGoogleRestoreClient({apiKey:'TEST_PRIVATE_KEY',fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json(interaction());}});
  assert.deepEqual(Object.keys(client),['retrieve']);
  const files=await client.retrieve(baseline);
  assert.deepEqual(files[0].bytes,original);assert.equal(files[0].sha256,baseline.files[0].sha256);
  assert.equal(calls.length,1);assert.equal(calls[0].options.method,'GET');
  assert.equal(calls[0].url.origin,'https://generativelanguage.googleapis.com');
  assert.ok(calls[0].url.pathname.endsWith('existing%2Fid%3Fopaque'));
  assert.equal(calls[0].options.body,undefined);assert.equal(calls[0].options.redirect,'error');
});

test('잘못된 비교 기준은 Google 요청 전에 거부한다',async()=>{
  let calls=0;const client=createGoogleRestoreClient({apiKey:'test-key',fetchImpl:async()=>{calls++;return Response.json(interaction());}});
  for(const value of [null,{...baseline,interactionId:'..'},{...baseline,generatedAt:'invalid'},
    {...baseline,files:[]},{...baseline,files:[{...baseline.files[0],sha256:'bad'}]},
    {...baseline,files:[{...baseline.files[0],byteLength:67108865}]}]){
    await assert.rejects(client.retrieve(value),e=>e.code==='invalid_baseline');
  }
  assert.equal(calls,0);
});

test('ID·모델·생성시각·완료 상태가 바뀌면 재생성이나 폴링 없이 중단한다',async()=>{
  for(const change of [{id:'other'},{model:'other'},{created:'2026-10-27T14:06:27Z'},{status:'in_progress'}]){
    let calls=0;const client=createGoogleRestoreClient({apiKey:'test-key',fetchImpl:async()=>{calls++;return Response.json({...interaction(),...change});}});
    await assert.rejects(client.retrieve(baseline),e=>e.code==='interaction_mismatch');assert.equal(calls,1);
  }
});

test('파일 수·MIME·크기·내용이 바뀌거나 Base64가 손상되면 일치 판정을 내리지 않는다',async()=>{
  for(const blocks of [[],[block,block],[{...block,mime_type:'audio/wav'}],
    [{...block,data:'%%%%'}],[{...block,data:Buffer.alloc(original.length).toString('base64')}],
    [{type:'audio',mime_type:'audio/mpeg'}]]){
    const client=createGoogleRestoreClient({apiKey:'test-key',fetchImpl:async()=>Response.json(interaction(blocks))});
    await assert.rejects(client.retrieve(baseline),e=>e instanceof RestoreError);
  }
});

test('URI는 허용 호스트에만 접속하며 Google Storage로 API 키를 전달하지 않는다',async()=>{
  const calls=[];
  const client=createGoogleRestoreClient({apiKey:'TEST_PRIVATE_KEY',fetchImpl:async(url,options)=>{
    calls.push({url,options});return calls.length===1?Response.json(interaction([{type:'audio',mime_type:'audio/mpeg',uri:'https://storage.googleapis.com/private/audio?signature=PRIVATE'}])):new Response(original);
  }});
  assert.deepEqual((await client.retrieve(baseline))[0].bytes,original);
  assert.equal(calls.length,2);assert.equal(calls[1].options.method,'GET');
  assert.equal(calls[1].options.headers['x-goog-api-key'],undefined);
  for(const uri of ['https://evil.example/audio','http://storage.googleapis.com/audio','https://user:pass@storage.googleapis.com/audio','https://storage.googleapis.com:8443/audio']){
    let count=0;const denied=createGoogleRestoreClient({apiKey:'test-key',fetchImpl:async()=>{count++;return Response.json(interaction([{type:'audio',mime_type:'audio/mpeg',uri}]));}});
    await assert.rejects(denied.retrieve(baseline),e=>e.code==='invalid_audio_uri');assert.equal(count,1);
  }
});

test('HTTP·네트워크·응답 오류에서 키·원문을 노출하거나 자동 재시도하지 않는다',async()=>{
  for(const mode of ['http','network','json','large']){
    let calls=0;
    const client=createGoogleRestoreClient({apiKey:'PRIVATE_SECRET',fetchImpl:async()=>{
      calls++;
      if(mode==='network')throw new Error('PRIVATE_SECRET response-body');
      if(mode==='http')return new Response('PRIVATE_SECRET response-body',{status:404});
      if(mode==='json')return new Response('PRIVATE_SECRET invalid json');
      return new Response('small',{headers:{'Content-Length':String(97*1024*1024)}});
    }});
    await assert.rejects(client.retrieve(baseline),e=>e instanceof RestoreError&&!/PRIVATE|response-body/.test(e.message));
    assert.equal(calls,1);
  }
});

test('실제 MP3와 비슷한 크기의 inline 응답을 전체 원본 해시로 검증한다',async()=>{
  const bytes=new Uint8Array(3021074).fill(31);
  const large={...baseline,files:[{...baseline.files[0],byteLength:bytes.length,sha256:await sha256(bytes)}]};
  const client=createGoogleRestoreClient({apiKey:'test-key',fetchImpl:async()=>Response.json(interaction([{...block,data:Buffer.from(bytes).toString('base64')}]))});
  const restored=await client.retrieve(large);assert.deepEqual(restored[0].bytes,bytes);
});
