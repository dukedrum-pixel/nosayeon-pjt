import {readFile,mkdir,writeFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url),site=JSON.parse(await readFile(new URL('config/admin-site.json',root),'utf8')),assets={};
for(const [path,name,mime] of [['/','index.html','text/html'],['/operations.css','operations.css','text/css'],['/operations.mjs','operations.mjs','text/javascript']])assets[path]={body:await readFile(new URL('web/operations/'+name,root),'utf8'),mime:mime+'; charset=utf-8'};
const code=`const assets=${JSON.stringify(assets)};\n${await readFile(new URL('src/operations-site.mjs',root),'utf8')}\nexport default createOperationsSite({assets,origin:${JSON.stringify(site.origin)},edgeBase:'https://fuvgpqkyhuyanbfavwcg.supabase.co/functions/v1/nosayeon-result-api'});\n`;
await mkdir(new URL('artifacts/admin-site/',root),{recursive:true});await writeFile(new URL('artifacts/admin-site/index.js',root),code);console.log('Private admin Worker prepared; no secrets embedded.');
