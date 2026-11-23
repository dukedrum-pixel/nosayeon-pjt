export function createOperationsSite({assets,origin,edgeBase,fetchImpl=fetch}){
 const security={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"};
 const json=(v,s=200)=>Response.json(v,{status:s,headers:security});
 return {async fetch(request,env={}){
  const url=new URL(request.url);if(url.origin!==origin)return json({error:'forbidden'},403);
  // Hosting access MUST remain owner-private. Platform identity is Site-scoped.
  const service=env.ADMIN_INGRESS_KEY&&request.headers.get('x-admin-service-key')===env.ADMIN_INGRESS_KEY;
  if(!request.headers.get('oai-authenticated-user-id')&&!service)return json({error:'unauthorized'},401);
  if(request.method!=='GET'&&request.method!=='HEAD')return json({error:'method_not_allowed'},405);
  if(url.pathname.startsWith('/api/admin/')){
   if(request.headers.get('Origin')&&request.headers.get('Origin')!==origin)return json({error:'forbidden'},403);
   if(!env.ADMIN_INGRESS_KEY)return json({error:'not_configured'},503);
   const target=url.pathname==='/api/admin/dashboard'?'/operations/dashboard':url.pathname==='/api/admin/request'?'/operations/request':null;
   if(!target)return json({error:'not_found'},404);
   try{
    const r=await fetchImpl(edgeBase+target+url.search,{headers:{'x-admin-secret':env.ADMIN_INGRESS_KEY},redirect:'manual',signal:AbortSignal.timeout(20000)});
    if(r.status>=300&&r.status<400){await r.body?.cancel();throw new Error();}
    return new Response(r.body,{status:r.status,headers:{...security,'Content-Type':'application/json; charset=utf-8'}});
   }catch{return json({error:'unavailable'},503);}
  }
  const asset=assets[url.pathname];if(!asset)return json({error:'not_found'},404);
  return new Response(request.method==='HEAD'?null:asset.body,{headers:{...security,'Content-Type':asset.mime}});
 }};
}
