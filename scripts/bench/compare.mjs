#!/usr/bin/env node
// ============================================================================
// Compare two benchmark reports (model A vs model B). Both reports should share
// the same protocol (seeds / opponents / fighter / mode) for the comparison to
// be fair; this prints a warning if they differ.
//
//   node scripts/bench/compare.mjs bench/reports/A.json bench/reports/B.json
// ============================================================================
import fs from 'node:fs';
import { pct } from './stats.mjs';

const [fa, fb] = process.argv.slice(2);
if (!fa || !fb) { console.error('Usage: node scripts/bench/compare.mjs <reportA.json> <reportB.json>'); process.exit(1); }
const a = JSON.parse(fs.readFileSync(fa, 'utf8'));
const b = JSON.parse(fs.readFileSync(fb, 'utf8'));

const sig = (r) => `${r.mode}|${r.protocol.fighter}|${r.protocol.seedCount}|${r.protocol.ticks}|${r.opponents.map((o) => o.id).join(',')}`;
console.log('\nA: ' + a.adapter.id + '   B: ' + b.adapter.id);
if (sig(a) !== sig(b)) console.log('⚠ protocols differ — comparison is NOT apples-to-apples:\n  A ' + sig(a) + '\n  B ' + sig(b));
else console.log('protocol matched: ' + sig(a));

const delta = (x, y) => { const d = (x - y) * 100; return (d >= 0 ? '+' : '') + d.toFixed(1) + 'pp'; };
console.log('\n  REASONING · win rate (A − B)');
console.log('  OVERALL     A ' + pct(a.reasoning.overall.winRate) + '  vs  B ' + pct(b.reasoning.overall.winRate) + '   Δ ' + delta(a.reasoning.overall.winRate, b.reasoning.overall.winRate));
const byId = (r) => Object.fromEntries(r.reasoning.perOpponent.map((x) => [x.opponent, x]));
const ba = byId(a), bb = byId(b);
for (const id of Object.keys(ba)) {
  if (!bb[id]) continue;
  console.log(`  vs ${id.padEnd(9)} A ${pct(ba[id].winRate)}  vs  B ${pct(bb[id].winRate)}   Δ ${delta(ba[id].winRate, bb[id].winRate)}`);
}

if (a.latency && b.latency) {
  console.log('\n  LATENCY · decision time (ms)');
  console.log(`  mean        A ${a.latency.meanMs}  vs  B ${b.latency.meanMs}`);
  console.log(`  p95         A ${a.latency.p95Ms}  vs  B ${b.latency.p95Ms}`);
  console.log(`  timeoutRate A ${pct(a.latency.timeoutRate)}  vs  B ${pct(b.latency.timeoutRate)}`);
  console.log(`  calls/match A ${a.efficiency.modelCallsPerMatch}  vs  B ${b.efficiency.modelCallsPerMatch}`);
  console.log('\n  ↳ A higher win rate with higher latency means A is smarter but slower;');
  console.log('    compare each against its own oracle (--deadline-ms) run to separate the two.');
}
console.log('');