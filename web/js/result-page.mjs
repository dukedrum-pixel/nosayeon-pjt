import { resultApiUrl } from './result-api.mjs';
import { buildResultView } from './result-state.mjs';
import { setupResultPlayer, updateResultStatus } from './result-player.mjs';

const apiBase = document.querySelector('meta[name="result-api-base"]')?.content || '';
const api = path => resultApiUrl(path, apiBase);
const player = document.querySelector('#result-audio');
const play = document.querySelector('#result-play');
const select = document.querySelector('#result-file');
const download = document.querySelector('#result-download');
const downloadMessage = document.querySelector('#download-message');
const restore=document.querySelector('#result-restore');
const restoreMessage=document.querySelector('#restore-message');
const playerUI = setupResultPlayer(player, play);
const sourceUrl = new URL(location.href);
const id = sourceUrl.searchParams.get('id');
let token = new URLSearchParams(sourceUrl.hash.slice(1)).get('token');
// A stable capability stays in the fragment so refresh keeps the same page.
// Fragments are not sent in HTTP requests or Referer; never log this URL.
let snapshot = null, blobUrl = null, expiryTimer = null, audioPending = null, downloadPending = null;
let downloading = false;
let restoring=false,pollTimer=null;

function clearAudio() {
  player.pause(); player.removeAttribute('src'); player.load();
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = null;
  playerUI.reset();
}

function render(value) {
  clearTimeout(expiryTimer);
  clearTimeout(pollTimer);
  snapshot = value;
  const view = buildResultView(value);
  updateResultStatus(view.status);
  document.querySelector('#result-heading').textContent = view.heading;
  document.querySelector('#result-message').textContent = view.message;
  document.querySelector('#result-playback').hidden = !view.showPlayer;
  document.querySelector('#result-download').hidden = !view.showDownload;
  download.disabled = !view.showDownload || downloading||restoring;
  restore.hidden=!view.showRestore;restore.disabled=!view.showRestore||downloading||restoring;
  const deadline=document.querySelector('#restore-deadline');
  deadline.hidden=!value?.restoreDeadline;
  deadline.textContent=value?.restoreDeadline?`재신청 가능 기한: ${new Date(value.restoreDeadline).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})} (한국 시간)`:'';
  const expiry = document.querySelector('#result-expiry');
  expiry.hidden = !view.expiresAt;
  expiry.textContent = view.expiresAt ? `다운로드 가능: ${new Date(view.expiresAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}까지 (한국 시간) · 1회` : '';
  if (!view.showPlayer) { audioPending?.abort(); downloadPending?.abort(); clearAudio(); }
  const dates=[view.expiresAt,view.showRestore?value?.restoreDeadline:null].filter(Boolean).map(Date.parse).filter(time=>time>Date.now());
  if(dates.length)expiryTimer=setTimeout(()=>{clearAudio();load();},Math.min(Math.min(...dates)-Date.now(),2147483647));
  if(view.status==='processing')pollTimer=setTimeout(load,3000);
  return view;
}

async function load() {
  if (!/^[0-9a-f-]{36}$/.test(id ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(token ?? '')) { render({ status: 'invalid_link' }); return; }
  try {
    const response = await fetch(api(`/api/result?id=${encodeURIComponent(id)}`), {
      headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20000),
    });
    const data = await response.json();
    if (!response.ok && !['invalid_link', 'expired', 'consumed', 'processing','restore_failed','retention_ended'].includes(data.status)) throw new Error();
    const view = buildResultView(data);
    if (view.status === 'available') {
      if (!Array.isArray(data.files) || data.files.length < 1 || data.files.length > 8) throw new Error();
      document.querySelector('#result-file-picker').hidden = data.files.length === 1;
      select.replaceChildren();
      for (const [index, file] of data.files.entries()) {
        if (file.index !== index + 1 || !['audio/mpeg', 'audio/mp3', 'audio/wav'].includes(file.mime)
          || !Number.isInteger(file.bytes) || file.bytes < 1 || file.bytes > 67108864) throw new Error();
        const option = document.createElement('option');
        option.value = String(file.index); option.textContent = `음원 ${file.index}`; select.append(option);
      }
    }
    render(data);
  } catch { render({ status: 'error' }); }
}

play.addEventListener('click', async () => {
  if (downloading||restoring) return;
  if (buildResultView(snapshot).status !== 'available') { render({ status: 'expired' }); return; }
  if (blobUrl && !player.error) { await playerUI.toggle(); return; }
  play.disabled = true; select.disabled = true; clearAudio();
  playerUI.setStatus('음악을 불러오고 있어요…');
  const controller = new AbortController(); audioPending = controller;
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const file = snapshot.files.find(file => file.index === Number(select.value));
    if (!file) throw new Error();
    const response = await fetch(api(`/api/audio?id=${encodeURIComponent(id)}&file=${file.index}&version=${snapshot.deliveryVersion??0}`), {
      headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal,
    });
    if (!response.ok) { const state=await response.json();if(state.status==='stale')await load();else render(state);return; }
    if (response.headers.get('Content-Type') !== file.mime || Number(response.headers.get('Content-Length')) !== file.bytes) throw new Error();
    const blob = await response.blob();
    if (blob.size !== file.bytes) throw new Error();
    if (controller.signal.aborted || downloading) return;
    if (buildResultView(snapshot).status !== 'available') { if (snapshot?.status === 'available') render({ status: 'expired' }); return; }
    blobUrl = URL.createObjectURL(blob); player.src = blobUrl;
    playerUI.setStatus('노래가 준비됐어요.');
    await playerUI.toggle();
  } catch {
    if (!downloading && !restoring && audioPending === controller && buildResultView(snapshot).status === 'available') playerUI.setStatus('음악을 불러오지 못했어요. 재생 버튼으로 다시 시도해 주세요.');
  } finally { clearTimeout(timeout); if (audioPending === controller) audioPending = null; play.disabled = downloading||restoring; select.disabled = downloading||restoring; }
});

download.addEventListener('click', async () => {
  if (downloading||restoring || buildResultView(snapshot).status !== 'available') return;
  downloading = true; download.disabled = true; play.disabled = true; select.disabled = true;
  audioPending?.abort(); clearAudio();
  const controller = new AbortController(); downloadPending = controller;
  const timeout = setTimeout(() => controller.abort(), 600000);
  downloadMessage.textContent = '다운로드를 준비하고 있습니다.';
  try {
    const files = snapshot.files;
    const response = await fetch(api(`/api/download?id=${encodeURIComponent(id)}&version=${snapshot.deliveryVersion??0}`), {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal,
    });
    if (!response.ok) throw new Error();
    const mime = files.length > 1 ? 'application/zip' : files[0].mime;
    const size = Number(response.headers.get('Content-Length'));
    const originalSize = files.reduce((sum, file) => sum + file.bytes, 0);
    if (response.headers.get('Content-Type') !== mime || !Number.isInteger(size)
      || size < originalSize || size > originalSize + 65536) throw new Error();
    const blob = await response.blob();
    if (blob.size !== size) throw new Error();
    const href = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = href; anchor.download = files.length > 1 ? 'nosayeon.zip' : `nosayeon.${files[0].mime === 'audio/wav' ? 'wav' : 'mp3'}`;
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60000);
    await load();
    downloadMessage.textContent = '다운로드를 시작했습니다. 이 링크는 사용 완료되었습니다.';
  } catch {
    // Only re-read state; never automatically retry a consuming POST.
    await load();
    downloadMessage.textContent = snapshot?.status === 'consumed'
      ? '링크가 사용 완료되었습니다. 다운로드가 시작됐는지 확인해 주세요.'
      : '다운로드를 시작하지 못했습니다. 상태를 확인한 뒤 직접 다시 시도해 주세요.';
  } finally {
    clearTimeout(timeout); downloadPending = null; downloading = false;
    play.disabled = false; select.disabled = false;
    download.disabled = buildResultView(snapshot).status !== 'available';
    restore.disabled=!buildResultView(snapshot).showRestore;
  }
});

restore.addEventListener('click',async()=>{
  if(restoring||downloading||!buildResultView(snapshot).showRestore)return;
  const version=snapshot.deliveryVersion??0;restoring=true;
  audioPending?.abort();clearAudio();restoreMessage.textContent='기존 다운로드를 종료하고 같은 음악을 다시 준비하고 있습니다.';
  render({status:'processing'});
  try{
    await fetch(api(`/api/restore?id=${encodeURIComponent(id)}&version=${version}`),{method:'POST',headers:{Authorization:`Bearer ${token}`},credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(600000)});
  }catch{}
  finally{
    restoring=false;await load();
    restoreMessage.textContent=snapshot?.status==='available'&&(snapshot.deliveryVersion??0)>version
      ?'같은 음악이 다시 준비되었습니다. 이 페이지에서 다시 듣고 저장할 수 있어요.'
      :snapshot?.status==='processing'?'음악을 준비하고 있습니다. 새로고침해도 이 페이지에서 상태를 확인할 수 있습니다.':'재신청을 완료하지 못했습니다. 현재 상태를 확인한 뒤 직접 다시 신청해 주세요.';
  }
});

select.addEventListener('change', clearAudio);
document.addEventListener('visibilitychange', () => {
  if (snapshot?.status === 'available' && buildResultView(snapshot).status === 'expired') render({ status: 'expired' });
});
window.addEventListener('pagehide', () => { audioPending?.abort(); downloadPending?.abort(); clearAudio(); clearTimeout(expiryTimer);clearTimeout(pollTimer); });
window.addEventListener('pageshow', event => { if (event.persisted) load(); });
load();
