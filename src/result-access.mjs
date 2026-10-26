import { validateAudioFiles, readVerifiedAudio, buildAudioDownload } from './audio-files.mjs';
import { SONG_ID,hashResultToken } from './identifiers.mjs';
import { reissueSong } from './song-reissue.mjs';
export { SONG_ID,RESULT_TOKEN,hashResultToken } from './identifiers.mjs';

export function createResultHandler({ backend, restoreClient, clock = Date.now }) {
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
  function json(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
  }
  return async function handle(request) {
    let downloadClaim = null, downloadSong = null;
    try {
      const url = new URL(request.url);
      if (!['/api/result', '/api/audio', '/api/download','/api/restore'].includes(url.pathname)) return json({ status: 'error' }, 404);
      if (request.method !== (['/api/download','/api/restore'].includes(url.pathname) ? 'POST' : 'GET')) return json({ status: 'error' }, 405);
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('Authorization') ?? '')?.[1];
      const id = url.searchParams.get('id');
      if (!SONG_ID.test(id ?? '') || !token) return json({ status: 'invalid_link' }, 401);
      const link = await backend.resultLink(id, await hashResultToken(token));
      if (!link || link.song_id !== id || link.revoked_at || link.page_issued===false) return json({ status: 'invalid_link' }, 401);
      const generated=Date.parse(link.songs?.generated_at),deadline=generated+50*86400000;
      const canRestore=Number.isFinite(generated)&&clock()>=generated&&clock()<deadline;
      const ended=Number.isFinite(generated)&&clock()>=deadline;
      const version=link.delivery_version??0;
      const common={canRestore,deliveryVersion:version,restoreDeadline:Number.isFinite(deadline)?new Date(deadline).toISOString():null,notificationStatus:link.notification_status??'not_sent'};
      const requested=url.searchParams.get('version')??'0';
      if(url.pathname!=='/api/result'&&(!/^(0|[1-9][0-9]{0,9})$/.test(requested)||Number(requested)!==version))return json({status:'stale'},409);
      if(url.pathname==='/api/restore'){
        if(!canRestore)return json({status:'retention_ended',...common},410);
        const result=await reissueSong({backend,restoreClient,songId:id,tokenHash:await hashResultToken(token),version});
        if(result.result==='ready')return json({status:'ready',...result});
        if(['busy','stale'].includes(result.result))return json({status:result.result},409);
        if(result.result==='retention_ended')return json({status:'retention_ended',canRestore:false},410);
        if(result.result==='invalid_link')return json({status:'invalid_link'},401);
        return json({status:'restore_failed',...common},503);
      }
      if(link.restore_status==='restoring'&&Date.parse(link.restore_lease_until)>clock())return json({status:'processing',...common,canRestore:false},409);
      if(link.restore_status==='failed'||link.restore_status==='restoring')return json({status:ended?'retention_ended':'restore_failed',...common},409);
      if (link.consumed_at) return json({ status: ended?'retention_ended':'consumed', ...common }, 410);
      const issued = Date.parse(link.issued_at), expiry = Date.parse(link.expires_at);
      function expired() {
        const now = clock();
        if (!Number.isFinite(now) || !Number.isFinite(issued) || !Number.isFinite(expiry)
          || issued > now || expiry <= issued || expiry - issued > 7 * 86400000) throw new Error('invalid_link_record');
        return now >= expiry;
      }
      if (expired()) return json({ status: ended?'retention_ended':'expired', ...common }, 410);
      if (link.songs?.storage_status !== 'stored') return json({ status: 'processing', canRestore: false }, 409);
      const files = validateAudioFiles(await backend.files(id), id);
      if (expired()) return json({ status: 'expired', canRestore: false }, 410);
      if (url.pathname === '/api/result') {
        return json({ status: 'available', expiresAt: new Date(expiry).toISOString(), ...common,
          files: files.map(file => ({ index: file.file_index, mime: file.mime_type, bytes: file.byte_length })) });
      }
      if (url.pathname === '/api/download') {
        if (request.signal.aborted) throw new Error('disconnected');
        downloadSong = id;
        downloadClaim = backend.claimDownloadVersion?await backend.claimDownloadVersion(id,await hashResultToken(token),version):await backend.claimDownload(id, await hashResultToken(token));
        if (!downloadClaim) return json({ status: 'busy' }, 409);
        const contents = [];
        for (const file of files) {
          if (request.signal.aborted) throw new Error('disconnected');
          contents.push(await readVerifiedAudio(backend, file));
        }
        const bundle = buildAudioDownload(files, contents);
        const response = new Response(bundle.bytes, { headers: { ...headers,
          'Content-Type': bundle.mime, 'Content-Length': String(bundle.bytes.byteLength),
          'Content-Disposition': `attachment; filename="${bundle.filename}"`,
        } });
        if (request.signal.aborted || expired()) throw new Error('unavailable');
        if (!await backend.consumeDownload(id, downloadClaim)) throw new Error('lease_lost');
        // After this commit, transport failure never restores the permission.
        // Durable pending cleanup survives crashes and is retried separately.
        downloadClaim = null;
        return response;
      }
      const index = url.searchParams.get('file');
      if (!/^[1-8]$/.test(index ?? '')) return json({ status: 'error' }, 400);
      const file = files.find(file => file.file_index === Number(index));
      if (!file) return json({ status: 'error' }, 404);
      const bytes = await readVerifiedAudio(backend, file);
      // Storage latency must not allow a request to pass its expiry boundary.
      const current = await backend.resultLink(id, await hashResultToken(token));
      if (!current || current.revoked_at || current.song_id !== id) return json({ status: 'invalid_link' }, 401);
      if (current.consumed_at) return json({ status: 'consumed', canRestore: false }, 410);
      if((current.delivery_version??0)!==version||current.restore_status&&current.restore_status!=='idle')return json({status:'stale'},409);
      if (current.expires_at !== link.expires_at || current.songs?.storage_status !== 'stored') throw new Error('link_changed');
      if (expired()) return json({ status: 'expired', canRestore: false }, 410);
      return new Response(bytes, { headers: { ...headers, 'Content-Type': file.mime_type, 'Content-Length': String(bytes.byteLength) } });
    } catch {
      if (downloadClaim) {
        try { await backend.releaseDownload(downloadSong, downloadClaim); } catch { /* Lease expiry permits manual retry. */ }
      }
      // Never reflect backend exceptions, tokens, paths, prompts or keys.
      return json({ status: 'error' }, 503);
    }
  };
}
