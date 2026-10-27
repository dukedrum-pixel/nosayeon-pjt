import { buildResultView } from './result-state.mjs';
import { setupResultPlayer, updateResultStatus } from './result-player.mjs';

const scenario = document.querySelector('#result-scenario');
const player = document.querySelector('#result-audio');
const play = document.querySelector('#result-play');
setupResultPlayer(player, play);
play.disabled = true;
document.querySelector('#result-mute').disabled = true;

function renderPreview() {
  const now = Date.now();
  const view = buildResultView({
    status: scenario.value,
    expiresAt: new Date(now + 7 * 86400000).toISOString(),
    canRestore: document.querySelector('#restore-eligible').checked,
  }, now);
  updateResultStatus(view.status);
  document.querySelector('#result-heading').textContent = view.heading;
  document.querySelector('#result-message').textContent = view.message;
  document.querySelector('#result-playback').hidden = !view.showPlayer;
  document.querySelector('#result-download').hidden = !view.showDownload;
  document.querySelector('#result-restore').hidden = !view.showRestore;
  document.querySelector('#player-status').textContent = '미리보기 · 실제 음원 연결 전';
  const expiry = document.querySelector('#result-expiry');
  expiry.hidden = !view.expiresAt;
  expiry.textContent = view.expiresAt ? `다운로드 가능: ${new Date(view.expiresAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}까지 (한국 시간) · 1회` : '';
}
scenario.addEventListener('change', renderPreview);
document.querySelector('#restore-eligible').addEventListener('change', renderPreview);
renderPreview();
