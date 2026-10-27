import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { sealResultToken, openResultToken } from '../src/notification-secret.mjs';
import { publicResultOrigin, buildPublicResultLink } from '../src/result-link.mjs';
import { buildResultNotificationMail } from '../src/result-notification-mail.mjs';
import { createGmailDelivery, GmailDeliveryError } from '../src/gmail-delivery.mjs';
import { deliverResultNotifications, notificationConfiguration } from '../src/result-notifications.mjs';
import { hashResultToken } from '../src/identifiers.mjs';
import { createAdminHandler } from '../src/admin-access.mjs';

const id='11111111-1111-4111-8111-111111111111', token='a'.repeat(43), key=Buffer.alloc(32,7).toString('base64url');
const origin='https://music.example.com', recipient='customer@example.com', sender='peter@humansyntax.kr';
const context={songId:id,recipient,origin}, configuration={origin,key};
const expiresAt=new Date(Date.now()+86400000).toISOString();
const tokenHash=await hashResultToken(token);

test('완료 링크는 지정 HTTPS 원점과 fragment 토큰만 사용하고 로컬·임의 경로·자격증명을 거부한다',()=>{
  const link=new URL(buildPublicResultLink({...context,token}));
  assert.equal(link.origin,origin);assert.equal(link.pathname,'/result.html');assert.equal(link.searchParams.has('token'),false);
  assert.equal(new URLSearchParams(link.hash.slice(1)).get('token'),token);
  for(const value of ['http://music.example.com','https://localhost','https://127.0.0.1','https://[::1]','https://music.local','https://music.example.com/path','https://music.example.com?x=1','https://user@music.example.com','https://music.example.com:444','https://music.example.com/#x','https://music.example.com\\evil'])assert.throws(()=>publicResultOrigin(value));
  assert.equal(notificationConfiguration({}),null);assert.equal(notificationConfiguration({RESULT_EMAIL_ENABLED:'false'}),null);
  assert.throws(()=>notificationConfiguration({RESULT_EMAIL_ENABLED:'true'}));
});

test('페이지 토큰은 난수 AES-GCM 암호문이며 곡·수신처·원점·키·본문 변경 시 복호화를 거부한다',()=>{
  const sealedToken=sealResultToken({...context,token,key});
  assert.notEqual(sealedToken,sealResultToken({...context,token,key}));assert.doesNotMatch(sealedToken,new RegExp(token));
  assert.equal(openResultToken({...context,sealedToken,key}),token);
  const bodyStart=sealedToken.lastIndexOf('.')+1;
  const tampered=sealedToken.slice(0,bodyStart)+(sealedToken[bodyStart]==='A'?'B':'A')+sealedToken.slice(bodyStart+1);
  for(const changes of [{songId:crypto.randomUUID()},{recipient:'other@example.com'},{origin:'https://other.example.com'},{key:Buffer.alloc(32,8).toString('base64url')},{sealedToken:tampered}])assert.throws(()=>openResultToken({...context,sealedToken,key,...changes}),/notification_secret_unavailable/);
  assert.throws(()=>sealResultToken({...context,token,key:'short'}));
});

test('고객 메일은 HTML 버튼·텍스트 대안·기간·횟수 안내를 포함하고 음악 첨부나 추적 자원을 넣지 않는다',async()=>{
  const details={...context,token,expiresAt,event:'initial_ready'};
  const message=buildResultNotificationMail(details);
  assert.match(message.html,/내 음악 듣기/);assert.match(message.text,/1회/);assert.match(message.text,/한국 시간/);
  assert.match(message.text,/#token=/);assert.doesNotMatch(message.html,/<script|<img|<audio|<iframe/i);
  assert.notEqual(message.subject,buildResultNotificationMail({...details,event:'reissue_ready'}).subject);
  const calls=[];
  const mailer=createGmailDelivery({sender,clientId:'CLIENT',clientSecret:'SECRET',refreshToken:'REFRESH',fetchImpl:async(url,options)=>{
    calls.push({url,options});return Response.json(calls.length===1?{access_token:'ACCESS'}:calls.length===2?{email:sender,email_verified:true}:{id:'gmail123'});
  }});
  await mailer.sendResultLink({...details,recipient,operationId:id});assert.equal(calls.length,3);
  const mime=Buffer.from(JSON.parse(calls[2].options.body).raw,'base64url').toString();
  assert.match(mime,/multipart\/alternative/);assert.doesNotMatch(mime,/Content-Disposition: attachment|SECRET|REFRESH|ACCESS/);
  assert.match(mime,/Message-ID: <11111111-1111-4111-8111-111111111111@humansyntax.kr>/);
  assert.match(mime,/Content-Type: text\/plain/);assert.match(mime,/Content-Type: text\/html/);
});

test('완료 안내 발송도 계정 불일치·Gmail 거절·응답 손실을 구분하고 자동 재시도하지 않는다',async()=>{
  for(const scenario of ['account','reject','lost','expired']){
    let sends=0;
    const mailer=createGmailDelivery({sender,clientId:'CLIENT',clientSecret:'SECRET',refreshToken:'REFRESH',fetchImpl:async url=>{
      if(url.includes('oauth2'))return Response.json({access_token:'ACCESS'});
      if(url.includes('openidconnect'))return Response.json({email:scenario==='account'?'wrong@example.com':sender,email_verified:true});
      sends++;if(scenario==='lost')throw new Error('PRIVATE');return new Response(null,{status:403});
    }});
    await assert.rejects(mailer.sendResultLink({...context,token,recipient,operationId:id,expiresAt:scenario==='expired'?'2020-01-01T00:00:00Z':expiresAt}),error=>error.state===(scenario==='lost'?'unknown':'failed'));
    assert.equal(sends,['account','expired'].includes(scenario)?0:1);
  }
});

test('worker는 비활성에서 DB도 접근하지 않고 발송·DB 확정 결과 불명은 다시 보내지 않는다',async()=>{
  let claimed=false,sends=0,finishes=0;
  const sealedToken=sealResultToken({...context,token,key});
  const backend={notificationCandidates:async()=>[{id}],beginResultNotification:async()=>{
    if(claimed)return {result:'existing'};claimed=true;
    return {result:'started',song_id:id,operation_id:id,recipient,sender,public_origin:origin,sealed_token:sealedToken,token_hash:tokenHash,expires_at:expiresAt,event:'initial_ready'};
  },finishResultNotification:async()=>{finishes++;throw new Error('PRIVATE finish lost');}};
  assert.equal((await deliverResultNotifications({backend:{},configuration:null})).status,'disabled');
  const mailer={sender,sendResultLink:async()=>{sends++;return {providerMessageId:'gmail123'};}};
  const result=await deliverResultNotifications({backend,mailer,configuration});assert.equal(result.unknown,1);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|customer|token|https/);
  await deliverResultNotifications({backend,mailer,configuration});assert.equal(sends,1);assert.equal(finishes,1);
  claimed=false;backend.finishResultNotification=async(_,__,state)=>{assert.equal(state,'unknown');return true;};
  mailer.sendResultLink=async()=>{throw new Error('Unexpected transport error');};
  assert.equal((await deliverResultNotifications({backend,mailer,configuration})).unknown,1);
});

test('오류 키·변조 토큰은 Gmail 호출 전에 실패로 확정하고 수신처·비밀값을 반환하지 않는다',async()=>{
  let sends=0;
  const backend={notificationCandidates:async()=>[{id}],beginResultNotification:async()=>({result:'started',song_id:id,operation_id:id,recipient,sender,public_origin:origin,sealed_token:sealResultToken({...context,token,key}),token_hash:'0'.repeat(64),expires_at:expiresAt,event:'initial_ready'}),finishResultNotification:async(_,__,status)=>{assert.equal(status,'failed');return true;}};
  const result=await deliverResultNotifications({backend,configuration,mailer:{sender,sendResultLink:async()=>{sends++;}}});
  assert.equal(result.failed,1);assert.equal(sends,0);
});

test('고객 안내 이력 API도 관리자 인증을 요구하고 준비된 감사 필드만 반환한다',async()=>{
  const handler=createAdminHandler({accessToken:token,backend:{notificationHistory:async()=>[{id,status:'unknown'}]}});
  const url='http://localhost/api/admin/notifications';
  assert.equal((await handler(new Request(url))).status,401);
  const body=await (await handler(new Request(url,{headers:{Authorization:`Bearer ${token}`}}))).json();
  assert.deepEqual(body,{notifications:[{id,status:'unknown'}]});
});

test('안내 SQL은 서버 전용이며 차수별 중복·만료·소진·오래된 작업·확정 응답 손실을 안전하게 처리한다',async t=>{
  const db=new PGlite();
  try{
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema storage;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(bucket_id text,metadata jsonb);grant usage on schema storage to service_role;grant select on storage.objects to service_role;`);
    for(const name of ['20261026143658_private_audio_storage','20261026154303_result_link_access','20261026200705_single_download_cleanup','20261026203923_expired_audio_cleanup','20261026220530_stable_page_reissue','20261026230353_admin_dashboard','20261027154624_result_email_notifications'])await db.exec(await readFile(new URL(`../supabase/migrations/${name}.sql`,import.meta.url),'utf8'));
    const rpc=async(name,args=[])=> (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as value`,args)).rows[0].value;
    async function fixture(){
      const songId=crypto.randomUUID(), fixtureToken=songId.replaceAll('-','')+'a'.repeat(11), fixtureHash=await hashResultToken(fixtureToken);
      await db.query(`insert into public.songs(id,google_interaction_id,generated_at,storage_status,stored_at) values($1,$2,clock_timestamp(),'stored',clock_timestamp())`,[songId,songId]);
      await rpc('issue_initial_result_link',[songId,fixtureHash]);
      const sealed=sealResultToken({songId,recipient,origin,token:fixtureToken,key});
      assert.equal((await rpc('configure_song_email',[songId,fixtureHash,recipient,sender,origin,sealed])).result,'configured');
      return {songId,sealed,fixtureHash,notificationId:(await db.query('select id from public.song_notification_outbox where song_id=$1',[songId])).rows[0].id};
    }
    await t.test('RLS와 RPC execute 권한은 anon·authenticated를 차단한다',async()=>{
      for(const role of ['anon','authenticated']){
        const result=(await db.query(`select has_table_privilege($1,'public.song_email_settings','SELECT') as readable,
          has_function_privilege($1,'public.configure_song_email(uuid,text,text,text,text,text)','EXECUTE') as configurable,
          has_function_privilege($1,'public.begin_result_notification(uuid,text,text)','EXECUTE') as sendable`,[role])).rows[0];
        assert.deepEqual(result,{readable:false,configurable:false,sendable:false});
      }
    });
    await t.test('동일 차수의 재등록·동시 점유는 발송 시도 하나만 만든다',async()=>{
      const {songId,sealed,notificationId,fixtureHash}=await fixture();
      assert.equal((await rpc('configure_song_email',[songId,fixtureHash,recipient,sender,origin,sealed])).result,'configured');
      const rows=(await db.query('select * from public.song_notification_outbox where song_id=$1',[songId])).rows;
      assert.equal(rows.length,1);assert.equal(JSON.stringify(rows).includes(token),false);
      assert.equal((await rpc('begin_result_notification',[notificationId,'https://wrong.example.com',sender])).result,'pending_setup');
      const attempts=await Promise.all([rpc('begin_result_notification',[notificationId,origin,sender]),rpc('begin_result_notification',[notificationId,origin,sender])]);
      assert.equal(attempts.filter(x=>x.result==='started').length,1);assert.equal(attempts.filter(x=>x.result==='existing').length,1);
      const job=attempts.find(x=>x.result==='started');
      assert.equal(await rpc('finish_result_notification',[notificationId,crypto.randomUUID(),'sent','gmail123',null]),false);
      assert.equal(await rpc('finish_result_notification',[notificationId,job.operation_id,'sent',null,null]),false);
      assert.equal(await rpc('finish_result_notification',[notificationId,job.operation_id,'sent','gmail123',null]),true);
      assert.equal(await rpc('finish_result_notification',[notificationId,job.operation_id,'unknown',null,'mail_result_unknown']),false);
      assert.equal((await rpc('begin_result_notification',[notificationId,origin,sender])).result,'existing');
      const l=(await db.query('select token_hash,consumed_at,delivery_version from public.song_result_links where song_id=$1',[songId])).rows[0];
      assert.deepEqual(l,{token_hash:fixtureHash,consumed_at:null,delivery_version:0});
    });
    await t.test('만료·소진·새 차수·취소 페이지는 Gmail 없이 skipped 처리한다',async()=>{
      for(const change of ["issued_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second'","consumed_at=clock_timestamp()","delivery_version=1","revoked_at=clock_timestamp()"]){
        const {songId,notificationId}=await fixture();
        await db.query(`update public.song_result_links set ${change} where song_id=$1`,[songId]);
        assert.equal((await rpc('begin_result_notification',[notificationId,origin,sender])).result,'skipped');
      }
    });
    await t.test('구 차수 발송 완료가 새 차수의 알림 상태를 덮어쓰지 않는다',async()=>{
      const {songId,notificationId}=await fixture(),job=await rpc('begin_result_notification',[notificationId,origin,sender]);
      await db.query("update public.song_result_links set delivery_version=1,notification_status='pending_setup' where song_id=$1",[songId]);
      assert.equal(await rpc('finish_result_notification',[notificationId,job.operation_id,'unknown',null,'mail_result_unknown']),true);
      assert.equal((await db.query('select notification_status from public.song_result_links where song_id=$1',[songId])).rows[0].notification_status,'pending_setup');
      const available=(await db.query('select * from public.list_result_notification_candidates(20)')).rows;
      assert.equal(available.some(x=>x.id===notificationId),false);
    });
    await t.test('이미 보낸 차수는 설정을 다시 저장해도 재발송하지 않는다',async()=>{
      const {songId,sealed,notificationId,fixtureHash}=await fixture(),job=await rpc('begin_result_notification',[notificationId,origin,sender]);
      await rpc('finish_result_notification',[notificationId,job.operation_id,'sent','gmail456',null]);
      await rpc('configure_song_email',[songId,fixtureHash,recipient,sender,origin,sealed]);
      assert.equal((await rpc('begin_result_notification',[notificationId,origin,sender])).result,'existing');
    });
  }finally{await db.close();}
});
