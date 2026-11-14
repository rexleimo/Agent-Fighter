#!/usr/bin/env node
// ============================================================================
// Multi-model leaderboard. Two ways to build it:
//
//   aggregate existing suite bundles / reports (offline, no API):
//     pnpm bench:leaderboard -- --reports bench/reports
//     pnpm bench:leaderboard -- bench/reports/suite_A.json bench/reports/suite_B.json
//
//   run the standard suite for several models, then rank (needs API keys):
//     AFL_LLM_KEY=sk-... pnpm bench:leaderboard -- --models gpt-4o-mini,gpt-4o --preset quick-v1
//
// Ranking is by REASONING win rate (hosted — the latency-isolated metric), with
// oracle win rate then latency cost as tie-breakers. The table keeps reasoning,
// decision quality, constrained agency and latency side by side so a reader sees
// WHY a model ranks where it does, not just a single number.
// ============================================================================
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from './protocol.mjs';
import { openaiAdapter } from './adapters.mjs';
import { runSuite } from './suite.mjs';
import { getPreset } from './presets.mjs';
import { pct } from './stats.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function entryFromBundle(b, source) {
  return {
    adapter: b.adapter.id, kind: b.adapter.kind, preset: b.preset?.name ?? null,
    reasoningWinRate: b.summary.reasoningWinRate,
    realtimeWinRate: b.summary.realtimeWinRate,
    oracleWinRate: b.summary.oracleWinRate,
    latencyCost: b.summary.latencyCost,
    latencyP95: b.summary.latency?.p95Ms ?? null,
    timeoutRate: b.summary.latency?.timeoutRate ?? null,
    strategyHash: b.summary.strategy?.versionHash ?? null,
    source,
  };
}

function entryFromReport(r, source) {
  const wr = r.reasoning?.overall.winRate ?? null;
  return {
    adapter: r.adapter.id, kind: r.adapter.kind, preset: null,
    reasoningWinRate: r.mode === 'hosted' ? wr : null,
    realtimeWinRate: r.mode === 'realtime' ? wr : null,
    oracleWinRate: null, latencyCost: null,
    latencyP95: r.latency?.p95Ms ?? null, timeoutRate: r.latency?.timeoutRate ?? null,
    strategyHash: r.strategy?.versionHash ?? null, source,
  };
}

function entryFromJson(j, source) {
  return j.summary && j.evaluations ? entryFromBundle(j, source) : entryFromReport(j, source);
}

export function rank(entries) {
  const val = (x) => (x == null ? -1 : x);
  return [...entries].sort((a, b) =>
    val(b.reasoningWinRate) - val(a.reasoningWinRate)
    || val(b.oracleWinRate) - val(a.oracleWinRate)
    || val(a.latencyCost) - val(b.latencyCost)
    || a.adapter.localeCompare(b.adapter));
}

function collectFiles(args) {
  const files = [];
  const push = (p) => { if (p.endsWith('.json') && fs.existsSync(p)) files.push(p); };
  if (args.reports) {
    const target = path.resolve(ROOT, String(args.reports));
    if (fs.statSync(target).isDirectory()) {
      for (const f of fs.readdirSync(target)) push(path.join(target, f));
    } else push(target);
  }
  for (const p of args._) push(path.resolve(ROOT, p));
  return [...new Set(files)];
}

export function renderLeaderboard(entries) {
  const L = [];
  L.push('');
  L.push('  AGENT FIGHTING LEAGUE · MODEL LEADERBOARD  (ranked by reasoning win rate)');
  L.push('  ' + '─'.repeat(94));
  L.push('  ' + ['#', 'adapter', 'reasoning', 'oracle', 'constrained', 'latCost', 'p95ms', 'timeout'].map((h, i) => h.padEnd([3, 26, 10, 9, 12, 9, 8, 8][i])).join(''));
  entries.forEach((e, i) => {
    const f = (x) => x == null ? '—' : pct(x);
    L.push('  ' + [
      String(i + 1), e.adapter.slice(0, 25), f(e.reasoningWinRate), f(e.oracleWinRate),
      f(e.realtimeWinRate), f(e.latencyCost), e.latencyP95 == null ? '—' : String(e.latencyP95),
      e.timeoutRate == null ? '—' : pct(e.timeoutRate),
    ].map((c, j) => c.padEnd([3, 26, 10, 9, 12, 9, 8, 8][j])).join(''));
  });
  L.push('  ' + '─'.repeat(94));
  L.push('  reasoning=hosted(latency-isolated) · oracle=relaxed deadline · constrained=80ms · latCost=oracle−constrained');
  L.push('');
  return L.join('\n');
}

export function toMarkdown(entries) {
  const f = (x) => x == null ? '—' : pct(x);
  const rows = entries.map((e, i) =>
    `| ${i + 1} | ${e.adapter} | ${f(e.reasoningWinRate)} | ${f(e.oracleWinRate)} | ${f(e.realtimeWinRate)} | ${f(e.latencyCost)} | ${e.latencyP95 ?? '—'} | ${e.timeoutRate == null ? '—' : pct(e.timeoutRate)} |`);
  return [
    '# AFL Model Leaderboard', '',
    'Ranked by reasoning (hosted, latency-isolated) win rate. oracle = relaxed deadline; constrained = 80ms; latCost = oracle − constrained.', '',
    '| # | adapter | reasoning | oracle | constrained | latCost | p95ms | timeout |',
    '| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |',
    ...rows, '',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let entries = [];

  if (args.models) {
    const preset = getPreset(args.preset || 'quick-v1');
    const models = String(args.models).split(',').map((s) => s.trim()).filter(Boolean);
    for (const model of models) {
      if (!args.quiet) console.error(`[leaderboard] running suite for ${model} …`);
      const adapter = openaiAdapter({ model, temperature: args.temperature });
      const bundle = await runSuite({ adapter, preset });
      entries.push(entryFromBundle(bundle, `suite:${model}`));
    }
  } else {
    const files = collectFiles(args);
    if (!files.length) { console.error('No reports found. Pass --reports <dir> or report files, or --models a,b,c.'); process.exit(1); }
    for (const f of files) {
      try { entries.push(entryFromJson(JSON.parse(fs.readFileSync(f, 'utf8')), path.relative(ROOT, f))); }
      catch (e) { console.error(`[leaderboard] skip ${f}: ${e.message}`); }
    }
  }

  entries = rank(entries);
  console.log(renderLeaderboard(entries));
  const outDir = args.out ? path.resolve(ROOT, String(args.out)) : path.join(ROOT, 'bench', 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonFile = path.join(outDir, `leaderboard_${stamp}.json`);
  const mdFile = path.join(outDir, `leaderboard_${stamp}.md`);
  fs.writeFileSync(jsonFile, JSON.stringify({ generatedAt: new Date().toISOString(), entries }, null, 2), 'utf8');
  fs.writeFileSync(mdFile, toMarkdown(entries), 'utf8');
  console.log(`  leaderboard → ${path.relative(ROOT, jsonFile)}`);
  console.log(`  markdown    → ${path.relative(ROOT, mdFile)}`);
  console.log('');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('[leaderboard] ' + (e.stack || e.message)); process.exit(1); });
}