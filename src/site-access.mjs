const accessEncoder=new TextEncoder();
const accessCookie='__Host-nosayeon_session';
const accessB64=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const accessDecode=value=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),char=>char.charCodeAt(0));
async function accessDigest(value){return new Uint8Array(await crypto.subtle.digest('SHA-256',accessEncoder.encode(value)));}
async function accessKey(secret){if(!/^[A-Za-z0-9_-]{43}$/.test(secret??''))throw new Error('access_not_configured');return crypto.subtle.importKey('raw',accessDecode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
async function sessionMessage(payload,password,origin){return accessEncoder.encode(`nosayeon-access-v1|${origin}|${accessB64(await accessDigest(password))}|${payload}`);}
export async function passwordMatches(input,password){
 if(typeof input!=='string'||input.length>128||typeof password!=='string'||!password)return false;
 const a=await accessDigest(input),b=await accessDigest(password);let difference=0;for(let i=0;i<a.length;i++)difference|=a[i]^b[i];return difference===0;
}
export async function issueAccessCookie({password,secret,origin,now=Date.now()}){
 const payload=accessB64(accessEncoder.encode(JSON.stringify({v:1,exp:Math.floor(now/1000)+8*3600,nonce:accessB64(crypto.getRandomValues(new Uint8Array(16)))})));
 const signature=accessB64(new Uint8Array(await crypto.subtle.sign('HMAC',await accessKey(secret),await sessionMessage(payload,password,origin))));
 return `${accessCookie}=${payload}.${signature}; Path=/; Max-Age=28800; Secure; HttpOnly; SameSite=Lax`;
}
export async function hasAccessSession(request,{password,secret,origin,now=Date.now()}){
 try{
  if(!password)return false;
  const cookie=(request.headers.get('Cookie')??'').split(';').map(item=>item.trim()).find(item=>item.startsWith(accessCookie+'='))?.slice(accessCookie.length+1);
  if(!cookie||cookie.length>512)return false;const [payload,signature,...extra]=cookie.split('.');if(extra.length||!payload||!signature)return false;
  const data=JSON.parse(new TextDecoder().decode(accessDecode(payload)));
  if(data.v!==1||!Number.isInteger(data.exp)||data.exp<=now/1000||data.exp>now/1000+8*3600||typeof data.nonce!=='string')return false;
  return await crypto.subtle.verify('HMAC',await accessKey(secret),accessDecode(signature),await sessionMessage(payload,password,origin));
 }catch{return false;}
}
export async function loginClientHash(request,secret){
 const address=request.headers.get('CF-Connecting-IP')||'unavailable';
 return [...new Uint8Array(await crypto.subtle.sign('HMAC',await accessKey(secret),accessEncoder.encode('login-attempt|'+address)))].map(value=>value.toString(16).padStart(2,'0')).join('');
}
