import { createHash } from 'node:crypto';
import { CONFIG, MOVES, moveTotal, isAttack, canAfford, clamp } from './rules.js';
import {
  skeletonFor, boxesFor, hurtboxesFor, hitboxesFor, pushboxFor,
  projectileBox, overlap, firstOverlap, guardResult, framePhase,
} from './combat.js';
import { buildObservation, validateAction } from './protocol.js';
import { stableStringify, createReplay, appendTick, hashObject } from './replay.js';

function makeFighter(id, x, facing) {
  return {
    id, hp: CONFIG.MAX_HP, meter: 0,
    x, y: 0, vx: 0, vy: 0, facing,
    state: 'idle', moveId: null, moveFrame: 0, hasHit: false,
    hitIds: [], armorLeft: 0, wakeup: 0, canceledFrom: null, lastMove: null,
    hitstun: 0, blockstun: 0, combo: 0, comboTimer: 0,
    invuln: 0, lastAction: 'idle',
  };
}

export function createInitialState(seed = 1, matchId = 'local') {
  return {
    matchId,
    frame: 0,
    tick: 0,
    seed: seed >>> 0,
    rng: (seed >>> 0) || 1,
    a: makeFighter('a', 300, 1),
    b: makeFighter('b', 660, -1),
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
  const m = MOVES[action];
  if (!m) return false;
  if (m.meterCost && f.meter < m.meterCost) return false;
  f.meter -= m.meterCost || 0;
  f.lastMove = action;
  f.moveId = action;
  f.moveFrame = 0;
  f.hasHit = false;
  f.hitIds = [];
  f.armorLeft = m.armor || 0;
  f.canceledFrom = null;
  f.vx = 0;
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
  });
  return true;
}

function endMove(f) {
  f.state = f.y < 0 ? 'jump' : 'idle';
  f.moveId = null;
  f.moveFrame = 0;
  f.hasHit = false;
  f.hitIds = [];
  f.armorLeft = 0;
  f.canceledFrom = null;
  f.vx = 0;
}

function tickFighter(f, action, s, side) {
  f.lastAction = action;
  if (f.wakeup > 0 || f.hitstun > 0 || f.blockstun > 0) return;

  const busy = (f.state === 'attack' || f.state === 'projectile' || f.state === 'dash') && f.moveId;
  if (busy) {
    // CANCEL WINDOW: a landed normal can be canceled into a special / EX /
    // super, and a dash can be canceled into any normal. This is the combo
    // system, driven entirely by frame data in rules.js.
    const ph = framePhase(f);
    if (ph.cancelable && ph.cancelInto.includes(action) && isAttack(action) && canAfford(f, action)) {
      const from = f.moveId;
      if (startMove(f, action, s, side)) {
        f.canceledFrom = from;
        s.events.push({ frame: s.frame, type: 'cancel', by: side, from, into: action });
        return;
      }
    }
    f.moveFrame += 1;
    const m = MOVES[f.moveId];
    if (f.moveId === 'fireball' && f.moveFrame === m.startup && !f.hasHit) {
      f.hasHit = true;
      s.projectiles.push({
        id: side + '-' + s.frame,
        owner: side,
        x: f.x + f.facing * 44,
        y: -116,
        vx: f.facing * 9,
        damage: m.damage,
        hitstun: m.hitstun,
        blockstun: m.blockstun,
        hitstop: m.hitstop || 4,
        knockdown: false,
        life: 110,
      });
      s.events.push({ frame: s.frame, type: 'spawn', by: side, move: 'fireball', x: f.x + f.facing * 44, y: -116 });
    }
    if (f.moveFrame >= moveTotal(f.moveId)) endMove(f);
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
  if (isAttack(action) || MOVES[action]?.kind === 'movement') {
    // Meter-gated moves simply fail to start if the bar is empty; the same
    // action next tick is not consumed. canAfford is exposed in observation.
    startMove(f, action, s, side);
    return;
  }
  f.state = 'idle';
  f.vx = 0;
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
  if (f.state !== 'walk' && f.state !== 'jump' && f.state !== 'dash') f.vx = 0;
}

function resolvePush(a, b) {
  const pa = pushboxFor(a);
  const pb = pushboxFor(b);
  if (!overlap(pa, pb)) return;
  const dx = b.x - a.x;
  const minGap = (pa.w + pb.w) / 2;
  if (Math.abs(dx) < minGap) {
    const push = Math.ceil((minGap - Math.abs(dx)) / 2);
    const dir = dx >= 0 ? 1 : -1;
    a.x = clamp(a.x - dir * push, CONFIG.STAGE_LEFT, CONFIG.STAGE_RIGHT);
    b.x = clamp(b.x + dir * push, CONFIG.STAGE_LEFT, CONFIG.STAGE_RIGHT);
  }
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

  def.hp = Math.max(0, def.hp - hb.damage);
  def.hitstun = hb.hitstun;
  def.state = 'hitstun';
  def.moveId = null;
  def.moveFrame = 0;
  def.hasHit = false;
  def.hitIds = [];
  def.armorLeft = 0;
  def.vx = 0;
  atk.combo += 1;
  atk.comboTimer = 90;
  atk.meter = Math.min(CONFIG.MAX_METER, atk.meter + hb.meterGain);
  def.meter = Math.min(CONFIG.MAX_METER, def.meter + Math.floor(hb.meterGain / 2));
  def.x = clamp(def.x + atk.facing * hb.pushback, CONFIG.STAGE_LEFT, CONFIG.STAGE_RIGHT);
  if (hb.knockdown) {
    def.state = 'knockdown';
    def.wakeup = CONFIG.WAKEUP_FRAMES;
    def.vy = hb.launch ? -7 : 0;
  }
  s.hitstop = Math.max(s.hitstop, hb.hitstop);
  const advantage = hb.hitstun - (moveTotal(hb.move) - (atk.moveFrame || 0));
  s.events.push({
    ...base, type: 'hit', damage: hb.damage, combo: atk.combo,
    frameAdvantage: advantage, knockdown: Boolean(hb.knockdown),
    part: hb.hurtPart || 'body',
  });
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
  if (MOVES[atk.moveId].multiHit) atk.hitIds.push(hb.hitId);
  else atk.hasHit = true;
  applyDamage(s, atk, def, hb, atkSide, defSide);
}

function updateProjectiles(s) {
  const alive = [];
  for (const p of s.projectiles) {
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
        def.hp = Math.max(0, def.hp - box.damage);
        def.hitstun = box.hitstun;
        def.state = 'hitstun';
        def.moveId = null;
        def.moveFrame = 0;
        def.x = clamp(def.x + Math.sign(p.vx) * 9, CONFIG.STAGE_LEFT, CONFIG.STAGE_RIGHT);
        atk.meter = Math.min(CONFIG.MAX_METER, atk.meter + 12);
        s.hitstop = Math.max(s.hitstop, box.hitstop);
        s.events.push({ frame: s.frame, type: 'hit', by: p.owner, on: defSide, move: 'fireball', damage: box.damage, combo: 1, frameAdvantage: 6, x: Math.round(p.x), y: box.y + box.h / 2 });
      }
      continue;
    }
    if (p.life > 0 && p.x > CONFIG.STAGE_LEFT && p.x < CONFIG.STAGE_RIGHT) alive.push(p);
  }
  s.projectiles = alive;
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

  s.a.facing = s.b.x >= s.a.x ? 1 : -1;
  s.b.facing = -s.a.facing;

  tickFighter(s.a, actionA, s, 'a');
  tickFighter(s.b, actionB, s, 'b');

  physics(s.a);
  physics(s.b);
  resolvePush(s.a, s.b);
  updateProjectiles(s);
  resolveAttack(s, 'a', 'b');
  resolveAttack(s, 'b', 'a');

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
      if (f.comboTimer === 0) f.combo = 0;
    }
    if (f.invuln > 0) f.invuln -= 1;
    if (f.wakeup > 0) {
      f.wakeup -= 1;
      if (f.wakeup === 0) {
        f.state = 'idle';
        f.vy = 0;
        f.y = 0;
        f.invuln = Math.max(f.invuln, CONFIG.WAKEUP_INVULN);
        s.events.push({ frame: s.frame, type: 'wakeup', by: side });
      }
    }
  }

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
    hp: f.hp, meter: f.meter, x: f.x, y: f.y, vx: f.vx, vy: f.vy, facing: f.facing,
    state: f.state, moveId: f.moveId, moveFrame: f.moveFrame, hasHit: f.hasHit,
    hitIds: f.hitIds, armorLeft: f.armorLeft, wakeup: f.wakeup,
    canceledFrom: f.canceledFrom, lastMove: f.lastMove,
    hitstun: f.hitstun, blockstun: f.blockstun, combo: f.combo, comboTimer: f.comboTimer,
    invuln: f.invuln, lastAction: f.lastAction,
  });
  return stableStringify({
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
    hp: f.hp, meter: f.meter, x: f.x, y: f.y, facing: f.facing,
    state: f.state, moveId: f.moveId, moveFrame: f.moveFrame,
    combo: f.combo, hitstun: f.hitstun, blockstun: f.blockstun,
    invuln: f.invuln, wakeup: f.wakeup, armorLeft: f.armorLeft,
    canceledFrom: f.canceledFrom, meterCost: f.moveId ? (MOVES[f.moveId].meterCost || 0) : 0,
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
      x: p.x, y: p.y, owner: p.owner, move: 'fireball', box: projectileBox(p),
    })),
    events: state.events.map((e) => ({ ...e })),
    over: state.over,
    winner: state.winner,
  };
}

export function createMatch({ seed = 1, matchId = 'local', agents = [], ticks = CONFIG.MATCH_TICKS, rulesVersion = CONFIG.RULES_VERSION } = {}) {
  let state = createInitialState(seed, matchId);
  let tick = 0;
  let lastObsHash = { a: '', b: '' };
  const history = { a: [], b: [] };
  const replay = createReplay(matchId, seed, agents);
  replay.rulesVersion = rulesVersion;

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
  let state = createInitialState(replay.seed, replay.matchId);
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
  let state = createInitialState(replay.seed, replay.matchId);
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
