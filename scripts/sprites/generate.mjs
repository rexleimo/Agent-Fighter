/**
 * Sprite sheet batch generator.
 *
 * Queue = fighters x sheets. Each raw sheet lands in
 * assets/source/sprites/<fighter>/<sheet>.png. Existing files are skipped, so
 * the run is resumable: re-run after a failure and only missing sheets generate.
 * Concurrency is capped (default 2) to stay polite to the relay.
 *
 * Usage:
 *   REXAI_API_KEY=... node scripts/sprites/generate.mjs [--only ember,tide]
 *     [--sheets base,punch] [--concurrency 2] [--model gpt-image-2-5-sunburst]
 *
 * The key is read from the environment only. Proxy vars (HTTPS_PROXY) are
 * honored by Node's fetch when NODE_USE_ENV_PROXY=1.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIGHTERS } from '../../src/fighters.js';
import { generateImage } from './rexai.mjs';
import { SHEET_IDS, promptFor } from './sheets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'assets', 'source', 'sprites');
const PLATES = path.join(ROOT, 'assets', 'source', 'plates', 'fighters');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const only = arg('--only', '').split(',').map((s) => s.trim()).filter(Boolean);
const sheetArg = arg('--sheets', '').split(',').map((s) => s.trim()).filter(Boolean);
const concurrency = Math.max(1, Math.min(3, Number(arg('--concurrency', '2')) || 2));
const model = arg('--model', 'gpt-image-2-5-sunburst');

const ids = only.length ? only : FIGHTERS.map((f) => f.id);
const sheets = sheetArg.length ? sheetArg : SHEET_IDS;
for (const id of ids) if (!FIGHTERS.some((f) => f.id === id)) throw new Error('unknown fighter: ' + id);
for (const s of sheets) if (!SHEET_IDS.includes(s)) throw new Error('unknown sheet: ' + s);

const queue = [];
for (const id of ids) {
  for (const sheet of sheets) {
    const file = path.join(OUT, id, sheet + '.png');
    if (fs.existsSync(file)) continue;
    queue.push({ id, sheet, file });
  }
}
console.log(`[sprites:gen] ${queue.length} sheet(s) to generate, concurrency=${concurrency}, model=${model}`);

const failures = [];
let done = 0;
async function worker(workerId) {
  while (queue.length) {
    const item = queue.shift();
    const t0 = Date.now();
    const tag = `${item.id}/${item.sheet}`;
    console.log(`[w${workerId}] START ${tag} (${done + failures.length + 1}/${queue.length + done + failures.length + 1})`);
    try {
      const { jobId, buffer } = await generateImage({
        model,
        prompt: promptFor(item.sheet, item.id),
        image: path.join(PLATES, item.id + '.png'),
        size: '1024x1024',
        timeoutMs: 540000,
        onPoll: (status, sec) => {
          if (status === 'succeeded' || status === 'failed' || sec % 20 < 4) {
            console.log(`[w${workerId}] ${tag} ${status} ${sec}s`);
          }
        },
      });
      fs.mkdirSync(path.dirname(item.file), { recursive: true });
      fs.writeFileSync(item.file, buffer);
      done += 1;
      console.log(`[w${workerId}] OK ${tag} job=${jobId} ${Math.round((Date.now() - t0) / 1000)}s bytes=${buffer.length}`);
    } catch (err) {
      failures.push({ ...item, error: err.message });
      console.error(`[w${workerId}] FAIL ${tag}: ${err.message}`);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i + 1)));
console.log(`[sprites:gen] done=${done} failed=${failures.length}`);
if (failures.length) {
  for (const f of failures) console.error('  FAILED ' + f.id + '/' + f.sheet + ': ' + f.error);
  process.exitCode = 1;
}