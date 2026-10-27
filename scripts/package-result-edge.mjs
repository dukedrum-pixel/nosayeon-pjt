import { readFile } from 'node:fs/promises';
export async function resultEdgeFiles() {
  const names = ['supabase-storage', 'storage-import', 'hosted-result-api', 'result-access', 'result-cleanup', 'song-reissue', 'audio-files', 'identifiers', 'lyria-restore'];
  const entry = await readFile(new URL('../supabase/functions/nosayeon-result-api/index.ts', import.meta.url), 'utf8');
  return [{ name: 'index.ts', content: entry.replaceAll('../../../src/', './src/') },
    ...await Promise.all(names.map(async name => ({ name: `src/${name}.mjs`, content: await readFile(new URL(`../src/${name}.mjs`, import.meta.url), 'utf8') })))];
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) console.log(JSON.stringify(await resultEdgeFiles()));
