import { createHash } from 'node:crypto';
import { CONFIG, MOVES, moveFor, totalFor, isAttack, canAfford, clamp, mechanicsOf } from './rules.js';
import { comboScale, cancelWindowOf, isCancelTarget } from './combo.js';
import { getFighter } from './fighters.js';
import {
  skeletonFor, boxesFor, hurtboxesFor, hitboxesFor, pushboxFor,
  projectileBox, overlap, firstOverlap, guardResult, framePhase,
} from './combat.js';
import { buildObservation, validateAction } from './protocol.js';
import { stableStringify, createReplay, appendTick, hashObject } from './replay.js';

function makeFighter(id, x, facing, fighterId = null) {
  const def = getFighter(fighterId || undefined);
  return {
    id, hp: CONFIG.MAX_HP, meter: 0,
    fighterId: def.id, kit: def.kit,
    x, y: 0, vx: 0, vy: 0, facing,
    state: 'idle', moveId: null, moveFrame: 0, hasHit: false,
    hitIds: [], armorLeft: 0, wakeup: 0, canceledFrom: null, lastMove: null,
    hitstun: 0, blockstun: 0, combo: 0, comboTimer: 0,
    comboDamage: 0, comboChain: [], comboBest: 0, comboBestDamage: 0,
    invuln: 0, lastAction: 'idle',
    // Combo state: `hitFrame` is the move frame the current move connected on
    // (it anchors the cancel window), `buffer` holds a cancel input that was
    // issued before its window opened.
    hitFrame: null, buffer: null,
    // Kit mechanics: a 当身 stance opens a window that turns one melee hit
    // around; an advancing strike keeps its own vx for the active frames.
    counterWindow: 0, counterSpec: null, advanceVx: 0, spawned: false,
  };
}

export function createInitialState(seed = 1, matchId = 'local', fighters = {}) {
  return {
    matchId,
    frame: 0,
    tick: 0,
    seed: seed >>> 0,
    rng: (seed >>> 0) || 1,
    fighters: { a: fighters.a || null, b: fighters.b || null },
    a: makeFighter('a', 300, 1, fighters.a),
    b: makeFighter('b', 660, -1, fighters.b),
    projectiles: [],
    hitstop: 0,
    superFlash: 0,
    over: false,
    winner: null,
    reason: null,
    events: [],
  };
}

function startMove(f, action, s, side) {
  const m = moveFor(f, action);
  if (!m) return false;
  if (m.meterCost && f.meter < m.meterCost) return false;
  f.meter -= m.meterCost || 0;
  f.lastMove = action;
  f.moveId = action;
  f.moveFrame = 0;
  f.hasHit = false;
  f.hitIds = [];
  f.hitFrame = null;
  f.buffer = null;
  f.armorLeft = m.armor || 0;
  f.canceledFrom = null;
  f.vx = 0;
  f.counterWindow = 0;
  f.counterSpec = m.counter ? { ...m.counter } : null;
  f.advanceVx = m.advance ? m.advance.vx : 0;
  f.spawned = false;
  if (m.invuln) f.invuln = Math.max(f.invuln, m.invuln);
  if (m.kind === 'movement') {
    f.state = 'dash';
    f.vx = f.facing * CONFIG.DASH_F;
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

function endMove(f) {
  f.state = f.y < 0 ? 'jump' : 'idle';
  f.moveId = null;
  f.moveFrame = 0;
  f.hasHit = false;
  f.hitIds = [];
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

function tickFighter(f, action, s, side) {
  f.lastAction = action;
  if (f.wakeup > 0 || f.hitstun > 0 || f.blockstun > 0) return;

  const busy = (f.state === 'attack' || f.state === 'projectile' || f.state === 'dash') && f.moveId;
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
function spawnProjectiles(s, f, side, moveId, spec) {
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

function physics(f) {
  f.x += f.vx;
  f.y += f.vy;
  if (f.y < 0) f.vy += CONFIG.GRAVITY;
  if (f.y >= 0) {
    f.y = 0;
    f.vy = 0;
    if (f.state === 'jump') f.state = 'idle';
  }
  f.x = clamp(f.x, CONFIG.STAGE_LEFT, CONFIG.STAGE_RIGHT);
  if (f.state !== 'walk' && f.state !== 'jump' && f.state !== 'dash' && !f.advanceVx) f.vx = 0;
}

function resolvePush(a, b) {
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

function applyDamage(s, atk, def, hb, atkSide, defSide) {
  const verdict = guardResult(def, hb);
  const point = {
    x: Math.round(hb.x + hb.w / 2),
    y: Math.round(hb.y + hb.h / 2),
  };
  const base = {
    frame: s.frame, by: atkSide, on: defSide, move: hb.move,
    x: point.x, y: point.y, height: hb.height,
  };
  if (verdict === 'block') {
    const chip = Math.max(1, Math.floor(hb.damage / 10));
    def.hp = Math.max(0, def.hp - chip);
    def.blockstun = hb.blockstun;
    def.state = 'guard';
    atk.meter = Math.min(CONFIG.MAX_METER, atk.meter + Math.floor(hb.meterGain / 2));
    def.meter = Math.min(CONFIG.MAX_METER, def.meter + 4);
    s.hitstop = Math.max(s.hitstop, Math.max(2, Math.floor(hb.hitstop / 2)));
    s.events.push({ ...base, type: 'block', damage: chip });
    return;
  }

  // Armor (EX): absorb one hit without entering hitstun.
  if (def.armorLeft > 0) {
    def.armorLeft -= 1;
    const dmg = Math.floor(hb.damage * 0.5);
    def.hp = Math.max(0, def.hp - dmg);
    atk.meter = Math.min(CONFIG.MAX_METER, atk.meter + Math.floor(hb.meterGain / 2));
    s.hitstop = Math.max(s.hitstop, hb.hitstop);
    s.events.push({ ...base, type: 'armor', damage: dmg });
    return;
  }

  def.hitstun = hb.hitstun;
  def.state = 'hitstun';
  def.moveId = null;
  def.moveFrame = 0;
  def.hasHit = false;
  def.hitIds = [];
  def.hitFrame = null;
  def.buffer = null;
  def.armorLeft = 0;
  def.vx = 0;
  // COMBO: a chain is the run of hits that land inside one combo window.
  // The count feeds the HUD, the chain feeds the "what did I actually do"
  // readout, and the damage of every hit past the fourth is scaled down so
  // a long chain stays worth landing without being a one-button kill.
  if (atk.comboTimer <= 0) {
    atk.combo = 0;
    atk.comboChain = [];
    atk.comboDamage = 0;
  }
  const scale = comboScale(atk.combo);
  const damage = Math.max(1, Math.round(hb.damage * scale));
  def.hp = Math.max(0, def.hp - damage);
  atk.combo += 1;
  atk.comboTimer = CONFIG.COMBO_FRAMES;
  atk.comboDamage += damage;
  atk.comboChain.push(hb.move);
  if (atk.combo > atk.comboBest) {
    atk.comboBest = atk.combo;
    atk.comboBestDamage = atk.comboDamage;
  }
  if (atk.combo === 2) {
    s.events.push({
      frame: s.frame, type: 'combo_start', by: atkSide, on: defSide,
      count: atk.combo, chain: atk.comboChain.slice(),
    });
  }
  atk.meter = Math.min(CONFIG.MAX_METER, atk.meter + hb.meterGain);
  def.meter = Math.min(CONFIG.MAX_METER, def.meter + Math.floor(hb.meterGain / 2));
  def.x = clamp(def.x + atk.facing * hb.pushback, CONFIG.STAGE_LEFT, CONFIG.STAGE_RIGHT);
  if (hb.knockdown) {
    def.state = 'knockdown';
    def.wakeup = CONFIG.WAKEUP_FRAMES;
    def.vy = hb.launch ? -7 : 0;
  }
  s.hitstop = Math.max(s.hitstop, hb.hitstop);
  const advantage = hb.hitstun - ((hb.moveTotal || totalFor(atk, hb.move)) - (atk.moveFrame || 0));
  s.events.push({
    ...base, type: 'hit', damage, combo: atk.combo, scale,
    comboDamage: atk.comboDamage, chain: atk.comboChain.slice(),
    frameAdvantage: advantage, knockdown: Boolean(hb.knockdown),
    part: hb.hurtPart || 'body',
  });
}

/**
 * 当身 (counter stance). A melee hit that lands inside the window is absorbed
 * and answered with the stance's own fixed damage. Throws and projectiles are
 * NOT counterable — that is the risk that pays for the reward.
 */
function resolveCounter(s, atk, def, hb, atkSide, defSide) {
  if (def.counterWindow <= 0 || !def.counterSpec) return false;
  if (hb.unblockable || hb.height === 'throw' || hb.move === 'fireball') return false;
  const spec = def.counterSpec;
  def.counterWindow = 0;
  def.invuln = Math.max(def.invuln, 6);
  atk.hasHit = true;
  atk.hitFrame = atk.moveFrame;
  atk.hp = Math.max(0, atk.hp - spec.damage);
  atk.hitstun = spec.hitstun;
  atk.state = 'hitstun';
  atk.moveId = null;
  atk.moveFrame = 0;
  atk.hitIds = [];
  atk.hitFrame = null;
  atk.buffer = null;
  atk.armorLeft = 0;
  atk.advanceVx = 0;
  atk.counterWindow = 0;
  atk.spawned = false;
  atk.vx = 0;
  atk.x = clamp(atk.x + def.facing * 12, CONFIG.STAGE_LEFT, CONFIG.STAGE_RIGHT);
  if (spec.knockdown) {
    atk.state = 'knockdown';
    atk.wakeup = CONFIG.WAKEUP_FRAMES;
    atk.vy = spec.launch ? -7 : 0;
  }
  def.meter = Math.min(CONFIG.MAX_METER, def.meter + 30);
  s.hitstop = Math.max(s.hitstop, 8);
  s.events.push({
    frame: s.frame, type: 'counter', by: defSide, on: atkSide, move: def.moveId,
    absorbed: hb.move, damage: spec.damage, x: Math.round(def.x), y: -120,
    knockdown: Boolean(spec.knockdown), launch: Boolean(spec.launch),
  });
  return true;
}

function resolveAttack(s, atkSide, defSide) {
  const atk = s[atkSide];
  const def = s[defSide];
  const hitboxes = hitboxesFor(atk, s.frame);
  if (!hitboxes.length || def.invuln > 0) return;
  const hurt = hurtboxesFor(def, s.frame);
  const pair = firstOverlap(hitboxes, hurt);
  if (!pair) return;
  const hb = { ...pair.hit, hurtPart: pair.hurt.part };
  if (resolveCounter(s, atk, def, hb, atkSide, defSide)) return;
  if (moveFor(atk, atk.moveId).multiHit) atk.hitIds.push(hb.hitId);
  else atk.hasHit = true;
  // The connection frame anchors the cancel window: from here on the move
  // can be canceled into the next link of the ladder.
  if (atk.hitFrame === null) atk.hitFrame = atk.moveFrame;
  applyDamage(s, atk, def, hb, atkSide, defSide);
}

function updateProjectiles(s) {
  const alive = [];
  for (const p of s.projectiles) {
    if (p.delay > 0) { p.delay -= 1; alive.push(p); continue; }
    p.x += p.vx;
    p.life -= 1;
    const defSide = p.owner === 'a' ? 'b' : 'a';
    const atk = s[p.owner];
    const def = s[defSide];
    const box = projectileBox(p);
    if (def.invuln <= 0 && firstOverlap([box], hurtboxesFor(def, s.frame))) {
      const verdict = guardResult(def, box);
      if (verdict === 'block') {
        def.hp = Math.max(0, def.hp - 6);
        def.blockstun = box.blockstun;
        def.state = 'guard';
        s.events.push({ frame: s.frame, type: 'block', by: p.owner, on: defSide, move: 'fireball', damage: 6, x: Math.round(p.x), y: box.y + box.h / 2 });
      } else {
        if (atk.comboTimer <= 0) {
          atk.combo = 0;
          atk.comboChain = [];
          atk.comboDamage = 0;
        }
        const scale = comboScale(atk.combo);
        const damage = Math.max(1, Math.round(box.damage * scale));
        def.hp = Math.max(0, def.hp - damage);
        def.hitstun = box.hitstun;
        def.state = 'hitstun';
        def.moveId = null;
        def.moveFrame = 0;
        def.hitFrame = null;
        def.buffer = null;
        def.advanceVx = 0;
        def.counterWindow = 0;
        def.x = clamp(def.x + Math.sign(p.vx) * 9, CONFIG.STAGE_LEFT, CONFIG.STAGE_RIGHT);
        if (box.knockdown) {
          def.state = 'knockdown';
          def.wakeup = CONFIG.WAKEUP_FRAMES;
        }
        atk.combo += 1;
        atk.comboTimer = CONFIG.COMBO_FRAMES;
        atk.comboDamage += damage;
        atk.comboChain.push(p.move || 'fireball');
        if (atk.combo > atk.comboBest) {
          atk.comboBest = atk.combo;
          atk.comboBestDamage = atk.comboDamage;
        }
        if (atk.combo === 2) {
          s.events.push({ frame: s.frame, type: 'combo_start', by: p.owner, on: defSide, count: atk.combo, chain: atk.comboChain.slice() });
        }
        atk.meter = Math.min(CONFIG.MAX_METER, atk.meter + 12);
        s.hitstop = Math.max(s.hitstop, box.hitstop);
        s.events.push({
          frame: s.frame, type: 'hit', by: p.owner, on: defSide, move: p.move || 'fireball',
          damage, combo: atk.combo, scale, comboDamage: atk.comboDamage,
          chain: atk.comboChain.slice(), frameAdvantage: 6,
          knockdown: Boolean(box.knockdown), x: Math.round(p.x), y: box.y + box.h / 2,
        });
      }
      continue;
    }
    if (p.life > 0 && p.x > CONFIG.STAGE_LEFT && p.x < CONFIG.STAGE_RIGHT) alive.push(p);
  }
  s.projectiles = alive;
}

/**
 * Facing may only change on a frame where the fighter is free to turn.
 *
 * Recomputing facing from relative position every frame — the obvious
 * implementation — makes a fighter spin around the instant it is crossed up,
 * which happens on every throw slam, every advancing strike and every knockdown
 * that carries it past the opponent. The animation keeps playing in the old
 * direction, so the sprite ends up attacking with its back to its target.
 *
 * Airborne, committed, stunned and knocked-down fighters therefore keep the
 * facing they took off with; they turn on the next neutral grounded frame.
 */
const TURNING_STATES = new Set(['idle', 'walk', 'crouch', 'guard']);

function reface(f, other) {
  if (!TURNING_STATES.has(f.state)) return;
  if (f.y !== 0 || f.vy !== 0) return;
  if (f.hitstun > 0 || f.blockstun > 0 || f.wakeup > 0) return;
  f.facing = other.x >= f.x ? 1 : -1;
}

export function step(state, rawA, rawB) {
  const s = structuredClone(state);
  s.events = [];
  s.frame += 1;

  // Hitstop freezes simulation but not the clock: deterministic, and the
  // browser gets a few identical frames to sell the impact.
  if (s.superFlash > 0) s.superFlash -= 1;
  if (s.hitstop > 0) {
    s.hitstop -= 1;
    return s;
  }

  const actionA = validateAction(rawA) ? rawA : 'idle';
  const actionB = validateAction(rawB) ? rawB : 'idle';

  reface(s.a, s.b);
  reface(s.b, s.a);

  tickFighter(s.a, actionA, s, 'a');
  tickFighter(s.b, actionB, s, 'b');

  physics(s.a);
  physics(s.b);
  resolvePush(s.a, s.b);
  updateProjectiles(s);
  resolveAttack(s, 'a', 'b');
  resolveAttack(s, 'b', 'a');

  let woke = false;
  for (const [side, f] of [['a', s.a], ['b', s.b]]) {
    if (f.hitstun > 0) {
      f.hitstun -= 1;
      if (f.hitstun === 0 && f.state === 'hitstun') f.state = 'idle';
    }
    if (f.blockstun > 0) {
      f.blockstun -= 1;
      if (f.blockstun === 0 && f.state === 'guard' && f.lastAction !== 'block') f.state = 'idle';
    }
    if (f.comboTimer > 0) {
      f.comboTimer -= 1;
      if (f.comboTimer === 0) {
        if (f.combo > 1) {
          s.events.push({
            frame: s.frame, type: 'combo_end', by: side,
            count: f.combo, damage: f.comboDamage, chain: f.comboChain.slice(),
          });
        }
        f.combo = 0;
        f.comboDamage = 0;
        f.comboChain = [];
      }
    }
    if (f.invuln > 0) f.invuln -= 1;
    if (f.wakeup > 0) {
      f.wakeup -= 1;
      if (f.wakeup === 0) {
        f.state = 'idle';
        f.vy = 0;
        f.y = 0;
        f.invuln = Math.max(f.invuln, CONFIG.WAKEUP_INVULN);
        woke = true;
        s.events.push({ frame: s.frame, type: 'wakeup', by: side });
      }
    }
  }
  // Wakeup flips knockdown -> idle AFTER the main push pass, which skips
  // downed bodies. Without this second pass a fighter standing on the body
  // interpenetrates for the one frame between getting up and the next push.
  if (woke) resolvePush(s.a, s.b);

  if (s.a.hp <= 0 || s.b.hp <= 0) {
    s.over = true;
    s.winner = s.a.hp <= 0 && s.b.hp <= 0 ? 'draw' : s.a.hp <= 0 ? 'b' : 'a';
    s.reason = 'ko';
    s.events.push({ frame: s.frame, type: 'ko', winner: s.winner });
  } else if (s.frame >= CONFIG.MATCH_TICKS * CONFIG.FRAMES_PER_TICK) {
    s.over = true;
    s.winner = s.a.hp === s.b.hp ? 'draw' : s.a.hp > s.b.hp ? 'a' : 'b';
    s.reason = 'time_up';
    s.events.push({ frame: s.frame, type: 'time_up', winner: s.winner });
  }
  return s;
}

function hashCore(state) {
  const pick = (f) => ({
    fighterId: f.fighterId, kit: f.kit,
    hp: f.hp, meter: f.meter, x: f.x, y: f.y, vx: f.vx, vy: f.vy, facing: f.facing,
    state: f.state, moveId: f.moveId, moveFrame: f.moveFrame, hasHit: f.hasHit,
    hitIds: f.hitIds, armorLeft: f.armorLeft, wakeup: f.wakeup,
    canceledFrom: f.canceledFrom, lastMove: f.lastMove,
    hitstun: f.hitstun, blockstun: f.blockstun, combo: f.combo, comboTimer: f.comboTimer,
    comboDamage: f.comboDamage, comboChain: f.comboChain,
    comboBest: f.comboBest, comboBestDamage: f.comboBestDamage,
    invuln: f.invuln, lastAction: f.lastAction,
    hitFrame: f.hitFrame, buffer: f.buffer,
    counterWindow: f.counterWindow, counterSpec: f.counterSpec,
    advanceVx: f.advanceVx, spawned: f.spawned,
  });
  return stableStringify({
    fighters: state.fighters,
    frame: state.frame, tick: state.tick, seed: state.seed,
    a: pick(state.a), b: pick(state.b), projectiles: state.projectiles,
    hitstop: state.hitstop, superFlash: state.superFlash,
    over: state.over, winner: state.winner, reason: state.reason,
  });
}

export function stateHash(state) {
  return createHash('sha256').update(hashCore(state)).digest('hex');
}

/** Read-only broadcast snapshot: skeleton + boxes are computed HERE, once. */
export function renderState(state) {
  const view = (f) => ({
    fighterId: f.fighterId, kit: f.kit, counterWindow: f.counterWindow,
    hp: f.hp, meter: f.meter, x: f.x, y: f.y, vx: f.vx, vy: f.vy, facing: f.facing,
    state: f.state, moveId: f.moveId, moveFrame: f.moveFrame,
    combo: f.combo, comboDamage: f.comboDamage, comboChain: f.comboChain.slice(),
    comboBest: f.comboBest, comboBestDamage: f.comboBestDamage,
    hitstun: f.hitstun, blockstun: f.blockstun,
    invuln: f.invuln, wakeup: f.wakeup, armorLeft: f.armorLeft,
    canceledFrom: f.canceledFrom, meterCost: f.moveId ? (moveFor(f, f.moveId).meterCost || 0) : 0,
    skeleton: skeletonFor(f, state.frame),
    boxes: boxesFor(f, state.frame),
    phase: framePhase(f),
  });
  return {
    frame: state.frame,
    tick: state.tick,
    timer: Math.max(0, CONFIG.ROUND_SECONDS - Math.floor(state.frame / CONFIG.FPS)),
    hitstop: state.hitstop,
    superFlash: state.superFlash,
    a: view(state.a),
    b: view(state.b),
    projectiles: state.projectiles.map((p) => ({
      x: p.x, y: p.y, owner: p.owner, move: p.move || 'fireball',
      delay: p.delay || 0, box: projectileBox(p),
    })),
    events: state.events.map((e) => ({ ...e })),
    over: state.over,
    winner: state.winner,
  };
}

export function createMatch({ seed = 1, matchId = 'local', agents = [], fighters = {}, ticks = CONFIG.MATCH_TICKS, rulesVersion = CONFIG.RULES_VERSION } = {}) {
  let state = createInitialState(seed, matchId, fighters);
  let tick = 0;
  let lastObsHash = { a: '', b: '' };
  const history = { a: [], b: [] };
  const replay = createReplay(matchId, seed, agents);
  replay.rulesVersion = rulesVersion;
  // Kits change frame data, so a replay is only reproducible with the same
  // two fighters recorded alongside it.
  replay.fighters = { a: state.fighters.a, b: state.fighters.b };

  return {
    get state() { return state; },
    get tick() { return tick; },
    get over() { return state.over; },
    get replay() { return replay; },
    get result() {
      return state.over
        ? { matchId, winner: state.winner, reason: state.reason, hpA: state.a.hp, hpB: state.b.hp, ticks: tick, frame: state.frame }
        : null;
    },
    observations(deadlineMs = CONFIG.TICK_MS) {
      const a = buildObservation(state, 'a', tick, deadlineMs, history.a, seed);
      const b = buildObservation(state, 'b', tick, deadlineMs, history.b, seed);
      lastObsHash = { a: hashObject(a), b: hashObject(b) };
      return { a, b };
    },
    advance(actionA, actionB, meta = {}) {
      const before = stateHash(state);
      const frames = [];
      const events = [];
      state.tick = tick;
      for (let i = 0; i < CONFIG.FRAMES_PER_TICK && !state.over; i += 1) {
        state = step(state, actionA, actionB);
        frames.push(renderState(state));
        if (state.events.length) events.push(...state.events.map((e) => ({ ...e, tick })));
      }
      history.a.push({ tick, action: actionA });
      history.b.push({ tick, action: actionB });
      appendTick(replay, {
        tick, frame: state.frame, seed,
        obsHashA: lastObsHash.a, obsHashB: lastObsHash.b,
        stateHashBefore: before,
        actionA, actionB,
        stateHashAfter: stateHash(state),
        meta,
      });
      tick += 1;
      return { frames, events, over: state.over, result: state.over ? this.result : null };
    },
  };
}

export function safePolicy(policy, obs, fallback = CONFIG.DEFAULT_ACTION) {
  try {
    const a = policy(obs);
    return validateAction(a) ? a : fallback;
  } catch {
    return fallback;
  }
}

export function runMatch({ seed = 1, matchId = 'local', policyA, policyB, defaultActionA = CONFIG.DEFAULT_ACTION, defaultActionB = CONFIG.DEFAULT_ACTION, ticks = CONFIG.MATCH_TICKS, agents = [], onTick = null } = {}) {
  const match = createMatch({ seed, matchId, agents, ticks });
  while (!match.over && match.tick < ticks) {
    const obs = match.observations();
    const actionA = safePolicy(policyA, obs.a, defaultActionA);
    const actionB = safePolicy(policyB, obs.b, defaultActionB);
    const out = match.advance(actionA, actionB, { sourceA: 'local', sourceB: 'local' });
    if (onTick) onTick({ tick: match.tick - 1, obs, actionA, actionB, ...out });
  }
  return { result: match.result, replay: match.replay, state: match.state };
}

export function renderReplay(replay) {
  let state = createInitialState(replay.seed, replay.matchId, replay.fighters || {});
  const ticks = [];
  for (const rec of replay.ticks) {
    state.tick = rec.tick;
    const frames = [];
    const events = [];
    const observation = buildObservation(state, 'a', rec.tick, CONFIG.TICK_MS, [], replay.seed);
    for (let i = 0; i < CONFIG.FRAMES_PER_TICK && !state.over; i += 1) {
      state = step(state, rec.actionA, rec.actionB);
      frames.push(renderState(state));
      if (state.events.length) events.push(...state.events.map((e) => ({ ...e, tick: rec.tick })));
    }
    ticks.push({ tick: rec.tick, frames, events, actions: { a: rec.actionA, b: rec.actionB }, observation });
  }
  return ticks;
}

export function replayMatch(replay) {
  let state = createInitialState(replay.seed, replay.matchId, replay.fighters || {});
  const mismatches = [];
  for (const rec of replay.ticks) {
    if (stateHash(state) !== rec.stateHashBefore) {
      mismatches.push({ tick: rec.tick, field: 'stateHashBefore' });
      break;
    }
    state.tick = rec.tick;
    for (let i = 0; i < CONFIG.FRAMES_PER_TICK && !state.over; i += 1) state = step(state, rec.actionA, rec.actionB);
    if (stateHash(state) !== rec.stateHashAfter) {
      mismatches.push({ tick: rec.tick, field: 'stateHashAfter' });
      break;
    }
  }
  return { ok: mismatches.length === 0, mismatches, ticks: replay.ticks.length, finalHash: stateHash(state) };
}
