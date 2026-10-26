import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';

const staticFiles = new Map([
  ['/', ['index.html', 'text/html']],
  ['/index.html', ['index.html', 'text/html']],
  ['/result.html', ['result.html', 'text/html']],
  ['/result-preview.html', ['result-preview.html', 'text/html']],
  ['/admin.html', ['admin.html', 'text/html']],
  ['/admin.css', ['admin.css', 'text/css']],
  ['/js/admin.mjs', ['js/admin.mjs', 'text/javascript']],
  ['/styles.css', ['styles.css', 'text/css']],
  ...['app', 'prompt-builder', 'result-state', 'result-preview', 'result-page'].map(name =>
    [`/js/${name}.mjs`, [`js/${name}.mjs`, 'text/javascript']]),
]);

export function createResultServer({ handler, adminHandler, afterDownloadResponse = async () => {}, webRoot = new URL('../web/', import.meta.url) }) {
  return createServer(async (req, res) => {
    const safeHeaders = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
    try {
      const port = req.socket.localPort;
      const host = req.headers.host;
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)) {
        res.writeHead(403, safeHeaders).end(); return;
      }
      const origin = `http://${host}`;
      if (req.headers.origin && req.headers.origin !== origin) {
        res.writeHead(403, safeHeaders).end(); return;
      }
      const url = new URL(req.url, origin);
      if (url.pathname.startsWith('/api/')) {
        const isAdmin = url.pathname.startsWith('/api/admin/');
        if (isAdmin) req.setTimeout(60000, () => req.destroy());
        if (isAdmin && (!adminHandler || !adminHandler.authorized({ headers: new Headers({ Authorization: req.headers.authorization ?? '' }) }))) {
          res.writeHead(401, { ...safeHeaders, 'Connection': 'close' }).end(); return;
        }
        const controller = new AbortController();
        const disconnected = () => { if (!res.writableFinished) controller.abort(); };
        res.once('close', disconnected);
        const response = await (isAdmin ? adminHandler : handler)(new Request(url, { method: req.method,
          headers: { Authorization: req.headers.authorization ?? '',
            ...(isAdmin && req.headers['idempotency-key'] ? { 'Idempotency-Key': req.headers['idempotency-key'] } : {}),
            ...(isAdmin && req.headers['x-delivery-to'] ? { 'X-Delivery-To': req.headers['x-delivery-to'] } : {}),
            ...(isAdmin && req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {}),
            ...(isAdmin && req.headers['content-length'] ? { 'Content-Length': req.headers['content-length'] } : {}) },
          ...(isAdmin && req.method === 'POST' ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
          signal: controller.signal }));
        const bytes = Buffer.from(await response.arrayBuffer());
        if (url.pathname === '/api/download' && response.status === 200) {
          let called = false;
          const cleanup = () => {
            if (called) return; called = true;
            Promise.resolve().then(() => afterDownloadResponse(url.searchParams.get('id'))).catch(() => {});
          };
          res.once('finish', cleanup); res.once('close', cleanup);
          if (res.destroyed) cleanup();
        }
        if (res.destroyed) return;
        if (isAdmin && req.method === 'POST' && !req.complete) res.setHeader('Connection', 'close');
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(bytes);
        return;
      }
      const file = staticFiles.get(url.pathname);
      if (!file || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404, safeHeaders).end(); return; }
      const bytes = await readFile(new URL(file[0], webRoot));
      res.writeHead(200, { ...safeHeaders, 'Content-Type': `${file[1]}; charset=utf-8`,
        'Content-Security-Policy': "default-src 'self'; connect-src 'self'; media-src blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch { if (!res.headersSent && !res.destroyed) res.writeHead(503, safeHeaders).end(); else res.destroy(); }
  });
}
