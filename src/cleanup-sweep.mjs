import { sha256 } from './storage-import.mjs';
import { cleanupResultSong } from './result-cleanup.mjs';
import { SONG_ID } from './identifiers.mjs';

export async function runCleanupSweep({ backend, clock = () => performance.now(), budgetMs = 40000 }) {
  const started = clock();
  const summary = { result: 'completed', scanned: 0, deleted: 0, failed: 0, skipped: 0, deferred: 0, duration_ms: 0 };
  try {
    const candidates = await backend.cleanupCandidates();
    if (!Array.isArray(candidates) || candidates.length > 20
      || candidates.some(row => typeof row?.song_id !== 'string' || !SONG_ID.test(row.song_id))
      || new Set(candidates.map(row => row.song_id)).size !== candidates.length) throw new Error('invalid_candidates');
    summary.scanned = candidates.length;
    for (const [index, row] of candidates.entries()) {
      if (clock() - started >= budgetMs) { summary.deferred = candidates.length - index; break; }
      const result = await cleanupResultSong({ backend, songId: row.song_id });
      if (result.result === 'deleted') summary.deleted++;
      else if (result.result === 'not_claimed') summary.skipped++;
      else summary.failed++;
    }
    if (summary.failed || summary.deferred) summary.result = 'partial';
  } catch { summary.result = 'failed'; }
  summary.duration_ms = Math.max(0, Math.min(300000, Math.round(clock() - started)));
  await backend.recordCleanupRun(summary);
  return summary;
}

export function createCleanupSweepHandler({ backend, clock, budgetMs }) {
  const reply = (value, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
  return async request => {
    if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
    const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('Authorization') ?? '')?.[1];
    if (!token) return reply({ error: 'unauthorized' }, 401);
    try {
      if (await backend.authorizeCleanupJob(await sha256(new TextEncoder().encode(token))) !== true) return reply({ error: 'unauthorized' }, 401);
      // Ignore caller body, IDs, URLs and limits. The DB chooses eligible work.
      const result = await runCleanupSweep({ backend, clock, budgetMs });
      return reply(result, result.result === 'failed' ? 503 : 200);
    } catch { return reply({ error: 'cleanup_unavailable' }, 503); }
  };
}
