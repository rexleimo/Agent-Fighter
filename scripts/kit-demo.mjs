/**
 * Kit demo: watch every fighter's OWN skill table resolve in the kernel, in text.
 *
 * The fastest way to sanity-check the kit system without a browser: it runs one
 * scripted scene per fighter against the neutral fighter and prints what
 * actually happened (advance distance, projectile shape, counter window,
 * invuln frames, multi-hit segments) plus a PASS/FAIL verdict per mechanic.
 * Each fighter is checked against the mechanic its own data declares, so all
 * sixteen kits are verified on their own terms.
 *
 * Usage:
 *   node scripts/kit-demo.mjs            # all sixteen fighters
 *   node scripts/kit-demo.mjs basalt     # one fighter
 *   node scripts/kit-demo.mjs counter    # one archetype (all its fighters)
 */
import { createInitialState, step } from '../src/engine.js';
import { FIGHTERS, getFighter } from '../src/fighters.js';
import { moveDamage } from '../src/rules.js';
import { ARCHETYPES, FIGHTER_KITS, FIGHTER_KIT_IDS } from '../src/kits/index.js';

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
      s = step(s, action, plan.bAction ? plan.bAction(t) : 'idle');
      // step() resets state.events every frame, so they must be collected here.
      events.push(...s.events.map((e) => ({ ...e, t })));
      frames.push({
        t, x: s.a.x, y: s.a.y, invuln: s.a.invuln, counterWindow: s.a.counterWindow,
        state: s.a.state, moveId: s.a.moveId, moveFrame: s.a.moveFrame,
        projectiles: s.projectiles.map((p) => ({ w: p.w, h: p.h, owner: p.owner, move: p.move })),
        hpA: s.a.hp, hpB: s.b.hp,
      });
    }
  }
  return { s, events, frames };
}

/** Distance the fighter covered during the scene. */
function advanceOf(r) {
  return Math.max(...r.frames.map((f) => f.x)) - r.frames[0].x;
}

/**
 * Run one fighter's `special` and check it against its own declared
 * mechanics. Returns the verdict plus the lines that explain it.
 */
function checkSpecial(fighterId) {
  const kit = FIGHTER_KITS[fighterId];
  const m = kit.moves.special;
  const problems = [];
  const lines = [];

  if (m.counter) {
    // A stance only proves itself against an incoming melee hit.
    const r = scene({
      a: fighterId, b: 'ember', dx: 100, ticks: 14,
      plan: { action: () => 'special', bAction: (t) => (t <= 1 ? 'hp' : 'idle') },
    });
    const counters = r.events.filter((e) => e.type === 'counter');
    if (counters.length === 0) problems.push('no counter absorbed');
    if (counters.length && counters[0].damage !== m.counter.damage) {
      problems.push('counter damage ' + counters[0].damage + ' != ' + m.counter.damage);
    }
    lines.push('counter absorbed   ' + counters.length + (counters[0] ? ' for ' + counters[0].damage + ' damage' : ''));
    lines.push('attacker hp       ' + r.s.b.hp + ' (started 1000)');
    // Projectiles must never be counterable.
    const p = scene({
      a: fighterId, b: 'tide', dx: 320, ticks: 16,
      plan: { action: () => 'special', bAction: () => 'special' },
    });
    if (p.events.filter((e) => e.type === 'counter').length) problems.push('countered a projectile');
    lines.push('vs projectile     0 counters, stance hp ' + p.s.a.hp);
    return { ok: problems.length === 0, lines, problems };
  }

  const dx = m.projectile ? 340 : 120;
  const r = scene({ a: fighterId, dx, ticks: 14, plan: { action: (t) => (t < 4 ? 'special' : 'idle') } });
  const hits = r.events.filter((e) => e.type === 'hit');
  const spawns = r.events.filter((e) => e.type === 'spawn');

  if (m.projectile) {
    const want = m.projectile.count || 1;
    if (spawns.length !== want) problems.push('spawned ' + spawns.length + ' want ' + want);
    lines.push('projectiles       ' + spawns.length + ' (' + (m.projectile.w > 60 ? 'beam' : 'orb')
      + ' ' + m.projectile.w + 'x' + m.projectile.h + ' speed ' + m.projectile.speed + ')');
  } else {
    if (hits.length === 0) problems.push('special never connected');
    lines.push('hits              ' + hits.length
      + (hits[0] ? ' (' + hits.map((e) => e.damage).join('/') + ')' : ''));
    lines.push('hit heights       ' + JSON.stringify(hits.map((e) => e.height)));
  }

  if (m.multiHit && hits.length < 2) problems.push('multi-hit landed ' + hits.length + ' segments');

  if (m.advance) {
    const moved = advanceOf(r);
    if (moved <= 5) problems.push('advance did not move');
    lines.push('advance distance  ' + moved + ' px');
  }

  if (m.invuln) {
    const invuln = r.frames.filter((f) => f.invuln > 0).length;
    if (invuln === 0) problems.push('no invuln frames');
    lines.push('invuln frames     ' + invuln);
  }

  lines.push('total damage      ' + moveDamage(m));
  return { ok: problems.length === 0, lines, problems };
}

/** EX and super are gated by meter, so they get their own meter-full scene. */
function checkMeterMoves(fighterId) {
  const kit = FIGHTER_KITS[fighterId];
  const problems = [];
  const lines = [];
  for (const action of ['ex', 'super']) {
    const m = kit.moves[action];
    const dx = m.projectile ? 340 : 120;
    // A counter stance only answers an incoming melee hit, so the opponent
    // has to actually swing for the check to mean anything.
    const bAction = m.counter ? (t) => (t <= 1 ? 'hp' : 'idle') : null;
    const r = scene({
      a: fighterId, dx, ticks: 16,
      plan: { meter: 300, action: (t) => (t < 4 ? action : 'idle'), bAction },
    });
    const hits = r.events.filter((e) => e.type === 'hit');
    const spawns = r.events.filter((e) => e.type === 'spawn');
    const counters = r.events.filter((e) => e.type === 'counter');
    const started = r.events.some((e) => e.type === 'move_start' && e.move === action);
    if (!started) problems.push(action + ' never started');
    if (m.projectile) {
      const want = m.projectile.count || 1;
      if (spawns.length !== want) problems.push(action + ' spawned ' + spawns.length + ' want ' + want);
    } else if (m.counter) {
      if (!counters.length) problems.push(action + ' never countered');
    } else if (hits.length === 0) {
      problems.push(action + ' never connected');
    }
    lines.push(action.padEnd(17) + ' dmg ' + moveDamage(m) + ', started ' + started
      + ', hits ' + hits.length + ', spawns ' + spawns.length + ', counters ' + counters.length);
  }
  return { ok: problems.length === 0, lines, problems };
}

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const only = args[0];
let fighterIds = FIGHTER_KIT_IDS.slice();
if (only) {
  if (FIGHTER_KIT_IDS.includes(only)) {
    fighterIds = [only];
  } else if (ARCHETYPES[only]) {
    fighterIds = FIGHTER_KIT_IDS.filter((id) => FIGHTER_KITS[id].archetype === only);
  } else if (FIGHTERS.some((f) => f.id === only)) {
    fighterIds = [only];
  } else {
    console.error('unknown fighter or archetype: ' + only
      + '\n  fighters: ' + FIGHTER_KIT_IDS.join(', ')
      + '\n  archetypes: ' + Object.keys(ARCHETYPES).join(', '));
    process.exit(1);
  }
}
if (fighterIds.length === 1) {
  const f = getFighter(fighterIds[0]);
  const kit = FIGHTER_KITS[fighterIds[0]];
  console.log(f.name + ' (' + f.id + ') → ' + kit.label + ' [' + kit.archetype + ']');
  console.log('  ' + kit.blurb + '\n');
} else {
  console.log((only ? 'archetype ' + only : 'all fighters') + ' — ' + fighterIds.length + ' kits\n');
}

let allOk = true;
for (const fighterId of fighterIds) {
  const kit = FIGHTER_KITS[fighterId];
  const special = checkSpecial(fighterId);
  const meter = checkMeterMoves(fighterId);
  const ok = special.ok && meter.ok;
  allOk = allOk && ok;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + fighterId.padEnd(8) + ' · ' + kit.label
    + '  [' + kit.archetype + ']');
  for (const line of special.lines) console.log('        ' + line);
  for (const line of meter.lines) console.log('        ' + line);
  const problems = [...special.problems, ...meter.problems];
  if (problems.length) console.log('        !! ' + problems.join('; '));
  console.log('');
}
console.log(allOk ? 'all kit mechanics behave as declared' : 'some kit mechanic did not behave as declared');
process.exitCode = allOk ? 0 : 1;
