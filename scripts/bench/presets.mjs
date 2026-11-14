// ============================================================================
// Frozen, named evaluation presets. A preset is a COMPLETE protocol specification
// that anyone can run identically — the unit of comparability across models and
// across time. Bump the name (standard-v2, …) when any parameter changes; never
// silently edit a published preset, or old reports stop being comparable.
//
// Each preset lists the evaluations to run:
//   hosted   — reasoning-isolated strategy authoring
//   realtime — agency under the league deadline (latency-constrained)
//   oracle   — realtime with a relaxed deadline (pure decision quality)
// The constrained-minus-oracle win rate is the model's latency cost.
// ============================================================================
import { DEFAULT_FIGHTER } from './protocol.mjs';

export const PRESETS = Object.freeze({
  // Publication-grade default: 24 seeds x 4 opponents = 96 games per evaluation.
  'standard-v1': Object.freeze({
    name: 'standard-v1',
    seeds: 24,
    opponents: null, // full calibrated ladder
    fighter: DEFAULT_FIGHTER,
    ticks: 600,
    budget: 8,
    deadlineMs: 80,
    oracleDeadlineMs: 100000,
    evals: Object.freeze(['hosted', 'realtime', 'oracle']),
  }),
  // Fast smoke preset for iteration / CI (wider confidence intervals).
  'quick-v1': Object.freeze({
    name: 'quick-v1',
    seeds: 8,
    opponents: null,
    fighter: DEFAULT_FIGHTER,
    ticks: 600,
    budget: 8,
    deadlineMs: 80,
    oracleDeadlineMs: 100000,
    evals: Object.freeze(['hosted', 'realtime', 'oracle']),
  }),
});

export function getPreset(name) {
  const p = PRESETS[name];
  if (!p) throw new Error(`unknown preset "${name}" (available: ${Object.keys(PRESETS).join(', ')})`);
  return p;
}

export function presetNames() { return Object.keys(PRESETS); }