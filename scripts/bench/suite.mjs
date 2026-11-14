#!/usr/bin/env node
// ============================================================================
// One-click standardized evaluation suite. Runs a frozen preset's evaluations
// (hosted + realtime-constrained + realtime-oracle) for ONE adapter and bundles
// them into a single comparable report, including the model's latency cost
// (oracle win rate minus constrained win rate).
//
//   pnpm bench:suite -- --preset standard-v1                 # offline reference
//   AFL_LLM_KEY=sk-... pnpm bench:suite -- --adapter openai --model gpt-4o-mini
//
// Because the preset pins every parameter, two suite reports are directly
// comparable (and feed bench:leaderboard).
// ============================================================================
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveProtocol, parseArgs } from './protocol.mjs';
import { adapterFromArgs } from './adapters.mjs';
import { runHosted, runRealtime } from './runner.mjs';
import { HARNESS_VERSION } from './report.mjs';
import { getPreset, presetNames } from './presets.mjs';
import { pct, round } from './stats.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export async function runSuite({ adapter, preset, onProgress }) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const base = {
    fighter: preset.fighter, ticks: preset.ticks, budget: preset.budget,
    opponents: preset.opponents, seeds: preset.seeds,
  };
  const evaluations = {};
  for (const ev of preset.evals) {
    if (ev === 'hosted') {
      evaluations.hosted = await runHosted({ protocol: resolveProtocol({ mode: 'hosted', ...base }), adapter, onProgress });
    } else if (ev === 'realtime') {
      evaluations.realtime = await runRealtime({ protocol: resolveProtocol({ mode: 'realtime', ...base, deadlineMs: preset.deadlineMs }), adapter, onProgress });
    } else if (ev === 'oracle') {
      evaluations.oracle = await runRealtime({ protocol: resolveProtocol({ mode: 'realtime', ...base, deadlineMs: preset.oracleDeadlineMs }), adapter, onProgress });
    }
  }

  const hostedWR = evaluations.hosted?.reasoning.overall.winRate ?? null;
  const realtimeWR = evaluations.realtime?.reasoning.overall.winRate ?? null;
  const oracleWR = evaluations.oracle?.reasoning.overall.winRate ?? null;

  return {
    harness: { name: 'agent-fighting-league-benchmark', version: HARNESS_VERSION, generatedAt: new Date().toISOString(), node: process.version },
    preset,
    adapter: { id: adapter.id, kind: adapter.kind, config: adapter.config },
    evaluations,
    summary: {
      reasoningWinRate: hostedWR,
      realtimeWinRate: realtimeWR,
      oracleWinRate: oracleWR,
      // How many percentage points the latency constraint costs this model.
      latencyCost: (realtimeWR != null && oracleWR != null) ? round(oracleWR - realtimeWR, 4) : null,
      strategy: evaluations.hosted?.strategy ?? null,
      latency: evaluations.realtime?.latency ?? null,
    },
    startedAt, durationMs: Date.now() - t0,
  };
}

export function renderSuite(bundle) {
  const s = bundle.summary;
  const L = [];
  L.push('');
  L.push('╔══════════════════════════════════════════════════════════════════╗');
  L.push('║  AGENT FIGHTING LEAGUE · STANDARD SUITE                           ║');
  L.push('╚══════════════════════════════════════════════════════════════════╝');
  L.push(`  preset      ${bundle.preset.name}  (${bundle.preset.seeds} seeds × ${bundle.evaluations.hosted?.opponents.length ?? '?'} opponents)`);
  L.push(`  adapter     ${bundle.adapter.id}  (${bundle.adapter.kind})`);
  if (s.strategy) L.push(`  strategy    ${s.strategy.name} · hash ${s.strategy.versionHash}`);
  L.push('');
  L.push('  ── capability profile ──');
  if (s.reasoningWinRate != null) L.push(`  reasoning (hosted)        ${pct(s.reasoningWinRate)}`);
  if (s.oracleWinRate != null) L.push(`  decision quality (oracle) ${pct(s.oracleWinRate)}`);
  if (s.realtimeWinRate != null) L.push(`  agency (constrained)      ${pct(s.realtimeWinRate)}`);
  if (s.latencyCost != null) L.push(`  latency cost              ${pct(s.latencyCost)}  (oracle − constrained)`);
  if (s.latency) L.push(`  latency p95 ${s.latency.p95Ms}ms · timeout ${pct(s.latency.timeoutRate)} · ${s.latency.modelCalls} calls`);
  L.push('');
  L.push(`  duration ${bundle.durationMs}ms`);
  L.push('');
  return L.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log('Usage: pnpm bench:suite -- --preset standard-v1 [--adapter openai --model X]');
    console.log('Presets: ' + presetNames().join(', '));
    process.exit(0);
  }
  const preset = getPreset(args.preset || 'standard-v1');
  const adapter = adapterFromArgs({ ...args, mode: 'hosted' });
  if (!args.quiet) console.error(`[suite] preset=${preset.name} adapter=${adapter.id} evals=${preset.evals.join('+')}`);
  const onProgress = args.quiet ? null : (e) => { if (e.seed === undefined) return; };
  const bundle = await runSuite({ adapter, preset, onProgress });
  console.log(renderSuite(bundle));
  const outDir = args.out ? path.resolve(ROOT, String(args.out)) : path.join(ROOT, 'bench', 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = bundle.startedAt.replace(/[:.]/g, '-');
  const file = path.join(outDir, `suite_${preset.name}_${bundle.adapter.id.replace(/[^\w.-]/g, '_')}_${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(bundle, null, 2), 'utf8');
  console.log(`  bundle → ${path.relative(ROOT, file)}`);
  console.log('');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('[suite] ' + (e.stack || e.message)); process.exit(1); });
}