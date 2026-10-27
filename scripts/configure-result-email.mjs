import { parseArgs } from 'node:util';
import { privateJson } from '../src/gmail-auth.mjs';
import { createStorageBackend } from '../src/supabase-storage.mjs';
import { SONG_ID, hashResultToken } from '../src/identifiers.mjs';
import { publicResultOrigin } from '../src/result-link.mjs';
import { sealResultToken } from '../src/notification-secret.mjs';
import { validEmail } from '../src/gmail-delivery.mjs';

try {
  const { values } = parseArgs({ options: { 'song-id': { type: 'string' }, recipient: { type: 'string' }, 'allow-save': { type: 'boolean', default: false } } });
  if (!values['allow-save']) console.log('메일 발송 없이 기존 결과 페이지의 수신처를 등록합니다. --song-id <UUID> --recipient <EMAIL> --allow-save');
  else {
    const songId = values['song-id'], recipient = values.recipient;
    const sender = process.env.GMAIL_SENDER || 'peter@humansyntax.kr';
    if (!SONG_ID.test(songId ?? '') || !validEmail(recipient) || !validEmail(sender)) throw new Error();
    const origin = publicResultOrigin(process.env.RESULT_PUBLIC_ORIGIN);
    const saved = await privateJson(new URL(`../artifacts/result-links/${songId}.json`, import.meta.url));
    if (saved.songId !== songId || saved.status !== 'issued') throw new Error();
    const sealedToken = sealResultToken({ token: saved.token, key: process.env.RESULT_LINK_ENCRYPTION_KEY, songId, recipient, origin });
    const backend = createStorageBackend({ url: process.env.SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY });
    const result = await backend.configureSongEmail({ songId, tokenHash: await hashResultToken(saved.token), recipient, sender, origin, sealedToken });
    if (result?.result !== 'configured') throw new Error();
    console.log('수신처와 암호화된 페이지 토큰을 서버 전용으로 등록했습니다. 링크 재발급·음악 생성·메일 발송은 실행하지 않았습니다.');
  }
} catch { console.error('완료 안내 수신처 등록 실패. 기존 비공개 링크 파일·공개 HTTPS 주소·암호화 Secret·DB 상태를 확인하세요. 비밀값은 출력하지 않습니다.'); process.exitCode = 1; }
