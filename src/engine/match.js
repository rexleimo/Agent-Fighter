/** Match driver, policy safety wrapper and replay reconstruction. */
import { CONFIG, versionAtLeast } from '../rules.js';
import { buildObservation, validateAction } from '../protocol.js';
import { createReplay, appendTick, hashObject } from '../replay.js';
import { createInitialState } from './fighter.js';
import { step } from './step.js';
import { stateHash, renderState } from './observer.js';

export function createMatch({ seed = 1, matchId = 'local', agents = [], fighters = {}, start = null, ticks = CONFIG.MATCH_TICKS, rulesVersion = CONFIG.RULES_VERSION } = {}) {
  let state = createInitialState(seed, matchId, fighters, start);
  state.antiStall = versionAtLeast(rulesVersion, '2.2');
  let tick = 0;
  let lastObsHash = { a: '', b: '' };
  const history = { a: [], b: [] };
  const replay = createReplay(matchId, seed, agents);
  replay.rulesVersion = rulesVersion;
  // Kits change frame data, so a replay is only reproducible with the same
  // two fighters recorded alongside it. Team rounds additionally carry the
  // hp/meter the round opened with.
  replay.fighters = { a: state.fighters.a, b: state.fighters.b };
  replay.start = start;

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
    observations(deadlineMs = CONFIG.TICK_MS, extra = null, extraB = null) {
      const a = buildObservation(state, 'a', tick, deadlineMs, history.a, seed, extra);
      const b = buildObservation(state, 'b', tick, deadlineMs, history.b, seed, extraB === null ? extra : extraB);
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

/**
 * Keep a policy reply inside the action whitelist. A non-callable policy uses
 * the same fallback as a malformed reply; there is no error boundary here, so
 * policies must return (rather than throw) on their own failure path.
 */
export function safePolicy(policy, obs, fallback = CONFIG.DEFAULT_ACTION) {
  if (typeof policy !== 'function') return fallback;
  const a = policy(obs);
  return validateAction(a) ? a : fallback;
}

export function runMatch({ seed = 1, matchId = 'local', policyA, policyB, defaultActionA = CONFIG.DEFAULT_ACTION, defaultActionB = CONFIG.DEFAULT_ACTION, ticks = CONFIG.MATCH_TICKS, agents = [], fighters = {}, rulesVersion = CONFIG.RULES_VERSION, onTick = null } = {}) {
  const match = createMatch({ seed, matchId, agents, fighters, ticks, rulesVersion });
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
  let state = createInitialState(replay.seed, replay.matchId, replay.fighters || {}, replay.start || null);
  state.antiStall = versionAtLeast(replay.rulesVersion, '2.2');
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
  let state = createInitialState(replay.seed, replay.matchId, replay.fighters || {}, replay.start || null);
  state.antiStall = versionAtLeast(replay.rulesVersion, '2.2');
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
