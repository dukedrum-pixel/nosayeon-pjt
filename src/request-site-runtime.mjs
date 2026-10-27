const encoder=new TextEncoder();
const b64=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const unb64=value=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');
async function cryptKey(value){if(!/^[A-Za-z0-9_-]{43}$/.test(value??''))throw new Error();return crypto.subtle.importKey('raw',unb64(value),'AES-GCM',false,['encrypt','decrypt']);}
const aad=(id,origin)=>encoder.encode(JSON.stringify(['nosayeon-result-token-v1',id,'dukedrum@gmail.com',origin]));
export async function sealRequestToken(token,id,key,origin){const iv=crypto.getRandomValues(new Uint8Array(12));const data=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(id,origin)},await cryptKey(key),encoder.encode(token)));return ['v1',b64(iv),b64(data.slice(-16)),b64(data.slice(0,-16))].join('.');}
export async function openRequestToken(sealed,id,key,origin){
 if(!/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{58}$/.test(sealed??''))throw new Error();
 const [,iv,tag,body]=sealed.split('.'),content=unb64(body),auth=unb64(tag),data=new Uint8Array(content.length+auth.length);data.set(content);data.set(auth,content.length);
 const token=new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(iv),additionalData:aad(id,origin)},await cryptKey(key),data));
 if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new Error();return token;
}
export function createRequestSite({assets,origin,edgeBase,fetchImpl=fetch}){
 const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
 'Content-Security-Policy':"default-src 'self'; connect-src 'self' https://fuvgpqkyhuyanbfavwcg.supabase.co; media-src blob:; object-src 'none'; base-uri 'none'; form-action 'none'"};
 const json=(body,status=200)=>Response.json(body,{status,headers});
 return {async fetch(request,env={},ctx={}){
  const url=new URL(request.url);
  if(url.origin!==origin)return json({error:'forbidden'},403);
  if(!url.pathname.startsWith('/api/request/')){
   const asset=assets[url.pathname];if(!asset||!['GET','HEAD'].includes(request.method))return json({error:'not_found'},404);
   return new Response(request.method==='HEAD'?null:asset.body,{headers:{...headers,'Content-Type':asset.mime}});
  }
  const visitor=request.headers.get('oai-authenticated-user-id');
  const service=!visitor&&env.REQUEST_INGRESS_KEY&&request.headers.get('x-request-service-key')===env.REQUEST_INGRESS_KEY;
  // Dispatch enforces the owner-private Site audience. Its user ID is pairwise, not an account ID.
  const signedVisitor=typeof visitor==='string'&&visitor.length>0&&visitor.length<=256;
  if(!signedVisitor&&!service)return json({error:'unauthorized'},401);
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
    const token=await openRequestToken(row.sealedToken,row.id,env.REQUEST_ENCRYPTION_KEY,origin);
    const link=new URL('/result.html',origin);link.searchParams.set('id',row.songId);link.hash=new URLSearchParams({token}).toString();state.resultUrl=link.href;
   }
   return state;
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
   const body=JSON.parse(new TextDecoder().decode(bytes));if(!uuid(body.id)||typeof body.story!=='string'||!body.story.trim()||body.story.length>5000)return json({error:'invalid_request'},400);
   const previous=await edge(`/intake/status?id=${body.id}`);
   if(previous.ok)return json(await safeState(await previous.json()));
   if(previous.status!==404)throw new Error();
   const token=b64(crypto.getRandomValues(new Uint8Array(32)));
   const payload={id:body.id,story:body.story,options:body.options,tokenHash:await hash(token),sealedToken:await sealRequestToken(token,body.id,env.REQUEST_ENCRYPTION_KEY,origin)};
   const r=await edge('/intake/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
   const state=await r.json();if(!r.ok)return json({error:state.result||state.error||'unavailable'},r.status);
   return json({id:body.id,status:state.status});
  }catch(error){console.warn('request_api_connection_failed',JSON.stringify({route:url.pathname,phase:failurePhase,type:error?.name}));return json({error:'unavailable'},503);}
 }};
}
