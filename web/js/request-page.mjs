const $=id=>document.getElementById(id);
const form=$('request-form'),button=$('submit-request');
let id=new URLSearchParams(location.hash.slice(1)).get('request'),timer=null,readinessTimer=null,busy=false;
const progressSteps=[...document.querySelectorAll('[data-step]')];
const stages=['accepted','generating','saving','notifying'];
function renderProgress(status){
 const current=stages.indexOf(status);
 for(const [index,step] of progressSteps.entries()){
  step.classList.toggle('is-current',current===index);step.classList.toggle('is-complete',status==='completed'||index<current);
  if(current===index)step.setAttribute('aria-current','step');else step.removeAttribute('aria-current');
 }
}
const copy={accepted:['접수 완료','사연을 받았어요','음악을 만들 차례를 기다리고 있어요.'],generating:['음악 생성 중','당신만의 노래를 만들고 있어요','잠시만 기다려 주세요. 이 페이지를 닫아도 접수된 신청은 유지됩니다.'],saving:['음원 저장 중','노래가 완성되었어요','소중한 음악을 안전하게 저장하고 있어요.'],notifying:['이메일 준비 중','곧 이메일로 만나보세요','완성된 노래의 전용 링크를 보내고 있어요.'],completed:['안내 메일 접수 완료','당신의 노래가 준비되었어요','dukedrum@gmail.com으로 결과 링크 발송이 접수됐어요. 받은편지함과 스팸함을 확인해 주세요.'],failed:['처리 확인 필요','이번 신청을 완료하지 못했어요','음악을 자동으로 다시 생성하지 않습니다. 신청 내역을 확인해 주세요.'],unknown:['생성 결과 확인 필요','요청 결과를 확인하고 있어요','중복 생성을 피하기 위해 다시 생성하지 않습니다. 운영 확인이 필요해요.'],mail_failed:['음악 준비 완료','이메일을 보내지 못했어요','아래에서 음악을 확인할 수 있어요. 메일은 자동 재발송하지 않습니다.'],mail_unknown:['음악 준비 완료','메일 접수 결과를 확인해야 해요','받은편지함을 확인해 주세요. 메일은 자동 재발송하지 않습니다.']};
function lock(value){for(const el of form.querySelectorAll('textarea,select,button'))el.disabled=value;}
function show(status,message){$('request-state').textContent=status;$('request-message').textContent=message;}
function requestAccess(){
 button.disabled=true;$('session-gate').hidden=false;$('session-password').focus?.();
 show('입장 확인 필요','작성한 사연은 유지됩니다. 비밀번호를 다시 입력해 주세요.');
}
$('session-form').addEventListener('submit',async event=>{
 event.preventDefault();const submit=$('session-submit');if(submit.disabled)return;submit.disabled=true;
 try{
  const response=await fetch('/api/session/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('session-password').value}),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok){$('session-message').textContent=response.status===429?'입력 횟수를 초과했어요. 5분 후 다시 시도해 주세요.':response.status===401?'비밀번호를 확인해 주세요.':'연결하지 못했어요. 잠시 후 다시 시도해 주세요.';return;}
  $('session-gate').hidden=true;$('session-message').textContent='';
  if(id)await poll();else await checkReadiness();
 }catch{$('session-message').textContent='연결하지 못했어요. 잠시 후 다시 시도해 주세요.';}
 finally{$('session-password').value='';submit.disabled=false;}
});
async function api(path,init){const r=await fetch(path,{...init,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(20000)});if(r.status===401){requestAccess();throw new Error('unauthorized');}const data=await r.json();if(!r.ok)throw new Error(data.error||data.result||'network');return data;}

async function poll(){
 clearTimeout(timer);
 try{
  const data=await api(`/api/request/status?id=${encodeURIComponent(id)}`),text=copy[data.status];
  if(!text)throw new Error();$('request-state').textContent=text[0];$('request-heading').textContent=text[1];$('request-message').textContent=text[2];
  if(data.resultUrl){const link=new URL(data.resultUrl);if(link.origin!==location.origin||link.pathname!=='/result.html')throw new Error();$('result-link').href=link.href;$('result-link').hidden=false;}
  renderProgress(data.status);
  const active=stages.includes(data.status);
  lock(true);$('new-request').hidden=active;
  if(active)timer=setTimeout(poll,3000);
 }catch(error){if(error.message==='unauthorized')return;if(error.message==='not_found'){show('접수 내역 없음','기존 신청 번호로 다시 접수할 수 있어요.');lock(false);return;}show('접수 상태 확인 중','연결이 잠시 끊겼어요. 중복 신청하지 않고 기존 신청 상태만 다시 확인합니다.');timer=setTimeout(poll,5000);}
}
$('story').addEventListener('input',()=>{$('story-count').textContent=`${$('story').value.length.toLocaleString('ko-KR')} / 5,000`;});
form.addEventListener('submit',async event=>{
 event.preventDefault();if(busy)return;busy=true;lock(true);
 id??=crypto.randomUUID();history.replaceState(null,'',`#request=${id}`);
 clearTimeout(readinessTimer);renderProgress('accepted');show('접수 중','사연을 전하고 있어요.');
 try{await api('/api/request/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,story:$('story').value,options:Object.fromEntries([...form.querySelectorAll('select')].map(el=>[el.name,el.value]))})});await poll();}
 catch(error){
  const messages={unauthorized:'입장 비밀번호를 확인한 뒤 신청 버튼을 다시 눌러주세요.',worker_unavailable:'현재 신청을 받을 수 없어요. 잠시 후 다시 확인해 주세요.',busy:'이전 신청을 처리하고 있어요. 완료 후 다시 신청해 주세요.',daily_limit:'오늘의 테스트 신청 수에 도달했어요. 내일 다시 이용해 주세요.',invalid_request:'사연과 음악 옵션을 확인해 주세요.',not_configured:'서비스 연결을 준비하고 있어요.'};
  show('접수 확인 필요',messages[error.message]||'접수 결과를 확인하지 못했어요. 새로 신청하지 않고 같은 신청 상태를 확인합니다.');
  if(messages[error.message]){renderProgress(null);id=null;history.replaceState(null,'',location.pathname);lock(false);if(error.message==='unauthorized')button.disabled=true;}
  else timer=setTimeout(poll,3000);
 }finally{busy=false;}
});
$('new-request').addEventListener('click',()=>{id=null;history.replaceState(null,'',location.pathname);location.reload();});
window.addEventListener('pagehide',()=>{clearTimeout(timer);clearTimeout(readinessTimer);});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!id&&!busy)checkReadiness();});
async function checkReadiness(){
 clearTimeout(readinessTimer);if(id||busy)return;
 try{
  const data=await api('/api/request/health');if(id||busy)return;
  const ready=data.enabled===true&&data.workerReady===true;button.disabled=!ready;
  if(ready){show('신청 가능','사연과 분위기를 골랐다면 노래 신청하기를 눌러주세요.');renderProgress(null);}
  else{show('신청 준비 중','현재 음악 준비를 잠시 쉬고 있어요. 신청이 가능해지면 버튼이 자동으로 켜집니다. 작성한 사연은 그대로 유지됩니다.');}
 }catch(error){if(id||busy||error.message==='unauthorized')return;button.disabled=true;show('연결 확인 중','연결을 자동으로 다시 확인하고 있어요. 사연은 계속 작성할 수 있습니다.');}
 if(!id&&!busy)readinessTimer=setTimeout(checkReadiness,5000);
}
if(id&&/^[0-9a-f-]{36}$/.test(id)){lock(true);poll();}
else checkReadiness();
