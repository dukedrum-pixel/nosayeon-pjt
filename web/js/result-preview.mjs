import { buildResultView } from './result-state.mjs';

const scenario = document.querySelector('#result-scenario');
const player = document.querySelector('#result-audio');

function renderPreview() {
  const now = Date.now();
  const view = buildResultView({
    status: scenario.value,
    expiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
    canRestore: document.querySelector('#restore-eligible').checked,
  }, now);
  // Clear playback on every state transition, including available -> expired.
  // Preview fixtures never contain a Storage URL, audio bytes or access token.
  player.pause();
  player.removeAttribute('src');
  player.load();
  document.querySelector('#result-heading').textContent = view.heading;
  document.querySelector('#result-message').textContent = view.message;
  document.querySelector('#result-playback').hidden = !view.showPlayer;
  document.querySelector('#result-download').hidden = !view.showDownload;
  document.querySelector('#result-restore').hidden = !view.showRestore;
  const expiry = document.querySelector('#result-expiry');
  expiry.hidden = !view.expiresAt;
  expiry.textContent = view.expiresAt
    ? `사용 가능 기한: ${new Date(view.expiresAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} (한국 시간)`
    : '';
}

scenario.addEventListener('change', renderPreview);
document.querySelector('#restore-eligible').addEventListener('change', renderPreview);
renderPreview();
