import { sha256 } from './storage-import.mjs';
import { SONG_ID } from './identifiers.mjs';
import { buildPrompt } from '../web/js/prompt-builder.mjs';
export async function handleRequestIntake(request,backend,path){
 const secret=request.headers.get('x-request-secret');
 const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer'};
 const json=(value,status=200)=>Response.json(value,{status,headers});
 if(!/^[A-Za-z0-9_-]{43}$/.test(secret??''))return json({error:'unauthorized'},401);
 const ingressHash=await sha256(new TextEncoder().encode(secret));
 const readiness=await backend.requestReadiness(ingressHash);
 if(!readiness)return json({error:'unauthorized'},401);
 if(path==='/intake/health'&&request.method==='GET')return json(readiness);
 if(path==='/intake/login'&&request.method==='POST'){
  const text=await request.text();if(text.length>1024)return json({error:'invalid_request'},400);
  let input;try{input=JSON.parse(text);}catch{return json({error:'invalid_request'},400);}
  if(!/^[a-f0-9]{64}$/.test(input.clientHash??'')||typeof input.success!=='boolean')return json({error:'invalid_request'},400);
  return json(await backend.loginAttempt(input.clientHash,input.success));
 }
 if(path==='/intake/status'&&request.method==='GET'){
  const id=new URL(request.url).searchParams.get('id');if(!SONG_ID.test(id??''))return json({error:'invalid_request'},400);
  const state=await backend.readRequest(id,ingressHash);return state?json(state):json({error:'not_found'},404);
 }
 if(path!=='/intake/submit'||request.method!=='POST')return json({error:'not_found'},404);
 let length=0,chunks=[];
 for await(const chunk of request.body??[]){length+=chunk.length;if(length>24000)return json({error:'too_large'},413);chunks.push(chunk);}
 const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 let input,prompt;try{input=JSON.parse(new TextDecoder().decode(bytes));prompt=buildPrompt(input.story,input.options);}catch{return json({error:'invalid_request'},400);}
 if(!SONG_ID.test(input.id??'')||!(/^[a-f0-9]{64}$/).test(input.tokenHash??'')||!(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{58}$/).test(input.sealedToken??''))return json({error:'invalid_request'},400);
 const result=await backend.submitRequest(input.id,prompt,input.tokenHash,input.sealedToken,ingressHash);
 return json(result,['accepted','existing'].includes(result?.result)?200:result?.result==='unauthorized'?401:409);
}
