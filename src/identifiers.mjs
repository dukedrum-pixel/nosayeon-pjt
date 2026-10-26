import { sha256 } from './storage-import.mjs';
export const SONG_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const RESULT_TOKEN=/^[A-Za-z0-9_-]{43}$/;
export async function hashResultToken(token){
  if(!RESULT_TOKEN.test(token))throw new Error('invalid_token');
  return sha256(new TextEncoder().encode(token));
}
