#!/usr/bin/env node
// ============================================================================
// Agent Fighting League · model benchmark CLI.
//
//   node scripts/bench/run.mjs --mode hosted                 # offline reference (no API key)
//   node scripts/bench/run.mjs --mode realtime               # offline reference decision policy
//   AFL_LLM_KEY=sk-... node scripts/bench/run.mjs --mode hosted --adapter openai --model gpt-4o-mini
//   AFL_LLM_KEY=sk-... node scripts/bench/run.mjs --mode realtime --adapter openai --model gpt-4o-mini
//   node scripts/bench/run.mjs --mode realtime --deadline-ms 100000   # oracle (latency-relaxed)
//
// Flags: --mode --adapter --model --temperature --seeds N --seed-list 1,2,3
//        --fighter --opponents random,turtle,zoner,brawler --ticks --budget
//        --deadline-ms --out --quiet
// ============================================================================
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveProtocol, parseArgs, seedsFromArgs } from './protocol.mjs';
import { adapterFromArgs } from './adapters.mjs';
import { runHosted, runRealtime } from './runner.mjs';
import { buildReport, renderConsole, writeReport } from './report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log('Usage: node scripts/bench/run.mjs --mode hosted|realtime [--adapter openai|reference|passive] [--seeds N] [--model X] ...');
    console.log('See docs/benchmark.md for the full protocol and metric interpretation.');
    process.exit(0);
  }

  const protocol = resolveProtocol({
    mode: args.mode || 'hosted',
    ...seedsFromArgs(args),
    fighter: args.fighter,
    ticks: args.ticks,
    budget: args.budget,
    deadlineMs: args['deadline-ms'],
    opponents: args.opponents ? String(args.opponents).split(',').map((s) => s.trim()).filter(Boolean) : null,
  });
  const adapter = adapterFromArgs({ ...args, mode: protocol.mode });

  if (!args.quiet) {
    console.error(`[bench] mode=${protocol.mode} adapter=${adapter.id} seeds=${protocol.seedCount} fighter=${protocol.fighter}`);
  }
  const onProgress = args.quiet ? null : (e) => {
    if (e.seed === protocol.seeds[0]) console.error(`[bench] vs ${e.opponent} …`);
  };

  const result = protocol.mode === 'hosted'
    ? await runHosted({ protocol, adapter, onProgress })
    : await runRealtime({ protocol, adapter, onProgress });

  const report = buildReport(result);
  console.log(renderConsole(report));
  const outDir = args.out ? path.resolve(ROOT, String(args.out)) : path.join(ROOT, 'bench', 'reports');
  const file = writeReport(report, outDir);
  console.log(`  report → ${path.relative(ROOT, file)}`);
  console.log('');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('[bench] ' + (e.stack || e.message)); process.exit(1); });
}