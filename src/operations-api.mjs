import {sha256} from './storage-import.mjs';
export async function handleOperations(request,backend,path){
 const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
 const json=(v,s=200)=>Response.json(v,{status:s,headers});
 const key=request.headers.get('x-admin-secret');
 if(!/^[A-Za-z0-9_-]{43}$/.test(key??''))return json({error:'unauthorized'},401);
 if(request.method!=='GET')return json({error:'method_not_allowed'},405);
 const hash=await sha256(new TextEncoder().encode(key));
 if(path==='/operations/dashboard'){const result=await backend.operationsDashboard(hash);return result?json(result):json({error:'unauthorized'},401);}
 if(path==='/operations/request'){
  const id=new URL(request.url).searchParams.get('id');if(!/^[a-f0-9-]{36}$/.test(id??''))return json({error:'invalid_request'},400);
  // The dashboard RPC verifies the key even for unknown request IDs.
  if(!await backend.operationsDashboard(hash))return json({error:'unauthorized'},401);
  const result=await backend.operationsDetail(hash,id);return result?json(result):json({error:'not_found'},404);
 }
 return json({error:'not_found'},404);
}
