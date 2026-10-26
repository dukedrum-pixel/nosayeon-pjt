import { buildResultView } from './result-state.mjs';

const player = document.querySelector('#result-audio');
const play = document.querySelector('#result-play');
const select = document.querySelector('#result-file');
const sourceUrl = new URL(location.href);
const id = sourceUrl.searchParams.get('id');
let token = new URLSearchParams(sourceUrl.hash.slice(1)).get('token');
// Scrub the bearer secret before API requests; never persist it in the browser.
history.replaceState(null, '', location.pathname);
let snapshot = null, blobUrl = null, expiryTimer = null, pending = null;

function clearAudio() {
  player.pause(); player.removeAttribute('src'); player.load();
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = null;
}

function render(value) {
  clearTimeout(expiryTimer);
  snapshot = value;
  const view = buildResultView(value);
  document.querySelector('#result-heading').textContent = view.heading;
  document.querySelector('#result-message').textContent = view.message;
  document.querySelector('#result-playback').hidden = !view.showPlayer;
  document.querySelector('#result-download').hidden = !view.showDownload;
  const expiry = document.querySelector('#result-expiry');
  expiry.hidden = !view.expiresAt;
  expiry.textContent = view.expiresAt ? `사용 가능 기한: ${new Date(view.expiresAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} (한국 시간)` : '';
  if (!view.showPlayer) { pending?.abort(); clearAudio(); }
  if (view.expiresAt) expiryTimer = setTimeout(() => render({ status: 'expired' }), Math.min(Date.parse(view.expiresAt) - Date.now(), 2147483647));
  return view;
}

async function load() {
  if (!/^[0-9a-f-]{36}$/.test(id ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(token ?? '')) { render({ status: 'invalid_link' }); return; }
  try {
    const response = await fetch(`/api/result?id=${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20000),
    });
    const data = await response.json();
    if (!response.ok && !['invalid_link', 'expired', 'processing'].includes(data.status)) throw new Error();
    const view = buildResultView(data);
    if (view.status === 'available') {
      if (!Array.isArray(data.files) || data.files.length < 1 || data.files.length > 8) throw new Error();
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
  if (buildResultView(snapshot).status !== 'available') { render({ status: 'expired' }); return; }
  play.disabled = true; select.disabled = true; clearAudio();
  const controller = new AbortController(); pending = controller;
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const file = snapshot.files.find(file => file.index === Number(select.value));
    if (!file) throw new Error();
    const response = await fetch(`/api/audio?id=${encodeURIComponent(id)}&file=${file.index}`, {
      headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal,
    });
    if (!response.ok) { render(await response.json()); return; }
    if (response.headers.get('Content-Type') !== file.mime || Number(response.headers.get('Content-Length')) !== file.bytes) throw new Error();
    const blob = await response.blob();
    if (blob.size !== file.bytes) throw new Error();
    if (buildResultView(snapshot).status !== 'available') { render({ status: 'expired' }); return; }
    blobUrl = URL.createObjectURL(blob); player.src = blobUrl;
    document.querySelector('#result-message').textContent = '노래를 불러왔습니다. 재생 버튼을 눌러 들어보세요.';
  } catch {
    if (buildResultView(snapshot).status === 'available') render({ status: 'error' });
  } finally { clearTimeout(timeout); pending = null; play.disabled = false; select.disabled = false; }
});

select.addEventListener('change', clearAudio);
document.addEventListener('visibilitychange', () => {
  if (snapshot?.status === 'available' && buildResultView(snapshot).status === 'expired') render({ status: 'expired' });
});
window.addEventListener('pagehide', () => { pending?.abort(); clearAudio(); clearTimeout(expiryTimer); token = null; });
window.addEventListener('pageshow', event => { if (event.persisted) render({ status: 'invalid_link' }); });
load();
