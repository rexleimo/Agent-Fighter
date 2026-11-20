/** Fighter construction, move lifecycle and per-frame physics. */
import {
  CONFIG, moveFor, totalFor, isCommitted, isAttack, isDefense, canAfford,
  clamp, mechanicsOf, MOMENTUM_STATES,
} from '../rules.js';
import { cancelWindowOf, isCancelTarget } from '../combo.js';
import { getFighter } from '../fighters.js';
import { pushboxFor, overlap } from '../combat.js';
import { actionAvailable } from '../kits/index.js';

export function makeFighter(id, x, facing, fighterId = null, start = null) {
  const def = getFighter(fighterId || undefined);
  return {
    id, hp: start ? start.hp : CONFIG.MAX_HP, meter: start ? start.meter : 0,
    fighterId: def.id, kit: def.kit,
    x, y: 0, vx: 0, vy: 0, facing,
    state: 'idle', moveId: null, moveFrame: 0, hasHit: false,
    hitIds: [], armorLeft: 0, wakeup: 0, canceledFrom: null, lastMove: null,
    // `spentHit` / `spentHitIds` mean "this box already resolved and may not
    // resolve again". They are deliberately NOT the same thing as `hasHit`,
    // which is the hit-CONFIRM signal that opens the cancel window: a read by
    // the defender spends the box without handing the attacker a confirm.
    spentHit: false, spentHitIds: [],
    hitstun: 0, blockstun: 0, combo: 0, comboTimer: 0,
    comboDamage: 0, comboChain: [], comboBest: 0, comboBestDamage: 0,
    invuln: 0, lastAction: 'idle',
    // 闪避 cooldown, counted from the frame the dodge starts. It is part of the
    // state hash, so a replay of a match that used dodges stays reproducible.
    dodgeCd: 0,
    // Combo state: `hitFrame` is the move frame the current move connected on
    // (it anchors the cancel window), `buffer` holds a cancel input that was
    // issued before its window opened.
    hitFrame: null, buffer: null,
    // Kit mechanics: a 当身 stance opens a window that turns one melee hit
    // around; an advancing strike keeps its own vx for the active frames.
    counterWindow: 0, counterSpec: null, advanceVx: 0, spawned: false,
    // Anti-stall (rules 2.2). These are only hashed when antiStall is active so
    // pre-2.2 replays reproduce their stateHash byte for byte.
    passiveFrames: 0, stallLevel: 0, aggression: 0, damageDealt: 0,
  };
}

export function createInitialState(seed = 1, matchId = 'local', fighters = {}, start = null) {
  return {
    matchId,
    frame: 0,
    tick: 0,
    seed: seed >>> 0,
    rng: (seed >>> 0) || 1,
    fighters: { a: fighters.a || null, b: fighters.b || null },
    a: makeFighter('a', 300, 1, fighters.a, start && start.a),
    b: makeFighter('b', 660, -1, fighters.b, start && start.b),
    projectiles: [],
    hitstop: 0,
    superFlash: 0,
    over: false,
    winner: null,
    reason: null,
    events: [],
  };
}

export function startMove(f, action, s, side) {
  // An action locked away for this fighter's archetype must never produce a
  // move - not on the raw input, not through a cancel, not from the buffer.
  // We do NOT substitute a different move: that would hide the strategy bug.
  // The rejected tick is reported as an event so the room can count it.
  // Locks are a rules-2.2 policy. Pre-2.2 replays must run the old rules so
  // their stateHash reproduces byte for byte.
  if (s && s.antiStall && !actionAvailable(f.fighterId, action)) {
    s.events.push({ frame: s.frame, type: 'input_locked', by: side, action });
    return false;
  }
  const m = moveFor(f, action);
  if (!m) return false;
  if (m.meterCost && f.meter < m.meterCost) return false;
  // A dodge on cooldown simply does not come out. Like an unaffordable meter
  // move this does NOT consume the input, so the agent can try again next tick
  // instead of being punished for a timing it could not see.
  if (m.evade && f.dodgeCd > 0) return false;
  f.meter -= m.meterCost || 0;
  f.lastMove = action;
  f.moveId = action;
  f.moveFrame = 0;
  f.hasHit = false;
  f.hitIds = [];
  f.spentHit = false;
  f.spentHitIds = [];
  f.hitFrame = null;
  f.buffer = null;
  f.armorLeft = m.armor || 0;
  f.canceledFrom = null;
  f.vx = 0;
  f.counterWindow = 0;
  f.counterSpec = m.counter ? { ...m.counter } : null;
  // The body that carries its own horizontal speed for the active frames is
  // already modelled (`advance`); a backstep is the same mechanic with a
  // negative sign, so the dodge does not need a second travel implementation.
  f.advanceVx = m.advance ? m.advance.vx : (m.evade ? -m.evade.back : 0);
  f.spawned = false;
  if (m.invuln) f.invuln = Math.max(f.invuln, m.invuln);
  if (m.evade) f.dodgeCd = m.evade.cooldown;
  if (m.kind === 'movement') {
    f.state = 'dash';
    f.vx = f.facing * CONFIG.DASH_F;
  } else if (m.kind === 'defense') {
    // The defensive actions own their state name, so the renderer, the
    // observation and the guard predicates all read the same word.
    f.state = action;
  } else {
    f.state = m.kind === 'projectile' ? 'projectile' : 'attack';
  }
  if (m.superFlash) {
    s.superFlash = 30;
    s.events.push({ frame: s.frame, type: 'super_start', by: side, move: action, label: m.label });
  }
  s.events.push({
    frame: s.frame, type: 'move_start', by: side, move: action, label: m.label,
    meterCost: m.meterCost || 0, pose: m.pose || null, vfx: m.vfx || null,
    mechanic: mechanicsOf(m)[0], mechanics: mechanicsOf(m),
  });
  return true;
}

export function endMove(f) {
  f.state = f.y < 0 ? 'jump' : 'idle';
  f.moveId = null;
  f.moveFrame = 0;
  f.hasHit = false;
  f.hitIds = [];
  f.spentHit = false;
  f.spentHitIds = [];
  f.hitFrame = null;
  f.buffer = null;
  f.armorLeft = 0;
  f.canceledFrom = null;
  f.counterWindow = 0;
  f.counterSpec = null;
  f.advanceVx = 0;
  f.spawned = false;
  f.vx = 0;
}

export function tickFighter(f, action, s, side) {
  f.lastAction = action;
  if (f.wakeup > 0 || f.hitstun > 0 || f.blockstun > 0) return;

  const busy = isCommitted(f);
  if (busy) {
    const m = moveFor(f, f.moveId);
    const hitLanded = f.hasHit || (f.hitIds && f.hitIds.length > 0);
    // CANCEL: a landed normal can be canceled into the next link of the
    // ladder, and any move can be canceled into the meter moves. The window
    // opens on the connection frame, so a chain confirms the instant the hit
    // lands.
    //
    // The input is HELD, not dropped: agents decide once per tick (100 ms)
    // while a window is only a few frames wide, so throwing the input away
    // is what used to make chains impossible.
    const wants = isAttack(action) && action !== f.moveId && canAfford(f, action);
    const legal = wants && isCancelTarget(m, action, hitLanded);
    if (legal) {
      f.buffer = { action, age: 0 };
    } else if (f.buffer && (!isCancelTarget(m, f.buffer.action, hitLanded) || !canAfford(f, f.buffer.action))) {
      f.buffer = null;
    }
    const win = cancelWindowOf(m, f.hitFrame);
    const windowOpen = win.length > 0 && f.moveFrame >= win.openAt && f.moveFrame < win.until;
    const target = windowOpen ? (f.buffer ? f.buffer.action : (legal ? action : null)) : null;
    if (target && target !== f.moveId) {
      const from = f.moveId;
      const buffered = Boolean(f.buffer);
      if (startMove(f, target, s, side)) {
        f.canceledFrom = from;
        s.events.push({ frame: s.frame, type: 'cancel', by: side, from, into: target, buffered });
        return;
      }
    }
    if (f.buffer) {
      f.buffer.age += 1;
      if (f.buffer.age > CONFIG.CANCEL_BUFFER_FRAMES) f.buffer = null;
    }
    f.moveFrame += 1;
    const local = f.moveFrame - m.startup;
    // Counter stance: the window is open on the active frames only, so a
    // mistimed 当身 is just a 20-frame whiff.
    if (m.counter) {
      f.counterWindow = local >= 0 && local < m.active ? 1 : 0;
    }
    // Advancing strikes keep their own forward speed while the move runs.
    if (f.advanceVx && local >= 0 && local <= m.active) f.vx = f.facing * f.advanceVx;
    else if (f.advanceVx) f.vx = 0;
    // Any move may declare a projectile; the shape comes from its data.
    if (m.projectile && f.moveFrame === m.startup && !f.spawned) {
      f.spawned = true;
      spawnProjectiles(s, f, side, f.moveId, m.projectile);
    }
    if (f.moveFrame >= totalFor(f, f.moveId)) {
      // A held input that never found a window still fires when the move
      // ends: the fighter becomes actionable and the queued action runs.
      const from = f.moveId;
      const queued = f.buffer ? f.buffer.action : null;
      endMove(f);
      if (queued && queued !== from) {
        startMove(f, queued, s, side);
        f.canceledFrom = from;
        s.events.push({ frame: s.frame, type: 'cancel', by: side, from, into: queued, buffered: true });
      }
    }
    return;
  }

  const airborne = f.y < 0;
  if (airborne) {
    f.state = 'jump';
    if (isAttack(action)) startMove(f, action, s, side);
    return;
  }

  if (action === 'block') { f.state = 'guard'; f.vx = 0; return; }
  if (action === 'walk_f') { f.state = 'walk'; f.vx = f.facing * CONFIG.WALK_F; return; }
  if (action === 'walk_b') { f.state = 'walk'; f.vx = -f.facing * CONFIG.WALK_B; return; }
  if (action === 'crouch') { f.state = 'crouch'; f.vx = 0; return; }
  if (action === 'jump') { f.state = 'jump'; f.vy = CONFIG.JUMP_VY; f.vx = f.facing * CONFIG.JUMP_VX; return; }
  if (isDefense(action)) {
    // Grounded only (the airborne branch above returned already), and a
    // refused start leaves the fighter exactly where it was.
    startMove(f, action, s, side);
    return;
  }
  if (isAttack(action) || moveFor(f, action)?.kind === 'movement') {
    // Meter-gated moves simply fail to start if the bar is empty; the same
    // action next tick is not consumed. canAfford is exposed in observation.
    startMove(f, action, s, side);
    return;
  }
  f.state = 'idle';
  f.vx = 0;
}

/**
 * Spawn one or more projectiles from a move's `projectile` block. `stagger`
 * delays the follow-up shots so an EX volley reads as two beats, not a wall.
 */
export function spawnProjectiles(s, f, side, moveId, spec) {
  const count = spec.count || 1;
  for (let i = 0; i < count; i += 1) {
    const p = {
      id: side + '-' + s.frame + '-' + i,
      owner: side,
      move: moveId,
      x: f.x + f.facing * 44,
      y: spec.y,
      vx: f.facing * spec.speed,
      w: spec.w,
      h: spec.h,
      damage: spec.damage,
      hitstun: spec.hitstun,
      blockstun: spec.blockstun,
      hitstop: spec.hitstop || 4,
      knockdown: Boolean(spec.knockdown),
      life: spec.life || 110,
      delay: i * (spec.stagger || 0),
    };
    s.projectiles.push(p);
    s.events.push({
      frame: s.frame, type: 'spawn', by: side, move: moveId,
      x: Math.round(p.x), y: p.y, shape: spec.w > 60 ? 'beam' : 'orb',
    });
  }
}

export function physics(f) {
  f.x += f.vx;
  f.y += f.vy;
  if (f.y < 0) f.vy += CONFIG.GRAVITY;
  if (f.y < -CONFIG.AIR_CEILING) f.y = -CONFIG.AIR_CEILING;
  if (f.y >= 0) {
    f.y = 0;
    f.vy = 0;
    if (f.state === 'jump') f.state = 'idle';
  }
  f.x = clamp(f.x, CONFIG.STAGE_LEFT, CONFIG.STAGE_RIGHT);
  if (!MOMENTUM_STATES.includes(f.state) && !f.advanceVx) f.vx = 0;
}

export function resolvePush(a, b) {
  // Jumping over the opponent must stay possible: a high airborne fighter
  // does not collide with the grounded body it is crossing up. A downed body
  // is not an obstacle either — the opponent walks over it, genre-standard.
  if (a.y < -60 || b.y < -60) return;
  if (a.state === 'knockdown' || b.state === 'knockdown') return;
  const pa = pushboxFor(a);
  const pb = pushboxFor(b);
  if (!overlap(pa, pb)) return;
  const left = pa.x <= pb.x ? a : b;
  const right = left === a ? b : a;
  const pl = left === a ? pa : pb;
  const pr = left === a ? pb : pa;
  const depth = pl.x + pl.w - pr.x;
  if (depth <= 0) return;
  // Split the separation, then hand whatever a clamped (cornered) fighter
  // could not absorb to the free one. Halving without the transfer left a
  // permanent half-overlap whenever the pair was pushed into a wall.
  const leftFirst = clamp(left.x - Math.ceil(depth / 2), CONFIG.STAGE_LEFT, CONFIG.STAGE_RIGHT);
  const rightNew = clamp(right.x + depth - (left.x - leftFirst), CONFIG.STAGE_LEFT, CONFIG.STAGE_RIGHT);
  left.x = clamp(left.x - (depth - (rightNew - right.x)), CONFIG.STAGE_LEFT, CONFIG.STAGE_RIGHT);
  right.x = rightNew;
}
