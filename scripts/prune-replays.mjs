#!/usr/bin/env node
/**
 * Replay storage is the platform's only unbounded cost item, and the published
 * cost model says the newest REPLAY_RETENTION files are kept. New matches obey
 * that limit on their own; this tool applies the same rule to whatever is
 * already on disk.
 *
 * It DRY-RUNS by default: deleting 15k replays is not something a routine
 * command should do to someone's data. Pass --apply to actually delete.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPLAY_RETENTION } from '../src/costs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.resolve(process.env.AFL_REPLAY_DIR || path.join(ROOT, 'data', 'replays'));
const apply = process.argv.includes('--apply');
const keep = Number(process.env.AFL_REPLAY_KEEP || REPLAY_RETENTION);

if (!fs.existsSync(dir)) {
  console.log(`no replay store at ${dir}`);
  process.exit(0);
}
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => {
  const full = path.join(dir, f);
  const st = fs.statSync(full);
  return { full, name: f, mtimeMs: st.mtimeMs, size: st.size };
});
const total = files.reduce((n, f) => n + f.size, 0);
console.log(`replay store: ${dir}`);
console.log(`  files ${files.length} · ${Math.round(total / 1024 / 1024)} MB · retention ${keep}`);
if (files.length <= keep) {
  console.log('  under the limit: nothing to do');
  process.exit(0);
}
// The schedule still points at these, so they are not candidates whatever the
// file clock says - the same guard the league applies on the write path.
const leaguePath = path.resolve(process.env.AFL_LEAGUE_FILE || path.join(ROOT, 'data', 'league.json'));
let referenced = new Set();
if (fs.existsSync(leaguePath)) {
  try {
    const league = JSON.parse(fs.readFileSync(leaguePath, 'utf8'));
    referenced = new Set((league.matches || []).map((m) => m.matchId).filter(Boolean));
  } catch { /* unreadable league file: nothing counts as referenced */ }
}
const prunable = files.filter((f) => !referenced.has(f.name.replace(/\.jsonl$/, '')));
const protectedFiles = files.length - prunable.length;
console.log(`  still referenced by the schedule: ${protectedFiles} files (never candidates)`);
if (prunable.length <= keep) {
  console.log(`  prunable set is under the limit: nothing to do`);
  process.exit(0);
}
const victims = prunable.sort((a, b) => a.mtimeMs - b.mtimeMs).slice(0, prunable.length - keep);
const freed = victims.reduce((n, f) => n + f.size, 0);
console.log(`  oldest-first candidates: ${victims.length} files · ${Math.round(freed / 1024 / 1024)} MB`);
console.log(`  would keep the newest ${keep} prunable files (oldest kept: ${prunable.sort((a, b) => a.mtimeMs - b.mtimeMs)[victims.length]?.name || '—'})`);
if (!apply) {
  console.log('\ndry run — nothing deleted. Re-run with --apply to prune.');
  process.exit(0);
}
let removed = 0;
for (const v of victims) {
  try { fs.unlinkSync(v.full); removed += 1; } catch { /* raced */ }
}
console.log(`\npruned ${removed} of ${victims.length} candidates; ${files.length - removed} replays remain, ${protectedFiles} of them kept because the schedule still references them.`);
