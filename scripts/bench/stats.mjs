// ============================================================================
// Statistics for the benchmark. Win rates are reported with a Wilson score
// interval (not a bare percentage) so a reader can see how much a result is
// worth given the sample size — 7/10 and 70/100 are both "70%" but very
// different evidence. Latency is reported as mean + percentiles because a single
// average hides the tail that actually causes timeouts.
// ============================================================================

/** Wilson score interval for a binomial proportion. Returns fractions in [0,1]. */
export function wilson(wins, n, z = 1.96) {
  if (!n) return { point: 0, low: 0, high: 0, n: 0 };
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return {
    point: round(p, 4),
    low: round(Math.max(0, (center - margin) / denom), 4),
    high: round(Math.min(1, (center + margin) / denom), 4),
    n,
  };
}

export function mean(xs) {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Linear-interpolated percentile. xs need not be sorted. */
export function percentile(xs, p) {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Summarize a list of decision latencies (ms). */
export function latencySummary(xs) {
  return {
    samples: xs.length,
    meanMs: round(mean(xs), 2),
    p50Ms: round(percentile(xs, 50), 2),
    p95Ms: round(percentile(xs, 95), 2),
    p99Ms: round(percentile(xs, 99), 2),
    maxMs: xs.length ? round(Math.max(...xs), 2) : 0,
  };
}

export function round(x, dp = 2) {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

/** Percentage string for console output. */
export function pct(fraction) {
  return (fraction * 100).toFixed(1) + '%';
}