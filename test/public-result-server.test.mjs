import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createResultServer } from '../src/result-server.mjs';

function get(port,path,{host='music.example.com',origin,method='GET',extra={}}={}) {
  return new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port,path,method,headers:{Host:host,...origin?{Origin:origin}:{},...extra}},res=>{
      let body='';res.setEncoding('utf8');res.on('data',chunk=>{body+=chunk;});res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));
    });req.on('error',reject);req.end();
  });
}

test('공개 모드는 고정 HTTPS 원점만 받고 관리자·비공개 파일·프록시 헤더로 접근을 넓히지 않는다',async()=>{
  let handled=0,admin=0;
  const server=createResultServer({publicOrigin:'https://music.example.com',handler:async req=>{handled++;assert.equal(new URL(req.url).origin,'https://music.example.com');return Response.json({status:'invalid_link'},{status:401});},adminHandler:async()=>{admin++;return Response.json({});}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
  try{
    assert.equal((await get(port,'/healthz')).body,'ok');
    const html=await get(port,'/result.html');assert.equal(html.status,200);assert.match(html.headers['strict-transport-security'],/max-age/);assert.match(html.headers['content-security-policy'],/frame-ancestors 'none'/);
    for(const path of ['/result.css','/js/result-player.mjs'])assert.equal((await get(port,path)).status,200);
    for(const path of ['/admin.html','/api/admin/dashboard','/api/admin/send-email','/result-preview.html','/.env','/artifacts/result-links/file.json','/js/admin.mjs','/index.html'])assert.equal((await get(port,path)).status,404);
    assert.equal(admin,0);
    assert.equal((await get(port,'/api/result',{origin:'https://attacker.example.com'})).status,403);
    assert.equal((await get(port,'/api/result',{host:'attacker.example.com',extra:{'X-Forwarded-Host':'music.example.com','X-Forwarded-Proto':'https'}})).status,403);
    assert.equal((await get(port,'/api/result',{origin:'https://music.example.com'})).status,401);assert.equal(handled,1);
    assert.equal((await get(port,'/result.html',{method:'POST'})).status,404);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
