import { mkdir, writeFile } from 'node:fs/promises';
import { buildResultNotificationMail } from '../src/result-notification-mail.mjs';
// Reserved example domain and synthetic capability only. No network/DB/mail.
const root = new URL('../artifacts/result-email-preview/', import.meta.url);
await mkdir(root, { recursive: true, mode: 0o700 });
for (const event of ['initial_ready', 'reissue_ready']) {
  const message = buildResultNotificationMail({ origin: 'https://music.example.com', songId: '11111111-1111-4111-8111-111111111111',
    token: 'a'.repeat(43), expiresAt: '2026-11-04T14:59:00Z', event });
  await writeFile(new URL(`${event}.html`, root), message.html, { mode: 0o600 });
  await writeFile(new URL(`${event}.txt`, root), message.text, { mode: 0o600 });
}
console.log('예시 메일 2종을 artifacts/result-email-preview에 저장했습니다. 실제 발송·DB 요청은 없습니다.');
