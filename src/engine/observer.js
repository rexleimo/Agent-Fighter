/** Deterministic state hashing and the read-only broadcast snapshot. */
import { createHash } from 'node:crypto';
import { CONFIG, moveFor } from '../rules.js';
import { skeletonFor, boxesFor, framePhase, parryWindowOpen, projectileBox } from '../combat.js';
import { stableStringify } from '../replay.js';

export function hashCore(state) {
  const pick = (f) => ({
    fighterId: f.fighterId, kit: f.kit,
    hp: f.hp, meter: f.meter, x: f.x, y: f.y, vx: f.vx, vy: f.vy, facing: f.facing,
    state: f.state, moveId: f.moveId, moveFrame: f.moveFrame, hasHit: f.hasHit,
    hitIds: f.hitIds, spentHit: f.spentHit, spentHitIds: f.spentHitIds,
    armorLeft: f.armorLeft, wakeup: f.wakeup,
    canceledFrom: f.canceledFrom, lastMove: f.lastMove,
    hitstun: f.hitstun, blockstun: f.blockstun, combo: f.combo, comboTimer: f.comboTimer,
    comboDamage: f.comboDamage, comboChain: f.comboChain,
    comboBest: f.comboBest, comboBestDamage: f.comboBestDamage,
    invuln: f.invuln, lastAction: f.lastAction, dodgeCd: f.dodgeCd,
    hitFrame: f.hitFrame, buffer: f.buffer,
    counterWindow: f.counterWindow, counterSpec: f.counterSpec,
    advanceVx: f.advanceVx, spawned: f.spawned,
    // rules 2.2 anti-stall fields are hashed only when the rule is active, so
    // 2.1 replays reproduce their original stateHash byte for byte. `antiStall`
    // itself is deliberately NOT in the hashed object (it is version metadata).
    ...(state.antiStall
      ? { passiveFrames: f.passiveFrames, stallLevel: f.stallLevel, aggression: f.aggression, damageDealt: f.damageDealt }
      : {}),
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
    // The defensive layer has to be readable on the broadcast, or a spectator
    // watching a dodge cannot tell why the hit evaporated.
    dodgeCd: f.dodgeCd, parrying: parryWindowOpen(f),
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
