// Shared kernel driver for the combat acceptance gates.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInitialState, step, renderState } from '../../src/engine.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Drive the kernel frame by frame, returning the state and every event. */
export function scene({ dx = 100, aY = 0, bY = 0, meter = 0, plan, frames = 40, mutate = null, fighters = null }) {
  let s = createInitialState(11, 'combat-test', fighters || {});
  s.a.x = 480 - dx / 2;
  s.b.x = 480 + dx / 2;
  s.a.y = aY;
  s.b.y = bY;
  s.a.meter = meter;
  s.b.meter = meter;
  if (mutate) mutate(s);
  const events = [];
  const snapshots = [];
  for (let i = 0; i < frames; i += 1) {
    const [aa, ba] = plan(i, s);
    s = step(s, aa, ba);
    events.push(...s.events.map((e) => ({ ...e, i })));
    snapshots.push(renderState(s));
  }
  return { s, events, snapshots };
}

export const types = (r, t) => r.events.filter((e) => e.type === t);

/**
 * One attack and one defence, each issued ONCE, for the defensive-layer gates.
 * Frame numbers in those gates were measured against this driver.
 */
export function guard({ move, dx = 110, atkAt = 4, def = 'dodge', defAt = 7, frames = 45, meter = 0, hold = false }) {
  let s = createInitialState(23, 'guard-layer', {});
  s.a.x = 480 - dx / 2;
  s.b.x = 480 + dx / 2;
  s.a.meter = meter;
  s.b.meter = meter;
  const events = [];
  for (let i = 0; i < frames; i += 1) {
    const defending = hold ? i >= defAt : i === defAt;
    s = step(s, i === atkAt ? move : 'idle', defending ? def : 'idle');
    events.push(...s.events.map((e) => ({ ...e, i })));
  }
  const of = (t) => events.filter((e) => e.type === t);
  return { s, events, of, hit: of('hit')[0], read: of('evade')[0] || of('parry')[0] };
}
