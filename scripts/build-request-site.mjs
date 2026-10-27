import {readFile,mkdir,writeFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const assets={};
for(const [path,file] of Object.entries({'/':'request.html','/result.html':'result.html','/styles.css':'styles.css','/request.css':'request.css','/result.css':'result.css','/js/request-page.mjs':'js/request-page.mjs','/js/result-page.mjs':'js/result-page.mjs','/js/result-player.mjs':'js/result-player.mjs','/js/result-state.mjs':'js/result-state.mjs','/js/result-api.mjs':'js/result-api.mjs'})){
 let body=await readFile(new URL(`web/${file}`,root),'utf8');
 if(file==='result.html')body=body.replace('<title>','<meta name="result-api-base" content="https://fuvgpqkyhuyanbfavwcg.supabase.co/functions/v1/nosayeon-result-api">\n<title>').replace("connect-src 'self';","connect-src 'self' https://fuvgpqkyhuyanbfavwcg.supabase.co;");
 assets[path]={body,mime:file.endsWith('.mjs')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8'};
}
const runtime=await readFile(new URL('src/request-site-runtime.mjs',root),'utf8');
const code=`const assets=${JSON.stringify(assets)};\n${runtime}\nexport default createRequestSite({assets,origin:'https://nosayeon-result-check.cw-lee.chatgpt.site',edgeBase:'https://fuvgpqkyhuyanbfavwcg.supabase.co/functions/v1/nosayeon-result-api'});\n`;
await mkdir(new URL('artifacts/request-site/',root),{recursive:true});await writeFile(new URL('artifacts/request-site/index.js',root),code);
console.log('Request Site Worker source prepared. No runtime secrets embedded.');
