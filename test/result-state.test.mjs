import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResultView } from '../web/js/result-state.mjs';

const now = Date.parse('2026-10-26T15:00:00Z');
const available = { status: 'available', expiresAt: '2026-11-02T15:00:00Z', canRestore: false };

test('유효한 사용 가능 상태에서만 플레이어와 다운로드를 표시한다', () => {
  const view = buildResultView(available, now);
  assert.equal(view.showPlayer, true);
  assert.equal(view.showDownload, true);
  assert.equal(view.showRestore, false);
  for (const status of ['consumed', 'expired', 'retention_ended', 'processing', 'invalid_link', 'error']) {
    const blocked = buildResultView({ status, canRestore: true }, now);
    assert.equal(blocked.showPlayer, false);
    assert.equal(blocked.showDownload, false);
    assert.equal(blocked.expiresAt, null);
  }
});

test('만료 시각에 도달한 순간부터 재생·다운로드를 숨긴다', () => {
  const expiry = Date.parse(available.expiresAt);
  assert.equal(buildResultView(available, expiry - 1).status, 'available');
  const expired = buildResultView({ ...available, canRestore: true }, expiry);
  assert.equal(expired.status, 'expired');
  assert.equal(expired.showPlayer, false);
  assert.equal(expired.showDownload, false);
  assert.equal(expired.showRestore, true);
});

test('재신청 버튼은 서버가 명시적으로 허용한 만료·사용 완료 상태에만 표시한다', () => {
  for (const status of ['consumed', 'expired']) {
    assert.equal(buildResultView({ status, canRestore: true }, now).showRestore, true);
    for (const canRestore of [false, undefined, 'true', 1]) {
      assert.equal(buildResultView({ status, canRestore }, now).showRestore, false);
    }
  }
  for (const status of ['retention_ended', 'processing', 'invalid_link', 'error']) {
    assert.equal(buildResultView({ status, canRestore: true }, now).showRestore, false);
  }
});

test('잘못된 응답·만료일·시계는 오류 화면으로 닫고 원문을 노출하지 않는다', () => {
  for (const snapshot of [null, {}, { status: ['available'] }, { status: {} }, { status: 'toString' }, { status: '<script>secret</script>' },
    { ...available, expiresAt: null }, { ...available, expiresAt: 'invalid' },
    { ...available, expiresAt: '2026-11-02T15:00:00' }]) {
    const view = buildResultView(snapshot, now);
    assert.equal(view.status, 'error');
    assert.equal(view.showPlayer, false);
    assert.equal(view.showDownload, false);
    assert.equal(view.showRestore, false);
    assert.doesNotMatch(JSON.stringify(view), /secret|script/);
  }
  assert.equal(buildResultView(available, NaN).status, 'error');
});

test('화면 모델에 서버의 비밀값·URL·사연을 복사하지 않는다', () => {
  const snapshot = { ...available, token: 'SECRET', audioUrl: 'https://private.example/SECRET', story: 'SECRET', error: 'SECRET' };
  const view = buildResultView(snapshot, now);
  assert.doesNotMatch(JSON.stringify(view), /SECRET/);
  assert.equal(Object.isFrozen(view), true);
  assert.equal(snapshot.token, 'SECRET');
});
