/**
 * Kit demo: watch each skill archetype resolve in the kernel, in text.
 *
 * This is the fastest way to sanity-check B1 without a browser: it runs one
 * scripted scene per archetype against the neutral fighter and prints what
 * actually happened (advance distance, projectile shape, counter window,
 * invuln frames, multi-hit segments) plus a PASS/FAIL verdict per mechanic.
 *
 * Usage:
 *   node scripts/kit-demo.mjs            # all five archetypes
 *   node scripts/kit-demo.mjs counter    # one kit
 *   node scripts/kit-demo.mjs volt       # or a fighter id
 */
import { createInitialState, step } from '../src/engine.js';
import { FIGHTERS, getFighter } from '../src/fighters.js';
import { KITS, KIT_IDS, moveFor, moveDamage } from '../src/rules.js';

const TICK_FRAMES = 6;

/** Run a scene and collect events + per-frame snapshots of side A. */
function scene({ a, b = 'quartz', dx = 140, plan, ticks = 14 }) {
  let s = createInitialState(20261107, 'kit-demo', { a, b });
  s.a.x = 480 - dx / 2;
  s.b.x = 480 + dx / 2;
  if (plan.meter) { s.a.meter = plan.meter; }
  const events = [];
  const frames = [];
  for (let t = 0; t < ticks; t += 1) {
    const action = plan.action(t);
    for (let f = 0; f < TICK_FRAMES; f += 1) {
      s = step(s, action, 'idle');
      // step() resets state.events every frame, so they must be collected here.
      events.push(...s.events.map((e) => ({ ...e, t })));
      frames.push({
        t, x: s.a.x, invuln: s.a.invuln, counterWindow: s.a.counterWindow,
        state: s.a.state, moveId: s.a.moveId, moveFrame: s.a.moveFrame,
        projectiles: s.projectiles.map((p) => ({ w: p.w, h: p.h, owner: p.owner, move: p.move })),
        hpA: s.a.hp, hpB: s.b.hp,
      });
    }
  }
  return { s, events, frames };
}

const count = (r, type) => r.events.filter((e) => e.type === type).length;

const REPORTERS = {
  rush() {
    const r = scene({ a: 'ember', dx: 180, plan: { action: (t) => (t < 4 ? 'special' : 'idle') } });
    const startX = r.frames[0].x;
    const moved = Math.max(...r.frames.map((f) => f.x)) - startX;
    const hits = r.events.filter((e) => e.type === 'hit');
    return {
      ok: moved > 20 && hits.some((e) => e.knockdown),
      lines: [
        'advance distance  ' + moved + ' px',
        'hits              ' + hits.length + (hits[0] ? ' (' + hits.map((e) => e.damage).join('/') + ')' : ''),
        'knockdown         ' + (hits.some((e) => e.knockdown) ? 'yes' : 'no'),
      ],
    };
  },

  volley() {
    const mk = (action, meter) => scene({ a: 'tide', dx: 340, plan: { meter, action: (t) => (t < 4 ? action : 'idle') } });
    const special = mk('special', 0);
    const ex = mk('ex', 200);
    const sup = mk('super', 300);
    const widest = (r) => Math.max(0, ...r.frames.flatMap((f) => f.projectiles.filter((p) => p.owner === 'a').map((p) => p.w)));
    return {
      ok: count(special, 'spawn') === 1 && count(ex, 'spawn') === 2 && widest(sup) > widest(special) * 2,
      lines: [
        'special spawns    ' + count(special, 'spawn') + '  (orb ' + widest(special) + 'px wide)',
        'EX spawns         ' + count(ex, 'spawn') + '  (staggered pair)',
        'super spawns      ' + count(sup, 'spawn') + '  (beam ' + widest(sup) + 'px wide)',
        'damage special    ' + moveDamage(moveFor('volley', 'special'))
          + ' / ex ' + moveDamage(moveFor('volley', 'ex'))
          + ' / super ' + moveDamage(moveFor('volley', 'super')),
      ],
    };
  },

  counter() {
    // B attacks with a heavy punch into A's stance.
    let s = createInitialState(20261107, 'kit-demo', { a: 'coral', b: 'ember' });
    s.a.x = 430; s.b.x = 530;
    const events = [];
    for (let t = 0; t < 14; t += 1) {
      const a = 'special';
      // The heavy punch must land INSIDE the stance's active frames
      // (startup 4..16), otherwise the demo would just be a whiff.
      const b = t <= 1 ? 'hp' : 'idle';
      for (let f = 0; f < TICK_FRAMES; f += 1) {
        s = step(s, a, b);
        events.push(...s.events.map((e) => ({ ...e, t })));
      }
    }
    const counters = events.filter((e) => e.type === 'counter');
    // Projectiles must NOT be counterable: same stance, but the attack is an orb.
    let p = createInitialState(20261107, 'kit-demo2', { a: 'coral', b: 'tide' });
    p.a.x = 420; p.b.x = 700;
    const pEvents = [];
    for (let t = 0; t < 16; t += 1) {
      const a = 'special';
      const b = 'special';
      for (let f = 0; f < TICK_FRAMES; f += 1) {
        p = step(p, a, b);
        pEvents.push(...p.events.map((e) => ({ ...e, t })));
      }
    }
    const pCounters = pEvents.filter((e) => e.type === 'counter');
    return {
      ok: counters.length > 0 && pCounters.length === 0 && p.a.hp < 1000,
      lines: [
        'vs melee          ' + counters.length + ' counter(s)'
          + (counters[0] ? ' for ' + counters[0].damage + ' damage' : ''),
        'attacker hp       ' + s.b.hp + ' (started 1000)',
        'vs projectile     ' + pCounters.length + ' counter(s), stance hp ' + p.a.hp + ' (it still loses to zoning)',
      ],
    };
  },

  antiAir() {
    const r = scene({ a: 'volt', dx: 120, plan: { action: (t) => (t < 3 ? 'special' : 'idle') } });
    const invuln = r.frames.filter((f) => f.invuln > 0).length;
    return {
      ok: invuln > 0 && count(r, 'hit') > 0,
      lines: [
        'invuln frames     ' + invuln,
        'hits              ' + count(r, 'hit'),
        'hit heights       ' + JSON.stringify(r.events.filter((e) => e.type === 'hit').map((e) => e.height)),
      ],
    };
  },

  multi() {
    const r = scene({ a: 'gale', dx: 120, plan: { action: (t) => (t < 3 ? 'special' : 'idle') } });
    const hits = r.events.filter((e) => e.type === 'hit');
    const rSuper = scene({ a: 'gale', dx: 120, ticks: 14, plan: { meter: 300, action: (t) => (t < 4 ? 'super' : 'idle') } });
    const superHits = rSuper.events.filter((e) => e.type === 'hit').length;
    return {
      ok: hits.length >= 2 && superHits >= 3,
      lines: [
        'special segments  ' + hits.length + ' (' + hits.map((e) => e.damage).join('/') + ')',
        'super segments    ' + superHits,
        'total special dmg ' + moveDamage(moveFor('multi', 'special')),
      ],
    };
  },
};

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const only = args[0];
let kitIds = KIT_IDS.slice();
let fighterId = null;
if (only) {
  if (KIT_IDS.includes(only)) kitIds = [only];
  else {
    const f = FIGHTERS.find((x) => x.id === only);
    if (!f) {
      console.error('unknown kit or fighter: ' + only + '\n  kits: ' + KIT_IDS.join(', ')
        + '\n  fighters: ' + FIGHTERS.map((x) => x.id).join(', '));
      process.exit(1);
    }
    fighterId = f.id;
    kitIds = [f.kit];
  }
}

if (fighterId) {
  const f = getFighter(fighterId);
  const kit = KITS[f.kit];
  console.log(f.name + ' (' + f.id + ') → kit ' + kit.id + ' · ' + kit.label);
  console.log('  ' + kit.blurb + '\n');
}

let allOk = true;
for (const kitId of kitIds) {
  const kit = KITS[kitId];
  const roster = FIGHTERS.filter((f) => f.kit === kitId).map((f) => f.id);
  const out = REPORTERS[kitId]();
  allOk = allOk && out.ok;
  console.log((out.ok ? 'PASS  ' : 'FAIL  ') + kitId + ' · ' + kit.label + '  [' + roster.join(' ') + ']');
  for (const line of out.lines) console.log('        ' + line);
  console.log('');
}
console.log(allOk ? 'all kit mechanics behave as declared' : 'some kit mechanic did not behave as declared');
process.exitCode = allOk ? 0 : 1;
