import { mkdir, open, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { createStorageBackend } from '../src/supabase-storage.mjs';
import { loadGmailConfiguration } from '../src/gmail-auth.mjs';
import { createGmailDelivery } from '../src/gmail-delivery.mjs';
import { createAdminHandler } from '../src/admin-access.mjs';
import { validateAudioFiles, readVerifiedAudio } from '../src/audio-files.mjs';

// Explicitly authorized sender/recipient and existing original only. No generation,
// customer download claim, deletion, public listener or automatic retry.
const songId = 'c7ed78ea-453a-41ce-84cd-ad185a031f3b';
const expectedHash = 'bd4905f2f0b26e675b154e11e1a59851c6f13c987dbf0880487f54d442fda102';
const recipient = 'dukedrum@gmail.com';
const statePath = new URL('../artifacts/gmail-live/send-state.json', import.meta.url);
const reportPath = new URL('../artifacts/gmail-live/send-report.json', import.meta.url);

if (process.argv.slice(2).join(' ') !== '--send-authorized-test') {
  console.log('기존 MP3 첨부 테스트 전용. 인증·네트워크 확인 후 --send-authorized-test로 실행합니다. 기본 실행은 발송하지 않습니다.');
} else {
  try {
    const configuration = await loadGmailConfiguration();
    if (!configuration || configuration.sender.toLowerCase() !== 'peter@humansyntax.kr') throw new Error();
    const mailer = createGmailDelivery(configuration);
    await mailer.checkConnection();
    const backend = createStorageBackend({ url: process.env.SUPABASE_URL || 'https://fuvgpqkyhuyanbfavwcg.supabase.co', serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY });
    const files = validateAudioFiles(await backend.files(songId), songId);
    if (files.length !== 1 || files[0].sha256 !== expectedHash || files[0].byte_length !== 3021074 || !['audio/mpeg','audio/mp3'].includes(files[0].mime_type)) throw new Error();
    const bytes = await readVerifiedAudio(backend, files[0]);
    const accessToken = randomBytes(32).toString('base64url');
    const handler = createAdminHandler({ backend, accessToken, mailer });
    const operationId = randomUUID();
    await mkdir(new URL('../artifacts/gmail-live/', import.meta.url), { recursive: true, mode: 0o700 });
    // Exclusive creation blocks accidental re-execution, including after response
    // loss. Inspect the existing state and DB operation_id before any new send.
    const state = { operationId, songId, recipient, sha256: expectedHash, byteLength: bytes.length, startedAt: new Date().toISOString(), status: 'attempt_reserved' };
    const file = await open(statePath, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(state, null, 2)); await file.sync(); }
    finally { await file.close(); }
    const response = await handler(new Request(`http://127.0.0.1/api/admin/send-email?id=${songId}&index=1&channel=email`, {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/octet-stream', 'Idempotency-Key': operationId, 'X-Delivery-To': recipient }, body: bytes,
    }));
    const result = await response.json();
    const report = { ...state, status: result.status ?? 'not_confirmed', httpStatus: response.status,
      reference: result.reference ?? null, errorCode: result.error ?? null, completedAt: new Date().toISOString(),
      deliveryToInboxVerified: false, receivedAttachmentHashVerified: false };
    await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(report));
    if (!response.ok) process.exitCode = 1;
  } catch {
    console.error('테스트를 완료하지 못했습니다. 인증·발신 계정·네트워크·원본 파일·기존 send-state.json을 확인하세요. 발송 시작 여부를 단정하지 말고 DB 이력을 먼저 확인하세요. 자동 재발송하지 않으며 키·원문 응답은 출력하지 않습니다.');
    process.exitCode = 1;
  }
}
