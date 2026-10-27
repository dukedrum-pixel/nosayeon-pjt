import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
const root=new URL('../artifacts/hosted-result-site/',import.meta.url);
await mkdir(new URL('js/',root),{recursive:true});
const edgeBase='https://fuvgpqkyhuyanbfavwcg.supabase.co/functions/v1/nosayeon-result-api';
let html=await readFile(new URL('../web/result.html',import.meta.url),'utf8');
html=html.replace('<title>',`<meta name="result-api-base" content="${edgeBase}">\n  <title>`)
 .replace("connect-src 'self';","connect-src 'self' https://fuvgpqkyhuyanbfavwcg.supabase.co;");
await writeFile(new URL('result.html',root),html);
for(const path of ['styles.css','result.css','js/result-api.mjs','js/result-page.mjs','js/result-player.mjs','js/result-state.mjs'])await copyFile(new URL(`../web/${path}`,import.meta.url),new URL(path,root));
console.log('Hosted page candidate prepared under artifacts/hosted-result-site. No deployment, secrets, audio or mail.');
