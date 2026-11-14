// ============================================================================
// Standard evaluation protocol for the Agent Fighting League model benchmark.
//
// A benchmark is only meaningful if every model is measured under IDENTICAL
// conditions. This module is the single source of truth for those conditions:
// the seed set, the opponent ladder, the fighter matchup, the match length, the
// model-call budget and the decision deadline. A report records the resolved
// protocol so any result can be reproduced byte-for-byte (the kernel is
// deterministic: same seed + same actions => same outcome).
//
// Two modes separate two different capabilities:
//   hosted   — the model AUTHORS a declarative strategy once, then we score it
//              with deterministic offline matches. No per-tick time pressure,
//              so this isolates reasoning / planning quality.
//   realtime — the model DECIDES every tick through an observe->act loop under
//              the league's deadline and budget. This measures real-time agency
//              and deliberately exposes the latency cost alongside the win rate.
// ============================================================================
import { CONFIG } from '../../src/config.js';
import { getFighter } from '../../src/fighters.js';
import { MAX_MODEL_CALLS_PER_MATCH, DECISION_DEADLINE_MS } from '../../src/costs.js';

export const PROTOCOL_VERSION = 'afl-bench/1';

/**
 * Fixed seed set. Spread across the 32-bit space so a strategy cannot overfit a
 * handful of openings. The count is the sample size behind every win rate; the
 * default (24) gives a Wilson 95% interval roughly +/-18pp at p=0.5 per opponent
 * — tighten with --seeds for publication-grade intervals.
 */
export const DEFAULT_SEEDS = Object.freeze([
  101, 202, 303, 404, 505, 606, 707, 808,
  909, 1010, 1111, 1212, 1313, 1414, 1515, 1616,
  1717, 1818, 1919, 2020, 2121, 2222, 2323, 2424,
]);

/** Mirror matchup by default: both sides play the same fighter so the result
 *  reflects strategy quality, not a character counter-pick (the league's single
 *  ranked track forces the same mirror). Override with --fighter. */
export const DEFAULT_FIGHTER = getFighter().id;

export const MODES = Object.freeze(['hosted', 'realtime']);

/**
 * Resolve a full protocol from (optional) overrides. Everything a report needs
 * to be reproducible is captured here, including the opponent version hashes
 * (filled by the runner) and the model identity (filled by the adapter).
 */
export function resolveProtocol(opts = {}) {
  const mode = opts.mode || 'hosted';
  if (!MODES.includes(mode)) throw new Error(`unknown mode "${mode}" (use ${MODES.join(' | ')})`);
  const seeds = normalizeSeeds(opts.seeds, opts.seedList);
  const fighter = opts.fighter || DEFAULT_FIGHTER;
  return Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    mode,
    seeds,
    seedCount: seeds.length,
    fighter,
    fighters: { a: fighter, b: fighter },
    ticks: Number(opts.ticks || CONFIG.MATCH_TICKS),
    tickMs: CONFIG.TICK_MS,
    rulesVersion: CONFIG.RULES_VERSION,
    budget: Number(opts.budget ?? MAX_MODEL_CALLS_PER_MATCH),
    // A large deadline (e.g. --deadline-ms 100000) relaxes the time pressure so
    // realtime decision QUALITY can be compared against the latency-constrained
    // run — that difference is the latency cost of the model.
    deadlineMs: Number(opts.deadlineMs ?? DECISION_DEADLINE_MS),
    opponents: opts.opponents || null, // null => full default ladder (opponents.mjs)
  });
}

function normalizeSeeds(seeds, seedList) {
  if (Array.isArray(seedList) && seedList.length) {
    return Object.freeze(seedList.map((s) => Number(s) >>> 0));
  }
  const n = Number(seeds);
  if (Number.isFinite(n) && n > 0) {
    // Deterministic expansion: keep the canonical head, then a fixed stride so
    // any sample size is reproducible from the count alone.
    const out = [];
    for (let i = 0; i < n; i += 1) out.push((DEFAULT_SEEDS[i % DEFAULT_SEEDS.length] + Math.floor(i / DEFAULT_SEEDS.length) * 7919) >>> 0);
    return Object.freeze(out);
  }
  return DEFAULT_SEEDS;
}

/** Minimal, dependency-free CLI flag reader (matches the project's other scripts). */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i += 1; }
    } else out._.push(a);
  }
  return out;
}

/** Build the seed list override from CLI (--seeds N or --seed-list 1,2,3). */
export function seedsFromArgs(args) {
  const opts = {};
  if (args['seed-list']) opts.seedList = String(args['seed-list']).split(',').map((s) => s.trim()).filter(Boolean);
  if (args.seeds) opts.seeds = args.seeds;
  return opts;
}