// Read-only network profile comparison. Never prints proxy addresses or environment values.
import {spawnSync} from 'node:child_process';
function docker(args){const env={...process.env};for(const k of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'])delete env[k];const r=spawnSync('docker',['--host=unix:///var/run/docker.sock',...args],{env,encoding:'utf8'});if(r.status!==0)throw new Error('Docker diagnostic failed; private details hidden.');return r.stdout;}
let probe;
try{
 const [old]=JSON.parse(docker(['inspect','nosayeon-request-worker']));
 probe=docker(['create','nosayeon-request-worker:current','node','-e','process.exit(0)']).trim();const [fresh]=JSON.parse(docker(['inspect',probe]));
 const env=c=>Object.fromEntries(c.Config.Env.map(v=>{const i=v.indexOf('=');return[v.slice(0,i),v.slice(i+1)];}));
 const endpoint=e=>{const v=e.HTTPS_PROXY||e.https_proxy;if(!v)return null;const u=new URL(v);return u.protocol+'//'+u.hostname+':'+u.port;};
 const stale=endpoint(env(old))!==endpoint(env(fresh));
 console.log(JSON.stringify({container:old.State.Status,restartCount:old.RestartCount,createdAt:old.Created,proxyEndpointChanged:stale,diagnosis:stale?'stale_proxy_endpoint':'proxy_endpoint_matches'}));
}catch{console.error('Worker diagnostic unavailable. No environment values printed.');process.exitCode=1;}
finally{if(probe){try{docker(['rm',probe]);}catch{process.exitCode=1;}}}
