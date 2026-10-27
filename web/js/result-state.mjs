// Presentation only. The server must authenticate the link and authorize every
// playback, download and restore request independently of this view model.
const COPY = Object.freeze({
  available: ['노래가 준비되었습니다', '당신의 사연을 담은 노래를 만나보세요.'],
  consumed: ['노래를 잘 간직해 주세요', '다운로드가 사용 완료되었어요. 저장된 파일은 내 기기에서 들을 수 있어요.'],
  expired: ['다운로드 기간이 지났어요', '같은 음악이 다시 필요하다면, 재신청 가능 여부를 확인해 주세요.'],
  retention_ended: ['음악 보관기간이 종료되었습니다', '이 음악의 다운로드 링크를 다시 신청할 수 없습니다.'],
  processing: ['노래를 준비하고 있습니다', '이 페이지에서 잠시 기다려 주세요. 준비가 끝나면 자동으로 표시됩니다.'],
  restore_failed:['음악을 다시 준비하지 못했습니다','새 음악은 생성하지 않았습니다. 다시 신청해 주세요.'],
  invalid_link: ['결과 링크를 확인해 주세요', '유효한 결과 링크로 다시 접속해 주세요.'],
  error: ['결과를 불러오지 못했습니다', '잠시 후 다시 확인해 주세요.'],
});

export function buildResultView(snapshot, now = Date.now()) {
  let status = snapshot?.status;
  if (typeof status !== 'string' || !Object.hasOwn(COPY, status) || !Number.isFinite(now)) status = 'error';
  let expiresAt = null;
  if (status === 'available') {
    const value = snapshot.expiresAt;
    const parsed = typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
    if (!Number.isFinite(parsed)) status = 'error';
    else if (parsed <= now) status = 'expired';
    else expiresAt = new Date(parsed).toISOString();
  }
  const [heading, message] = COPY[status];
  return Object.freeze({
    status, heading, message, expiresAt,
    showPlayer: status === 'available',
    showDownload: status === 'available',
    showRestore: ['available','consumed','expired','restore_failed'].includes(status) && snapshot?.canRestore === true
      && (!snapshot.restoreDeadline || Date.parse(snapshot.restoreDeadline)>now),
  });
}
