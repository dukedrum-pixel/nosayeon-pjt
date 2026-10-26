import { createStorageBackend } from '../../../src/supabase-storage.mjs';
import { createCleanupSweepHandler } from '../../../src/cleanup-sweep.mjs';

// The gateway JWT check is replaced by a dedicated, random cron token. The
// handler verifies its hash in the database BEFORE selecting or deleting work.
const backend = createStorageBackend({
  url: Deno.env.get('SUPABASE_URL'),
  serviceRoleKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  timeoutMs: 3000,
});
Deno.serve(createCleanupSweepHandler({ backend,budgetMs:20000 }));
