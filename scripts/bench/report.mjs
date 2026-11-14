// ============================================================================
// Report building + rendering. A report is a self-contained, reproducible
// artifact: it pins the protocol, the opponent version hashes and the model
// identity, then separates REASONING metrics (win rates with Wilson intervals)
// from LATENCY metrics (decision time distribution, timeouts, budget). Keeping
// those apart is the whole point — a slow-but-smart model and a fast-but-dumb
// model can post the same win rate for very different reasons.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { pct } from './stats.mjs';

export const HARNESS_VERSION = '1.0.0';

export function buildReport(result) {
  return {
    harness: {
      name: 'agent-fighting-league-benchmark',
      version: HARNESS_VERSION,
      protocolVersion: result.protocol.protocolVersion,
      generatedAt: new Date().toISOString(),
      node: process.version,
    },
    ...result,
    reproducibility: {
      deterministicKernel: true,
      note: result.mode === 'hosted'
        ? 'Hosted scores reproduce byte-for-byte: same protocol + same strategy JSON => identical results. Pin the strategy versionHash.'
        : 'Realtime scores reproduce when the adapter is deterministic (temperature 0 or reference). Latency varies with host load; win rate under a deadline depends on it. Compare constrained vs --deadline-ms oracle to isolate the latency cost.',
    },
  };
}

function bar(fraction, width = 20) {
  const filled = Math.round(fraction * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function renderConsole(report) {
  const L = [];
  const p = report.protocol;
  L.push('');
  L.push('╔══════════════════════════════════════════════════════════════════╗');
  L.push('║  AGENT FIGHTING LEAGUE · MODEL BENCHMARK                          ║');
  L.push('╚══════════════════════════════════════════════════════════════════╝');
  L.push(`  mode        ${report.mode}`);
  L.push(`  adapter     ${report.adapter.id}  (${report.adapter.kind})`);
  L.push(`  fighter     ${p.fighter} (mirror)   rules ${p.rulesVersion}`);
  L.push(`  protocol    ${p.seedCount} seeds × ${report.opponents.length} opponents = ${p.seedCount * report.opponents.length} games · ${p.ticks} ticks/game`);
  if (report.mode === 'realtime') L.push(`  constraints deadline ${p.deadlineMs}ms · budget ${p.budget} model calls/match`);
  L.push('');

  if (report.strategy) {
    const s = report.strategy;
    L.push('  ── authored strategy (reasoning) ──');
    L.push(`  ${s.name} · ${s.ruleCount} rules · default ${s.defaultAction} · hash ${s.versionHash} · authored in ${s.authoringMs}ms`);
    L.push('');
  }

  const o = report.reasoning.overall;
  if (report.calibration) {
    L.push('  ── opponent ladder (measured strength, strong → weak) ──');
    L.push('  ' + report.calibration.map((c) => `${c.id}(${(c.calibrationWinRate * 100).toFixed(0)}%)`).join('  >  '));
    L.push('');
  }
  L.push('  ── REASONING · win rate (Wilson 95% CI) ──');
  L.push(`  OVERALL     ${bar(o.winRate)}  ${pct(o.winRate)}  [${pct(o.wilson.low)}–${pct(o.wilson.high)}]  ${o.wins}W/${o.losses}L/${o.draws}D of ${o.games}`);
  for (const row of report.reasoning.perOpponent) {
    L.push(`  vs ${row.opponent.padEnd(9)} ${bar(row.winRate)}  ${pct(row.winRate)}  [${pct(row.wilson.low)}–${pct(row.wilson.high)}]  avgHp ${row.avgHpLeft} · ${row.avgTicks} ticks`);
  }
  L.push('');

  if (report.latency) {
    const lat = report.latency;
    L.push('  ── LATENCY · decision time (ms) ──');
    L.push(`  mean ${lat.meanMs} · p50 ${lat.p50Ms} · p95 ${lat.p95Ms} · p99 ${lat.p99Ms} · max ${lat.maxMs}  (${lat.samples} decisions)`);
    L.push(`  timeouts ${lat.timeouts} (${pct(lat.timeoutRate)} of decisions) · budgetExceeded ${lat.budgetExceeded} · modelCalls ${lat.modelCalls}`);
    L.push(`  efficiency ${report.efficiency.modelCallsPerMatch} calls/match · ${report.efficiency.timeoutsPerMatch} timeouts/match`);
    L.push('');
    L.push('  ↳ win rate above is latency-CONSTRAINED. Re-run with --deadline-ms 100000');
    L.push('    for oracle decision quality; the gap is the model\'s latency cost.');
    L.push('');
  }

  L.push(`  duration ${report.durationMs}ms · ${report.matches.length} games recorded`);
  L.push('');
  return L.join('\n');
}

export function writeReport(report, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = report.startedAt.replace(/[:.]/g, '-');
  const file = path.join(outDir, `${report.mode}_${report.adapter.id.replace(/[^\w.-]/g, '_')}_${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
  return file;
}