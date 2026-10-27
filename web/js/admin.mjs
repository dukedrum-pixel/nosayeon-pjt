const $ = id => document.getElementById(id);
let token = '', session = 0, offset = 0, filterId = null, rows = [], selected = null, blobUrl = null;
let emailReady = false, operationId = null, busy = false;
const labels = { stored: '저장 완료', deleted: '파일 삭제됨', pending: '저장 대기', storing: '저장 중', failed: '실패',
  idle: '대기', restoring: '복구 중', prepared: '파일 준비 · 미발송', sending: '처리 중 · 결과 확인 필요', sent: 'Gmail 접수 완료', unknown: '발송 결과 불명', pending_setup: '설정 대기 · 미발송', skipped: '기간·차수 변경 · 미발송' };
const errors = { unauthorized: '관리자 인증을 확인해 주세요.', content_mismatch: '원본과 다른 파일입니다. 크기와 SHA-256이 모두 일치해야 합니다.',
  retention_ended: '최초 생성 후 50일이 지나 직접 전달을 준비할 수 없습니다.', mp3_required: '등록된 MP3 원본을 선택해 주세요.',
  busy: '다른 파일을 처리 중입니다. 잠시 후 다시 시도해 주세요.', invalid_request: '곡 ID와 입력 내용을 확인해 주세요.',
  email_not_configured: 'Gmail 발송 인증이 아직 연결되지 않았습니다.', email_too_large: '메일 첨부는 MP3 18 MiB 이하만 지원합니다.',
  duplicate_or_conflict: '같은 발송 요청이 이미 기록되어 있습니다. 이력과 Gmail 보낸편지함을 확인해 주세요.',
  mail_auth_failed: 'Gmail 인증에 실패했습니다. 발신 계정 연결을 확인해 주세요.', mail_rejected: 'Gmail에서 요청을 처리하지 못했습니다. 이력을 확인해 주세요.',
  mail_result_unknown: '발송 결과가 불분명합니다. 재발송 전에 이력과 Gmail 보낸편지함을 확인해 주세요.' };
const text = (id, value) => { $(id).textContent = value; };
const date = value => value ? new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false }) : '—';
const size = n => !Number.isFinite(Number(n)) ? '—' : Number(n) >= 1048576 ? `${(Number(n) / 1048576).toFixed(2)} MiB` : `${Number(n).toLocaleString('ko-KR')} B`;
const message = value => text('message', value);
function clearFile() {
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = null; $('prepared-download').removeAttribute('href'); $('prepared').hidden = true;
}
function resetOperation() { operationId = null; clearFile(); }
async function api(path, options = {}) {
  const current = session;
  let response;
  try { response = await fetch(path, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` }, cache: 'no-store', redirect: 'error' }); }
  catch { throw new Error('연결이 끊겼습니다. 발송 중이었다면 이력과 보낸편지함을 확인한 후 처리해 주세요.'); }
  if (current !== session) throw new Error('인증 상태가 변경되었습니다.');
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) logout();
    throw new Error(errors[data.error] ?? '요청을 완료하지 못했습니다. 설정과 연결 상태를 확인해 주세요.');
  }
  return response;
}
function capacity(prefix, used, limit, unknown = false) {
  text(`${prefix}-used`, `${size(used)} 사용`);
  const meter = $(`${prefix}-meter`);
  meter.hidden = !limit || unknown;
  if (limit && !unknown) {
    const remaining = limit - Number(used);
    text(`${prefix}-remaining`, remaining >= 0 ? `설정 기준 잔여 ${size(remaining)} / ${size(limit)}` : `설정 기준 ${size(-remaining)} 초과 / ${size(limit)}`);
    meter.value = Math.min(100, Number(used) / limit * 100);
  } else text(`${prefix}-remaining`, unknown ? '일부 파일 크기 미확인 · 잔여 용량 산정 불가' : '잔여 용량: 요금제 기준 용량 미설정');
}
async function dashboard() {
  const data = await (await api('/api/admin/dashboard')).json();
  text('requests', data.registeredRequests.toLocaleString('ko-KR'));
  text('generated', data.generated.toLocaleString('ko-KR'));
  text('stored', data.stored.toLocaleString('ko-KR'));
  text('reissues', data.reissueRequests.toLocaleString('ko-KR'));
  text('failures', `저장 실패 ${data.storageFailed} · 복구 실패 ${data.restoreFailed}`);
  text('restoring', `현재 복구 중 ${data.restoring}건`);
  text('observed', `${date(data.observedAt)} KST 기준`);
  capacity('db', data.databaseBytes, data.databaseCapacityBytes);
  capacity('storage', data.storageBytes, data.storageCapacityBytes, data.unknownStorageSizes > 0);
  text('audio-used', `이 프로젝트 전체 파일 중 음악 ${size(data.audioBytes)}. 조직 전체 사용량·청구액과는 다릅니다.`);
  text('notification-count', `고객 안내 대기·실패 ${data.pendingNotifications}건 · 접수 ${data.notificationsAccepted ?? 0}건 · 확인 필요 ${data.notificationsUncertain ?? 0}건`);
  text('result-email-state', data.integrations.resultEmail === 'enabled' ? '신규 안내 활성' : '신규 안내 비활성');
  text('manual-count', `파일 준비 ${data.manualPrepared} · Gmail 접수 ${data.manualEmailAccepted} · 확인 필요 ${data.manualEmailUncertain}`);
  emailReady = data.integrations.email === 'configured';
  text('email-connection', emailReady ? 'Gmail 인증 설정됨' : 'Gmail 인증 미연결');
  text('email-setup', `발신: ${data.integrations.sender} · ${emailReady ? '원본 검증 후 MP3를 첨부해 발송합니다. Gmail 18 MiB 첨부 제한을 적용합니다.' : '앱 전용 OAuth 인증 연결 후 발송할 수 있습니다. 지금은 파일 준비만 가능합니다.'}`);
  $('send-email').disabled = !emailReady || busy;
}
function cell(row, value, className) {
  const td = document.createElement('td');
  if (value instanceof Node) td.append(value); else td.textContent = value;
  if (className) td.className = className;
  row.append(td); return td;
}
function pill(value, warn = false) {
  const span = document.createElement('span'); span.className = `pill${warn ? ' warn' : ''}`; span.textContent = value; return span;
}
function linkFor(song) { return Array.isArray(song.song_result_links) ? song.song_result_links[0] : song.song_result_links; }
async function songs() {
  const params = new URLSearchParams({ offset, ...(filterId ? { id: filterId } : {}) });
  const data = await (await api(`/api/admin/songs?${params}`)).json();
  rows = data.songs;
  $('songs').replaceChildren();
  for (const song of rows) {
    const tr = document.createElement('tr');
    const identity = document.createElement('div'); identity.className = 'mono'; identity.textContent = song.id;
    const created = document.createElement('small'); created.textContent = date(song.generated_at); identity.append(created);
    cell(tr, identity); cell(tr, pill(labels[song.storage_status] ?? '확인 필요', ['failed', 'deleted'].includes(song.storage_status)));
    const link = linkFor(song);
    const state = !link ? '페이지 미발급' : link.revoked_at ? '접근 종료' : link.restore_status === 'failed' ? '복구 실패' : link.restore_status === 'restoring' ? '복구 중' : link.consumed_at ? '사용 완료' : Date.parse(link.expires_at) <= Date.now() ? '만료' : `차수 ${link.delivery_version} · 유효`;
    cell(tr, state);
    cell(tr, `${song.song_files.length}개 · ${size(song.song_files.reduce((n, f) => n + f.byte_length, 0))}`);
    const button = document.createElement('button'); button.type = 'button'; button.textContent = '백업 MP3';
    const eligible = Date.parse(song.generated_at) <= Date.now() && Date.now() < Date.parse(song.generated_at) + 50 * 86400000;
    button.disabled = !eligible || busy || !song.song_files.some(f => ['audio/mpeg', 'audio/mp3'].includes(f.mime_type));
    if (!eligible) button.title = '최초 생성 후 50일 이내만 지원합니다.';
    button.addEventListener('click', () => selectSong(song)); cell(tr, button); $('songs').append(tr);
  }
  if (!rows.length) { const tr = document.createElement('tr'); const td = cell(tr, '조회된 음악이 없습니다.'); td.colSpan = 5; $('songs').append(tr); }
  $('previous').disabled = !offset; $('next').disabled = !data.hasMore;
  text('page-number', `${Math.floor(offset / 20) + 1} 페이지`);
}
function selectedFile() { return selected?.song_files.find(f => f.file_index === Number($('file-index').value)); }
function fileDetails() {
  const file = selectedFile();
  text('expected-file', file ? `${size(file.byte_length)} · SHA-256 ${file.sha256}` : ''); resetOperation();
}
function selectSong(song) {
  if (busy) return;
  selected = song; clearFile(); operationId = null;
  $('prepare-form').reset(); $('file-index').replaceChildren();
  for (const file of song.song_files.filter(f => ['audio/mpeg', 'audio/mp3'].includes(f.mime_type))) {
    const option = document.createElement('option'); option.value = file.file_index; option.textContent = `원본 ${file.file_index} · ${size(file.byte_length)}`; $('file-index').append(option);
  }
  text('selected-song', `곡 ${song.id} · ${date(song.generated_at)} KST`);
  fileDetails(); $('delivery').hidden = false; $('delivery').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function history() {
  const data = await (await api('/api/admin/history')).json();
  $('history').replaceChildren();
  for (const item of data.exports) {
    const row = document.createElement('tr'); cell(row, date(item.created_at)); cell(row, item.song_id, 'mono');
    cell(row, `원본 ${item.file_index} · ${item.channel === 'email' ? '이메일' : '카카오'}`);
    cell(row, pill(labels[item.status] ?? '확인 필요', item.status !== 'sent')); $('history').append(row);
  }
  if (!data.exports.length) { const row = document.createElement('tr'); const td = cell(row, '직접 전달 이력이 없습니다.'); td.colSpan = 4; $('history').append(row); }
}
async function notificationHistory() {
  const data = await (await api('/api/admin/notifications')).json();
  $('notification-history').replaceChildren();
  for (const item of data.notifications) {
    const row = document.createElement('tr');
    cell(row, date(item.created_at)); cell(row, item.song_id, 'mono');
    cell(row, `차수 ${item.delivery_version} · ${item.event === 'initial_ready' ? '최초 완료' : '재신청 완료'}`);
    cell(row, pill(labels[item.status] ?? '대기 · 미발송', ['failed', 'unknown', 'sending'].includes(item.status)));
    $('notification-history').append(row);
  }
  if (!data.notifications.length) { const row = document.createElement('tr'); const td = cell(row, '고객 완료 안내 이력이 없습니다.'); td.colSpan = 4; $('notification-history').append(row); }
}
async function refresh() { message(''); await Promise.all([dashboard(), songs(), history(), notificationHistory()]); }
async function login(value) {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(value)) { message('올바른 관리자 인증 파일 또는 토큰을 사용해 주세요.'); return; }
  token = value; session++; $('access-token').value = ''; $('credential').value = '';
  try { await refresh(); $('login').hidden = true; $('workspace').hidden = false; $('logout').hidden = false; }
  catch (error) { logout(); message(error.message); }
}
function logout() {
  token = ''; session++; selected = null; rows = []; offset = 0; filterId = null; emailReady = false; operationId = null;
  $('workspace').hidden = true; $('login').hidden = false; $('logout').hidden = true; $('delivery').hidden = true;
  $('songs').replaceChildren(); $('history').replaceChildren(); $('notification-history').replaceChildren(); $('prepare-form').reset(); $('file-index').replaceChildren();
  $('access-token').value = ''; $('credential').value = ''; clearFile();
}
async function prepare(send = false) {
  if (busy || !selected) return;
  const file = $('backup-file').files[0], metadata = selectedFile();
  if (!file || !metadata || file.size !== metadata.byte_length) { message(errors.content_mismatch); return; }
  const recipient = $('recipient').value.trim();
  if (send && (!$('recipient').checkValidity() || !recipient)) { message('받는 사람 이메일 주소를 확인해 주세요.'); return; }
  busy = true; $('prepare-button').disabled = true; $('send-email').disabled = true;
  for (const input of $('prepare-form').querySelectorAll('input,select')) input.disabled = true;
  message(''); clearFile();
  const current = session;
  try {
    const params = new URLSearchParams({ id: selected.id, index: metadata.file_index, channel: $('channel').value });
    const extraHeaders = { 'Content-Type': 'application/octet-stream' };
    if (send) { operationId ??= crypto.randomUUID(); extraHeaders['Idempotency-Key'] = operationId; extraHeaders['X-Delivery-To'] = recipient; }
    const response = await api(`/api/admin/${send ? 'send-email' : 'prepare'}?${params}`, { method: 'POST', body: file, headers: extraHeaders });
    if (send) { const result = await response.json(); message(`Gmail이 발송 요청을 접수했습니다. 고객 수신 완료를 뜻하지 않습니다. 참조 ${result.reference}`); }
    else {
      const blob = await response.blob(); if (current !== session) return;
      blobUrl = URL.createObjectURL(blob); $('prepared-download').href = blobUrl;
      $('prepared-download').download = `nosayeon-${selected.id}-${metadata.file_index}.mp3`;
      text('preparation-reference', `준비 기록 ${response.headers.get('X-Preparation-Id')}`); $('prepared').hidden = false;
    }
  } catch (error) { if (current === session) message(error.message); }
  finally {
    busy = false; $('prepare-button').disabled = false; $('send-email').disabled = !emailReady;
    for (const input of $('prepare-form').querySelectorAll('input,select')) input.disabled = false;
    if (current === session && token) await Promise.all([dashboard(), history()]).catch(() => {});
  }
}
$('login-form').addEventListener('submit', event => { event.preventDefault(); void login($('access-token').value); });
$('credential').addEventListener('change', async () => {
  const file = $('credential').files[0]; if (!file) return;
  try { if (file.size > 2048) throw new Error(); await login(JSON.parse(await file.text()).token); }
  catch { message('서버가 발급한 관리자 access.json 파일을 선택해 주세요.'); }
});
$('logout').addEventListener('click', logout);
$('refresh').addEventListener('click', () => void refresh().catch(error => message(error.message)));
$('search-form').addEventListener('submit', event => { event.preventDefault(); filterId = $('search-id').value.trim() || null; offset = 0; void songs().catch(error => message(error.message)); });
$('clear-search').addEventListener('click', () => { filterId = null; offset = 0; $('search-id').value = ''; void songs().catch(error => message(error.message)); });
$('previous').addEventListener('click', () => { offset = Math.max(0, offset - 20); void songs().catch(error => message(error.message)); });
$('next').addEventListener('click', () => { offset += 20; void songs().catch(error => message(error.message)); });
$('close-delivery').addEventListener('click', () => { if (!busy) { $('delivery').hidden = true; selected = null; clearFile(); } });
$('file-index').addEventListener('change', fileDetails);
$('backup-file').addEventListener('change', resetOperation);
$('recipient').addEventListener('input', resetOperation);
$('prepare-form').addEventListener('submit', event => { event.preventDefault(); void prepare(); });
$('send-email').addEventListener('click', () => void prepare(true));
window.addEventListener('pagehide', logout);
