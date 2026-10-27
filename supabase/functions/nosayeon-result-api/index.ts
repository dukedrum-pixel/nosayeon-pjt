import { createStorageBackend } from '../../../src/supabase-storage.mjs';
import { createHostedResultApi } from '../../../src/hosted-result-api.mjs';

const origin = 'https://nosayeon-result-check.cw-lee.chatgpt.site';
// Supabase provisions these runtime secrets. No cloud Secret value is copied here.
const backend = createStorageBackend({ url: Deno.env.get('SUPABASE_URL'), serviceRoleKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') });
const handle = createHostedResultApi({ backend, origin, waitUntil: promise => EdgeRuntime.waitUntil(promise) });
// Restore is disabled until its own runtime setup is verified. No Google generation client.
Deno.serve(request => handle(request).catch(() => Response.json({ status: 'error' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })));
