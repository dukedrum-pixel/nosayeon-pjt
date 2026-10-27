// Shared presentation for the real player and the offline state preview.
export function updateResultStatus(status) {
  const labels = { available: '음악 준비 완료', consumed: '다운로드 완료', expired: '기간 만료', processing: '음악 준비 중', restore_failed: '재신청 확인 필요', retention_ended: '보관기간 종료', invalid_link: '링크 확인 필요', error: '연결 확인 필요' };
  document.querySelector('.song-card').dataset.status = status;
  document.querySelector('#result-status').textContent = labels[status] ?? '확인 중';
}

export function setupResultPlayer(player, play) {
  const seek = document.querySelector('#result-seek');
  const mute = document.querySelector('#result-mute');
  const status = document.querySelector('#player-status');
  const clock = value => Number.isFinite(value) && value >= 0 ? `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}` : '0:00';
  function sync() {
    const ready = Number.isFinite(player.duration) && player.duration > 0;
    seek.disabled = !ready;
    seek.value = ready ? String(player.currentTime / player.duration * 100) : '0';
    seek.setAttribute('aria-valuetext', `${clock(player.currentTime)} / ${clock(player.duration)}`);
    document.querySelector('#result-current').textContent = clock(player.currentTime);
    document.querySelector('#result-duration').textContent = clock(player.duration);
    document.querySelector('#play-icon').textContent = player.paused ? '▶' : 'Ⅱ';
    play.setAttribute('aria-label', player.paused ? '노래 재생' : '일시 정지');
    mute.setAttribute('aria-pressed', String(player.muted));
    mute.setAttribute('aria-label', player.muted ? '음소거 해제' : '음소거');
    mute.textContent = player.muted ? '소리 끔' : '소리 켬';
  }
  for (const event of ['loadedmetadata', 'durationchange', 'timeupdate', 'play', 'pause', 'ended', 'emptied', 'volumechange']) player.addEventListener(event, sync);
  player.addEventListener('playing', () => { status.textContent = '지금, 당신의 이야기가 흐르고 있어요'; });
  player.addEventListener('pause', () => { status.textContent = player.ended ? '한 번 더 듣고 싶은 이야기' : '이어서 들어보세요'; });
  player.addEventListener('ended', () => { status.textContent = '한 번 더 듣고 싶은 이야기'; });
  player.addEventListener('error', () => { status.textContent = '재생할 수 없어요. 다시 불러와 주세요.'; });
  seek.addEventListener('input', () => {
    if (Number.isFinite(player.duration) && player.duration > 0) { player.currentTime = Number(seek.value) / 100 * player.duration; sync(); }
  });
  mute.addEventListener('click', () => { player.muted = !player.muted; });
  sync();
  return {
    setStatus(message) { status.textContent = message; },
    async toggle() {
      if (!player.paused) { player.pause(); return; }
      try { await player.play(); }
      catch { status.textContent = '재생 버튼을 다시 눌러 주세요.'; }
    },
    reset() { sync(); status.textContent = '재생 버튼을 눌러 들어보세요'; },
  };
}
