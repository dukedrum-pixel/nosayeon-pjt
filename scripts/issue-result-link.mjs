import { parseArgs } from 'node:util';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { createStorageBackend } from '../src/supabase-storage.mjs';
import { hashResultToken, SONG_ID } from '../src/result-access.mjs';

async function main() {
  const { values } = parseArgs({ options: { 'song-id': { type: 'string' }, 'allow-link-issue': { type: 'boolean', default: false } } });
  const id = values['song-id'];
  if (!SONG_ID.test(id ?? '') || !values['allow-link-issue']) {
    console.log('기존 저장 음악의 로컬 조회 링크 발급: npm run result:issue -- --song-id <UUID> --allow-link-issue');
    return;
  }
  const backend = createStorageBackend({ url: process.env.SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY });
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const file = `artifacts/result-links/${id}.json`;
  await mkdir('artifacts/result-links', { recursive: true, mode: 0o700 });
  // Preserve recovery material BEFORE the remote request. wx prevents replacing
  // an existing token if a previous request succeeded but its response was lost.
  await writeFile(file, JSON.stringify({ status: 'pending', songId: id, token }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const link = await backend.issueResultLink(id, await hashResultToken(token));
  if (link?.song_id !== id || !Number.isFinite(Date.parse(link.expires_at))) throw new Error('invalid_response');
  await writeFile(`${file}.issued.tmp`, JSON.stringify({ status: 'issued', songId: id, token,
    issuedAt: link.issued_at, expiresAt: link.expires_at,
    url: `http://127.0.0.1:4174/result.html?id=${id}#token=${token}`,
  }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(`${file}.issued.tmp`, file);
  console.log('최초 결과 링크를 artifacts/result-links의 비공개 파일에 저장했습니다. 토큰은 출력하지 않습니다.');
}

main().catch(() => {
  console.error('결과 링크 발급을 완료하지 못했습니다. 비공개 로컬 기록과 DB 상태를 확인해 주세요. 자동 재발급·재생성하지 않습니다.');
  process.exitCode = 1;
});
