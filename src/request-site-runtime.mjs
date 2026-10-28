import {hasAccessSession,issueAccessCookie,passwordMatches,loginClientHash} from './site-access.mjs';
import {validEmail} from './email-address.mjs';
const encoder=new TextEncoder();
const b64=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const unb64=value=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');
async function cryptKey(value){if(!/^[A-Za-z0-9_-]{43}$/.test(value??''))throw new Error();return crypto.subtle.importKey('raw',unb64(value),'AES-GCM',false,['encrypt','decrypt']);}
const aad=(id,origin,recipient)=>encoder.encode(JSON.stringify(['nosayeon-result-token-v1',id,recipient,origin]));
export async function sealRequestToken(token,id,key,origin,recipient='dukedrum@gmail.com'){const iv=crypto.getRandomValues(new Uint8Array(12));const data=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(id,origin,recipient)},await cryptKey(key),encoder.encode(token)));return ['v1',b64(iv),b64(data.slice(-16)),b64(data.slice(0,-16))].join('.');}
export async function openRequestToken(sealed,id,key,origin,recipient='dukedrum@gmail.com'){
 if(!/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{58}$/.test(sealed??''))throw new Error();
 const [,iv,tag,body]=sealed.split('.'),content=unb64(body),auth=unb64(tag),data=new Uint8Array(content.length+auth.length);data.set(content);data.set(auth,content.length);
 const token=new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(iv),additionalData:aad(id,origin,recipient)},await cryptKey(key),data));
 if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new Error();return token;
}
export function createRequestSite({assets,origin,edgeBase,fetchImpl=fetch}){
 const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
 'Content-Security-Policy':"default-src 'self'; connect-src 'self' https://fuvgpqkyhuyanbfavwcg.supabase.co; media-src blob:; object-src 'none'; base-uri 'none'; form-action 'none'"};
 const json=(body,status=200)=>Response.json(body,{status,headers});
 return {async fetch(request,env={},ctx={}){
  const url=new URL(request.url);
  if(url.origin!==origin)return json({error:'forbidden'},403);
  const service=env.REQUEST_INGRESS_KEY&&request.headers.get('x-request-service-key')===env.REQUEST_INGRESS_KEY;
  const publicAsset=['/access.css','/js/access-page.mjs'].includes(url.pathname);
  if(publicAsset&&['GET','HEAD'].includes(request.method)){
   const asset=assets[url.pathname];return asset?new Response(request.method==='HEAD'?null:asset.body,{headers:{...headers,'Content-Type':asset.mime}}):json({error:'not_found'},404);
  }
  const session=await hasAccessSession(request,{password:env.SITE_PASSWORD,secret:env.SITE_SESSION_KEY,origin});
  const access=session||service;
  if(!access&&url.pathname!=='/api/session/login'){
   if(url.pathname.startsWith('/api/')||!['GET','HEAD'].includes(request.method))return json({error:'unauthorized'},401);
   const page=assets['/access.html'];return page?new Response(request.method==='HEAD'?null:page.body,{headers:{...headers,'Content-Type':page.mime}}):json({error:'not_configured'},503);
  }
  if(!url.pathname.startsWith('/api/')){
   const asset=assets[url.pathname];if(!asset||!['GET','HEAD'].includes(request.method))return json({error:'not_found'},404);
   return new Response(request.method==='HEAD'?null:asset.body,{headers:{...headers,'Content-Type':asset.mime}});
  }
  if(request.headers.get('Origin')&&request.headers.get('Origin')!==origin)return json({error:'forbidden'},403);
  if(!env.REQUEST_INGRESS_KEY||!env.REQUEST_ENCRYPTION_KEY){console.warn('request_health_configuration',JSON.stringify({ingressBound:Boolean(env.REQUEST_INGRESS_KEY),encryptionBound:Boolean(env.REQUEST_ENCRYPTION_KEY),envKeys:Object.keys(env),contextKeys:Object.keys(ctx),propertyKeys:Object.keys(ctx.props??{})}));return json({error:'not_configured'},503);}
  async function edge(path,init={}){
   // Workers supports follow/manual. Reject redirects explicitly to keep the secret on its intended host.
   const response=await fetchImpl(`${edgeBase}${path}`,{...init,redirect:'manual',headers:{'x-request-secret':env.REQUEST_INGRESS_KEY,...init.headers},signal:AbortSignal.timeout(30000)});
   if(response.status>=300&&response.status<400){await response.body?.cancel();throw new Error('upstream_redirect_rejected');}
   return response;
  }
  async function safeState(row){
   const state={id:row.id,status:row.status,errorCode:row.errorCode};
   if(uuid(row.songId)){
    const token=await openRequestToken(row.sealedToken,row.id,env.REQUEST_ENCRYPTION_KEY,origin,row.recipient);
    const link=new URL('/result.html',origin);link.searchParams.set('id',row.songId);link.hash=new URLSearchParams({token}).toString();state.resultUrl=link.href;
   }
   return state;
  }
  if(url.pathname==='/api/session/login'){
   if(request.method!=='POST')return json({error:'not_found'},404);
   if(request.headers.get('Origin')!==origin)return json({error:'forbidden'},403);
   if(!env.SITE_PASSWORD||!env.SITE_SESSION_KEY)return json({error:'not_configured'},503);
   try{
    let size=0,chunks=[];for await(const chunk of request.body??[]){size+=chunk.length;if(size>1024)return json({error:'invalid_request'},413);chunks.push(chunk);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    let body;try{body=JSON.parse(new TextDecoder().decode(bytes));}catch{return json({error:'invalid_request'},400);}
    const correct=await passwordMatches(body.password,env.SITE_PASSWORD);
    const response=await edge('/intake/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientHash:await loginClientHash(request,env.SITE_SESSION_KEY),success:correct})});
    if(!response.ok)return json({error:'unavailable'},503);const rate=await response.json();
    if(rate.blocked)return json({error:'try_later'},429);
    if(!correct||!rate.allowed)return json({error:'invalid_password'},401);
    return Response.json({status:'authenticated'},{headers:{...headers,'Set-Cookie':await issueAccessCookie({password:env.SITE_PASSWORD,secret:env.SITE_SESSION_KEY,origin})}});
   }catch{return json({error:'unavailable'},503);}
  }
  if(['/api/result','/api/audio','/api/download','/api/restore'].includes(url.pathname)){
   const allowedMethod=['/api/download','/api/restore'].includes(url.pathname)?'POST':'GET';
   if(request.method!==allowedMethod)return json({status:'error'},405);
   if(request.method==='POST'&&request.headers.get('Origin')!==origin)return json({status:'forbidden'},403);
   try{
    const forward={Authorization:request.headers.get('Authorization')??''};
    if(url.pathname==='/api/restore'){
     const token=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(forward.Authorization)?.[1],songId=url.searchParams.get('id');
     if(!token||!uuid(songId))return json({status:'invalid_link'},401);
     forward['x-restore-sealed-token']=await sealRequestToken(token,songId,env.REQUEST_ENCRYPTION_KEY,origin);
    }
    const response=await edge(url.pathname+url.search,{method:request.method,headers:forward});
    const responseHeaders=new Headers(response.headers);for(const [name,value] of Object.entries(headers))responseHeaders.set(name,value);
    responseHeaders.delete('Access-Control-Allow-Origin');responseHeaders.delete('Set-Cookie');
    return new Response(response.body,{status:response.status,headers:responseHeaders});
   }catch{return json({status:'error'},503);}
  }
  let failurePhase='request';
  try{
   if(url.pathname==='/api/request/health'&&request.method==='GET'){
    failurePhase='health_fetch';const r=await edge('/intake/health');if(!r.ok){console.warn('request_health_upstream_status',r.status);return json({error:'upstream_unavailable'},503);}failurePhase='health_decode';const state=await r.json();failurePhase='health_format';return json({enabled:state.enabled===true,workerReady:state.workerReady===true});
   }
   if(url.pathname==='/api/request/status'&&request.method==='GET'){
    const id=url.searchParams.get('id');if(!uuid(id))return json({error:'invalid_request'},400);
    const r=await edge(`/intake/status?id=${id}`);if(!r.ok)return json({error:r.status===404?'not_found':'unavailable'},r.status===404?404:503);
    return json(await safeState(await r.json()));
   }
   if(url.pathname!=='/api/request/submit'||request.method!=='POST')return json({error:'not_found'},404);
   if(request.headers.get('Origin')!==origin)return json({error:'forbidden'},403);
   let length=0,chunks=[];for await(const chunk of request.body??[]){length+=chunk.length;if(length>24000)return json({error:'invalid_request'},413);chunks.push(chunk);}
   const bytes=new Uint8Array(length);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
   const body=JSON.parse(new TextDecoder().decode(bytes));const recipient=typeof body.recipient==='string'?body.recipient.trim():'';if(!validEmail(recipient))return json({error:'invalid_recipient'},400);if(!uuid(body.id)||typeof body.story!=='string'||!body.story.trim()||body.story.length>5000)return json({error:'invalid_request'},400);
   const previous=await edge(`/intake/status?id=${body.id}`);
   if(previous.ok)return json(await safeState(await previous.json()));
   if(previous.status!==404)throw new Error();
   const token=b64(crypto.getRandomValues(new Uint8Array(32)));
   const payload={recipient,id:body.id,story:body.story,options:body.options,tokenHash:await hash(token),sealedToken:await sealRequestToken(token,body.id,env.REQUEST_ENCRYPTION_KEY,origin,recipient)};
   const r=await edge('/intake/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
   const state=await r.json();if(!r.ok)return json({error:state.result||state.error||'unavailable'},r.status);
   return json({id:body.id,status:state.status});
  }catch(error){console.warn('request_api_connection_failed',JSON.stringify({route:url.pathname,phase:failurePhase,type:error?.name}));return json({error:'unavailable'},503);}
 }};
}
