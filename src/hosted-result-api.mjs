import { createResultHandler } from './result-access.mjs';
import { cleanupConsumedSong } from './result-cleanup.mjs';

const routes = new Set(['/api/result', '/api/audio', '/api/download', '/api/restore']);
export function createHostedResultApi({ backend, origin, restoreClient, waitUntil = () => {} }) {
  const allowed = new URL(origin);
  if (allowed.protocol !== 'https:' || allowed.origin !== origin) throw new Error('invalid_origin');
  const handle = createResultHandler({ backend, restoreClient });
  return async request => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/nosayeon-result-api(?=\/|$)/, '').replace(/^\/functions\/v1\/nosayeon-result-api(?=\/|$)/, '');
    const suppliedOrigin = request.headers.get('Origin');
    const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Origin',
      ...(suppliedOrigin === origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'Content-Length, Content-Disposition' } : {}) };
    const json = (value, status) => Response.json(value, { status, headers });
    if (suppliedOrigin && suppliedOrigin !== origin) return json({ status: 'forbidden' }, 403);
    if (path !== '/healthz' && !routes.has(path)) return json({ status: 'not_found' }, 404);
    if (request.method === 'OPTIONS') {
      const method = request.headers.get('Access-Control-Request-Method');
      const requestedHeaders = (request.headers.get('Access-Control-Request-Headers') || '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
      if (suppliedOrigin !== origin || !['GET', 'POST'].includes(method) || requestedHeaders.some(value => !['authorization', 'content-type'].includes(value))) return json({ status: 'forbidden' }, 403);
      return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' } });
    }
    if (path === '/healthz') {
      if (request.method !== 'GET') return json({ status: 'not_found' }, 405);
      try {
        await backend.notificationCandidates(1); // Read-only DB readiness; never disclose rows/counts.
        return json({ status: 'ready', database: 'reachable' }, 200);
      } catch { return json({ status: 'unavailable' }, 503); }
    }
    const internal = new URL(`https://result.internal${path}`); internal.search = url.search;
    const response = await handle(new Request(internal, { method: request.method,
      headers: { Authorization: request.headers.get('Authorization') || '' }, signal: request.signal }));
    if (path === '/api/download' && response.ok) {
      // Audio is already verified and buffered. Cleanup is durable even if the client disconnects.
      waitUntil(cleanupConsumedSong({ backend, songId: url.searchParams.get('id') }).catch(() => {}));
    }
    const resultHeaders = new Headers(response.headers);
    for (const [key, value] of Object.entries(headers)) resultHeaders.set(key, value);
    if (resultHeaders.get('Content-Type')?.includes('application/json') && !restoreClient?.retrieve) {
      const data = await response.json();
      if (Object.hasOwn(data, 'canRestore')) data.canRestore = false;
      return new Response(JSON.stringify(data), { status: response.status, headers: resultHeaders });
    }
    return new Response(response.body, { status: response.status, headers: resultHeaders });
  };
}
