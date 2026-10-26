import { sha256 } from './storage-import.mjs';

const API = 'https://generativelanguage.googleapis.com/v1beta/interactions/';
const AUDIO_HOSTS = new Set(['generativelanguage.googleapis.com','storage.googleapis.com']);
const AUDIO_LIMIT = 67108864;
const RESPONSE_LIMIT = 96 * 1024 * 1024;

export class RestoreError extends Error {
  constructor(code, httpStatus) {
    super(`기존 음악 조회 실패 (${code}${httpStatus ? `, HTTP ${httpStatus}` : ''}). 새 음악은 생성하지 않았습니다.`);
    this.name = 'RestoreError'; this.code = code; this.httpStatus = httpStatus;
  }
}

function validId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 512
    && !/[\x00-\x20\x7f]/.test(id) && !['.','..'].includes(id);
}

async function readLimited(response, limit) {
  const declared = response.headers.get('Content-Length');
  if (declared !== null && Number(declared) > limit) { await response.body?.cancel(); throw new RestoreError('response_too_large'); }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw new RestoreError('response_too_large');
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
  return bytes;
}

export function validateRecoveryBaseline(baseline) {
  if (!baseline || !validId(baseline.interactionId) || baseline.model !== 'lyria-3.5'
    || typeof baseline.generatedAt !== 'string' || !Number.isFinite(Date.parse(baseline.generatedAt))
    || !Array.isArray(baseline.files) || baseline.files.length < 1 || baseline.files.length > 8) throw new RestoreError('invalid_baseline');
  let total = 0;
  for (const [index,file] of baseline.files.entries()) {
    if (file?.index !== index + 1 || !['audio/mp3','audio/mpeg','audio/wav'].includes(file.mime)
      || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isInteger(file.byteLength)
      || file.byteLength < 1 || file.byteLength > AUDIO_LIMIT) throw new RestoreError('invalid_baseline');
    total += file.byteLength;
  }
  if (total > AUDIO_LIMIT) throw new RestoreError('invalid_baseline');
}

export function createGoogleRestoreClient({ apiKey, fetchImpl = globalThis.fetch, timeoutMs = 60000 }) {
  if (!apiKey?.trim() || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180000) throw new RestoreError('configuration_error');
  async function get(url, limit) {
    try {
      const response = await fetchImpl(url, { method:'GET',
        headers:url.hostname === 'generativelanguage.googleapis.com' ? {'x-goog-api-key':apiKey} : {},
        redirect:'error',signal:AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) { await response.body?.cancel(); throw new RestoreError('http_error',response.status); }
      return await readLimited(response,limit);
    } catch(error) {
      if (error instanceof RestoreError) throw error;
      throw new RestoreError('network_error');
    }
  }
  return Object.freeze({
    async retrieve(baseline) {
      validateRecoveryBaseline(baseline);
      const bytes = await get(new URL(API + encodeURIComponent(baseline.interactionId)),RESPONSE_LIMIT);
      let interaction;
      try { interaction = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new RestoreError('invalid_response'); }
      if (interaction?.id !== baseline.interactionId || interaction?.model !== baseline.model
        || interaction?.status !== 'completed' || Date.parse(interaction?.created) !== Date.parse(baseline.generatedAt)) throw new RestoreError('interaction_mismatch');
      if (!Array.isArray(interaction.steps)) throw new RestoreError('invalid_response');
      const blocks = interaction.steps.filter(step=>step?.type==='model_output')
        .flatMap(step=>Array.isArray(step.content)?step.content:[]).filter(block=>block?.type==='audio');
      if (blocks.length !== baseline.files.length) throw new RestoreError('content_mismatch');
      const restored = [];
      for (const [index,block] of blocks.entries()) {
        const original = baseline.files[index];
        if (block.mime_type !== original.mime) throw new RestoreError('content_mismatch');
        let audio;
        if (typeof block.data === 'string' && block.data.length) {
          if (block.data.length !== Math.ceil(original.byteLength/3)*4
            || !/^[A-Za-z0-9+/]*={0,2}$/.test(block.data)) throw new RestoreError('invalid_audio');
          try {
            const decoded=atob(block.data); audio=new Uint8Array(decoded.length);
            for(let i=0;i<decoded.length;i++)audio[i]=decoded.charCodeAt(i);
          } catch { throw new RestoreError('invalid_audio'); }
        } else if (typeof block.uri === 'string') {
          let url;
          try { url = new URL(block.uri); } catch { throw new RestoreError('invalid_audio_uri'); }
          if (url.protocol !== 'https:' || url.port || url.username || url.password || !AUDIO_HOSTS.has(url.hostname)) throw new RestoreError('invalid_audio_uri');
          audio = await get(url,original.byteLength);
        } else throw new RestoreError('invalid_audio');
        if (audio.byteLength !== original.byteLength || await sha256(audio) !== original.sha256) throw new RestoreError('content_mismatch');
        restored.push({ index:original.index,mime:original.mime,bytes:audio,sha256:original.sha256 });
      }
      return restored;
    },
  });
}
