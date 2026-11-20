/**
 * Anti-stall passivity accounting (rules 2.2).
 *
 * A fighter is ACTIVE when it does any of: start an attack (even one that gets
 * blocked or evaded), close distance with walk_f/dash, is being pressured
 * (hitstun / blockstun / knockdown / wakeup), or defends an attacking opponent.
 * Everything else accumulates passive frames. Crossing the warn / penalty
 * thresholds emits events for the HUD and the settlement counter; an active
 * frame clears the streak (HP already drained is never refunded).
 *
 * This module is pure: it mutates only the two fighter records passed in via
 * the state and reads no clock or RNG. Determinism is a hard invariant.
 */
import { CONFIG, isAttack, isDefense } from '../rules.js';

const STUNNED = new Set(['hitstun', 'blockstun', 'knockdown']);
const GUARD_STATES = new Set(['guard', 'crouch', 'dodge', 'parry']);

/** Was an attack/hit event produced for `side` on this frame? */
function frameHadAttack(s, side) {
  for (const e of s.events) {
    if (e.by !== side) continue;
    if (e.type === 'move_start' && e.move && isAttack(e.move)) return true;
    if (e.type === 'hit' && e.damage > 0) return true;
  }
  return false;
}

/** Did `side` actively defend an opponent who is attacking this frame? */
function defendedAttack(s, f, otherSide) {
  const opp = s[otherSide];
  const oppAttacking = opp.state === 'attack' || isAttack(opp.lastAction);
  const defending = GUARD_STATES.has(f.state) || isDefense(f.lastAction);
  return oppAttacking && defending;
}

export function updatePassivity(s, side) {
  const f = s[side];
  const other = side === 'a' ? 'b' : 'a';

  const closing = (f.lastAction === 'walk_f' || f.lastAction === 'dash')
    && Math.abs(s.a.x - s.b.x) < f._passivePrevDistance;
  const pressured = STUNNED.has(f.state) || f.wakeup > 0;
  const active = frameHadAttack(s, side)
    || closing
    || pressured
    || defendedAttack(s, f, other);

  if (active) {
    f.aggression += 1;
    f.passiveFrames = 0;
    f.stallLevel = 0;
    return;
  }

  f.passiveFrames += 1;
  if (f.passiveFrames === CONFIG.STALL_WARN_FRAMES) {
    f.stallLevel = 1;
    s.events.push({ frame: s.frame, type: 'stall_warning', by: side });
  }
  if (f.passiveFrames >= CONFIG.STALL_PENALTY_FRAMES) {
    const wasPenalised = f.stallLevel >= 2;
    f.stallLevel = 2;
    // Drain on the threshold frame, then once every FPS frames. Clamp at 1 so
    // passivity never produces a KO - that would be an ugly, undeserved death.
    if (!wasPenalised || (f.passiveFrames - CONFIG.STALL_PENALTY_FRAMES) % CONFIG.FPS === 0) {
      f.hp = Math.max(1, f.hp - CONFIG.STALL_DRAIN_HP);
      s[other].meter = Math.min(CONFIG.MAX_METER, s[other].meter + CONFIG.STALL_METER_GIFT);
      s.events.push({ frame: s.frame, type: 'stall_penalty', by: side, hp: f.hp });
    }
  }
}

/**
 * Snapshot the pre-movement distance so `updatePassivity` can tell whether a
 * walk_f/dash actually closed the gap. Called once per frame before physics.
 */
export function markDistance(s) {
  s.a._passivePrevDistance = Math.abs(s.a.x - s.b.x);
  s.b._passivePrevDistance = s.a._passivePrevDistance;
}
