// Shared helpers for the independent MCP client probe.
// Kept free of try/catch: every fallible operation settles into a Result.

import { attempt, bestEffort, parseOr } from '../lib/no-throw.mjs';

/** Reporter shared by the entry point and the probe flow. */
export function createReporter(base, clientLabel) {
  const report = {
    generatedAt: new Date().toISOString(),
    base,
    client: clientLabel,
    checks: [],
    evidence: {},
  };
  const state = { failed: 0, connected: false };
  function check(name, ok, detail = '') {
    report.checks.push({ name, ok: Boolean(ok), detail });
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  |  ' + detail : ''));
    if (!ok) state.failed += 1;
  }
  return { report, state, check };
}

/** Unwrap an MCP tool result; malformed text falls back to the raw string. */
export async function unwrap(result) {
  if (!result) return null;
  if (result.isError) throw new Error('tool error: ' + (result.content?.[0]?.text || 'unknown'));
  if (result.structuredContent !== undefined && result.structuredContent !== null) return result.structuredContent;
  const text = result.content?.find((c) => c.type === 'text')?.text;
  if (!text) return null;
  return parseOr(text, text);
}

/** Server-side spectator frames, indexed by tick. */
export function spectate(wsBase, roomId, durationMs, tag) {
  return new Promise((resolve) => {
    const ticks = new Map();
    let hello = null;
    const opened = attempt(() => new WebSocket(wsBase + '/ws/spectate?room=' + encodeURIComponent(roomId)));
    opened.then((created) => {
      if (!created.ok) {
        resolve({ ticks, hello, error: String(created.error) });
        return;
      }
      const ws = created.value;
      const finish = () => { bestEffort(() => ws.close()); resolve({ ticks, hello, error: null }); };
      const timer = setTimeout(finish, durationMs);
      ws.onmessage = (ev) => {
        parseOr(String(ev.data), null).then((m) => {
          if (!m) return;
          if (m.type === 'hello') hello = m;
          if (m.type === 'tick') ticks.set(m.tick, m);
          if (m.type === 'tick' && m.over && tag === 'ranked') {
            clearTimeout(timer);
            setTimeout(finish, 300);
          }
        });
      };
      ws.onerror = () => { /* finish on timer */ };
      ws.onclose = () => { clearTimeout(timer); resolve({ ticks, hello, error: null }); };
    });
  });
}

export function actionStats(replay) {
  const counts = {};
  for (const t of replay.ticks) {
    for (const k of ['actionA', 'actionB']) counts[t[k]] = (counts[t[k]] || 0) + 1;
  }
  return counts;
}

export function hpCurve(rendered) {
  const out = [];
  for (const t of rendered) {
    const f = t.frames[t.frames.length - 1];
    if (f) out.push({ tick: t.tick, hpA: f.a.hp, hpB: f.b.hp, meterA: f.a.meter, meterB: f.b.meter });
  }
  return out;
}
