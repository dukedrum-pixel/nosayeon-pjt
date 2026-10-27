// Managed-cloud launcher. Credentials are inherited by name; no values are logged or written to source.
import {spawnSync} from 'node:child_process';
import {access,realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const name='nosayeon-request-worker';
function docker(args,{capture=false}={}){
 const env={...process.env};for(const k of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'])delete env[k];
 const result=spawnSync('docker',['--host=unix:///var/run/docker.sock',...args],{env,encoding:'utf8',stdio:capture?'pipe':'inherit'});
 if(result.status!==0)throw new Error('Docker operation failed. No private details printed.');return result.stdout?.trim();
}
try{
 const existing=docker(['ps','-a','--filter',`name=^/${name}$`,'--format','{{.Names}}'],{capture:true});
 if(existing){console.log('Worker container already exists. Inspect its state before replacing or starting another.');process.exit(0);}
 const raw=spawnSync('pgrep',['-f','^node --use-env-proxy scripts/song-request-worker.mjs$'],{encoding:'utf8'});if(raw.status!==1)throw new Error('An interactive worker exists or process check failed. Stop it safely before starting this worker.');
 const runtime=await realpath(root+'artifacts/request-service/runtime.json');await access(runtime);
 const cert=process.env.CODEX_PROXY_CERT;if(!cert)throw new Error('Managed proxy certificate is required.');await access(cert);
 const keys=['GEMINI_API_KEY','SUPABASE_SERVICE_ROLE_KEY','GMAIL_CLIENT_ID','GMAIL_CLIENT_SECRET','GMAIL_REFRESH_TOKEN'];
 if(keys.some(key=>!process.env[key]))throw new Error('Required managed credentials are missing.');
 if(process.env.GMAIL_SENDER)keys.push('GMAIL_SENDER');
 docker(['run','-d','--name',name,'--restart','unless-stopped','--init','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','64','--memory','384m','--cpus','1','--stop-timeout','180',
 '--log-opt','max-size=2m','--log-opt','max-file=2','--mount',`type=bind,src=${runtime},dst=/app/artifacts/request-service/runtime.json,readonly`,'--mount',`type=bind,src=${cert},dst=/run/proxy-ca.pem,readonly`,'-e','NODE_EXTRA_CA_CERTS=/run/proxy-ca.pem',...keys.flatMap(key=>['-e',key]),'nosayeon-request-worker:current'],{capture:true});
 console.log('Detached worker container started with restart policy unless-stopped. No music or email requested by launcher.');
}catch(error){console.error(error.message);process.exitCode=1;}
