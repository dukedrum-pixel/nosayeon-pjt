import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const API = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const AUDIO_HOSTS = new Set(['generativelanguage.googleapis.com', 'storage.googleapis.com']);
const MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_PROMPT = 'Create an original two-minute warm Korean acoustic pop song about thanking a friend who stayed beside me through a difficult year. Gentle vocals, acoustic guitar and piano, hopeful chorus. Do not imitate any existing artist or song.';

export class SpikeError extends Error {}

async function save(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

async function readLimited(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BYTES) {
      throw new SpikeError('응답이 64MiB 제한을 초과했어. 자동 재요청하지 않아.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createClient({ apiKey, fetchImpl = globalThis.fetch }) {
  if (!apiKey?.trim()) throw new SpikeError('GEMINI_API_KEY Secret 설정이 필요해. 키를 채팅에 보내지 마.');
  async function request(url, { method = 'GET', body, authenticated = true } = {}) {
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          ...(authenticated ? { 'x-goog-api-key': apiKey } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(180_000),
      });
      if (!response.ok) {
        // 서버 본문에는 입력이나 키가 포함될 수 있으므로 로그에 출력하지 않는다.
        await response.body?.cancel();
        throw new SpikeError(`Google 요청 실패 (HTTP ${response.status}). 자동 재시도하지 않아.`);
      }
      return await readLimited(response);
    } catch (error) {
      if (error instanceof SpikeError) throw error;
      // fetch 예외에도 URL/토큰이 들어갈 수 있다.
      throw new SpikeError('Google 연결 또는 응답 처리 실패. 네트워크 정책과 연결을 확인해. 생성 요청은 자동 재전송하지 않아.');
    }
  }
  async function json(url, options) {
    const bytes = await request(url, options);
    try { return JSON.parse(bytes.toString('utf8')); }
    catch { throw new SpikeError('Google 응답이 유효한 JSON이 아니야.'); }
  }
  return {
    create: (prompt) => json(API, {
      method: 'POST', body: { model: 'lyria-3.5', input: prompt, store: true },
    }),
    get: (id) => json(`${API}/${encodeURIComponent(id)}`),
    audio: (uri) => {
      let url;
      try { url = new URL(uri); } catch { throw new SpikeError('잘못된 오디오 URI야.'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !AUDIO_HOSTS.has(url.hostname)) {
        throw new SpikeError('오디오 URI 호스트를 검토해야 해. 허용되지 않은 주소로는 접속하지 않아.');
      }
      return request(url, { authenticated: url.hostname === 'generativelanguage.googleapis.com' });
    },
  };
}

export function audioBlocks(interaction) {
  // get 응답에는 user_input도 포함된다. 생성된 model_output만 비교한다.
  return (interaction.steps ?? [])
    .filter((step) => step.type === 'model_output')
    .flatMap((step) => Array.isArray(step.content) ? step.content : [])
    .filter((block) => block.type === 'audio');
}

export async function extractAudio(interaction, client) {
  const blocks = audioBlocks(interaction);
  if (!blocks.length) throw new SpikeError('생성 오디오가 없어. 응답 구조 또는 안전 필터를 확인해야 해.');
  const files = [];
  for (const block of blocks) {
    const mime = block.mime_type;
    if (!['audio/mp3', 'audio/mpeg', 'audio/wav'].includes(mime)) {
      throw new SpikeError('지원하지 않는 오디오 MIME 형식이야. 응답 스키마를 검토해야 해.');
    }
    let bytes;
    if (typeof block.data === 'string' && block.data.length) {
      const padding=block.data.endsWith('==')?2:block.data.endsWith('=')?1:0;
      // A repeated four-character group over multi-MB audio can overflow V8's regexp stack.
      if (block.data.length > Math.ceil(MAX_BYTES / 3) * 4 || block.data.length%4!==0
        || /[^A-Za-z0-9+/]/.test(block.data.slice(0,block.data.length-padding))) {
        throw new SpikeError('오디오 Base64 형식 또는 크기가 올바르지 않아.');
      }
      bytes = Buffer.from(block.data, 'base64');
    } else if (typeof block.uri === 'string') {
      bytes = await client.audio(block.uri);
    } else {
      throw new SpikeError('오디오 데이터와 URI가 모두 없어.');
    }
    if (!bytes.length) throw new SpikeError('빈 오디오 파일이 반환됐어.');
    files.push({ bytes, mime, source: block.data ? 'inline' : 'uri', sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return files;
}

async function completed(initial, client, checkpoint, { wait = delay, maxPolls = 120 } = {}) {
  let current = initial;
  for (let attempt = 0; ; attempt++) {
    if (current.status === 'completed') return current;
    if (current.status !== 'in_progress') throw new SpikeError('Interaction이 완료되지 않았어. 로컬 응답 파일의 상태를 확인해. 새 곡은 생성하지 않아.');
    if (attempt >= maxPolls) throw new SpikeError('조회 대기 시간이 끝났어. resume으로 같은 Interaction을 다시 조회해.');
    await wait(5000);
    current = await client.get(initial.id);
    if (current.id !== initial.id) throw new SpikeError('대기 중 조회된 Interaction ID가 일치하지 않아.');
    await save(checkpoint, current);
  }
}

async function exists(path) {
  try { await access(path); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function audioFiles(dir, prefix, files) {
  const metadata = [];
  for (const [i, file] of files.entries()) {
    const name = `${prefix}-${i + 1}.${file.mime === 'audio/wav' ? 'wav' : 'mp3'}`;
    await writeFile(join(dir, name), file.bytes, { mode: 0o600 });
    metadata.push({ file: name, bytes: file.bytes.length, mime: file.mime, source: file.source, sha256: file.sha256 });
  }
  return metadata;
}

export async function runSpike({ client, root = 'artifacts/lyria', resume, prompt = DEFAULT_PROMPT, onProgress = () => {}, pollOptions }) {
  let dir = resume;
  let initial;
  if (!resume) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    dir = await mkdtemp(join(root, 'run-'));
    onProgress(`검증 폴더: ${dir}`);
    // 응답을 받지 못해도 생성됐을 수 있다. 이 표식을 남겨 무조건 재생성하는 것을 막는다.
    await save(join(dir, 'request.json'), { model: 'lyria-3.5', prompt, started_at: new Date().toISOString(), status: 'sending_once' });
    const start = performance.now();
    initial = await client.create(prompt); // POST는 정확히 1회. 재시도 없음.
    await save(join(dir, 'created.json'), initial);
    await save(join(dir, 'timing.json'), { create_response_ms: Math.round(performance.now() - start) });
  } else {
    if (!await exists(join(dir, 'created.json'))) {
      throw new SpikeError('생성 응답 파일이 없어. Google AI Studio에서 생성 여부를 먼저 확인해. 자동 재생성하지 않아.');
    }
    initial = JSON.parse(await readFile(join(dir, 'created.json'), 'utf8'));
  }
  if (typeof initial.id !== 'string' || !initial.id) throw new SpikeError('Interaction ID가 없어. 생성 응답을 확인해야 해.');
  const baselinePath = join(dir, 'baseline.json');
  let baseline;
  if (await exists(baselinePath)) {
    baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
    // 기존 비교 기준은 절대 재조회 데이터로 바꾸지 않는다.
    for (const file of baseline.files) {
      const bytes = await readFile(join(dir, file.file));
      if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new SpikeError('최초 오디오 파일이 변경됐어. 비교를 중단해.');
    }
  } else {
    let first;
    const firstPath = join(dir, 'first-completed.json');
    if (await exists(firstPath)) first = JSON.parse(await readFile(firstPath, 'utf8'));
    else {
      first = await completed(initial, client, join(dir, 'poll.json'), pollOptions);
      await save(firstPath, first);
    }
    const original = await extractAudio(first, client);
    baseline = { interaction_id: initial.id, captured_at: new Date().toISOString(), files: await audioFiles(dir, 'original', original) };
    await save(baselinePath, baseline);
  }
  onProgress('최초 오디오 확보 완료. 같은 Interaction을 재조회할게.');
  const start = performance.now();
  const retrieved = await client.get(initial.id);
  await save(join(dir, 'retrieved.json'), retrieved);
  if (retrieved.id !== initial.id || retrieved.status !== 'completed') throw new SpikeError('재조회한 Interaction ID 또는 완료 상태가 일치하지 않아.');
  const restored = await extractAudio(retrieved, client);
  const restoredFiles = await audioFiles(dir, 'restored', restored);
  const same = baseline.files.length === restoredFiles.length && baseline.files.every((file, index) => file.sha256 === restoredFiles[index].sha256 && file.mime === restoredFiles[index].mime);
  const report = {
    checked_at: new Date().toISOString(), interaction_id: initial.id, model: 'lyria-3.5',
    result: same ? 'identical' : 'different', retrieve_ms: Math.round(performance.now() - start),
    baseline_captured_at: baseline.captured_at, original: baseline.files, restored: restoredFiles,
    limitation: '이번 조회 시점의 바이트 동일성만 확인한다. 50일 후 복구 가능 여부나 과금액을 보장하지 않는다.',
  };
  await save(join(dir, 'report.json'), report);
  return { dir, report };
}
