import { isIP } from 'node:net';
import { SONG_ID, RESULT_TOKEN } from './identifiers.mjs';

// This origin is operator configuration, never a request Host or user URL.
export function publicResultOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('invalid_public_origin'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash
    || !url.hostname.includes('.') || isIP(url.hostname.replace(/^\[|\]$/g, ''))
    || /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(url.hostname)
    || ![url.origin, `${url.origin}/`].includes(value)) throw new Error('invalid_public_origin');
  return url.origin;
}

export function buildPublicResultLink({ origin, songId, token }) {
  if (!SONG_ID.test(songId ?? '') || !RESULT_TOKEN.test(token ?? '')) throw new Error('invalid_result_link');
  const url = new URL('/result.html', publicResultOrigin(origin));
  url.searchParams.set('id', songId);
  url.hash = new URLSearchParams({ token }).toString();
  return url.href;
}
