/** The authoritative frame step: facing, timers, hitstop and win conditions. */
import { CONFIG, isDefending, moveFor } from '../rules.js';
import { tickFighter, physics, resolvePush } from './fighter.js';
import { updateProjectiles, resolveAttack } from './attacks.js';
import { validateAction } from '../protocol.js';
import { updatePassivity, markDistance } from './passivity.js';

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
const TURNING_STATES = new Set(['idle', 'walk', 'crouch', 'guard', 'hitstun']);

/**
 * Facing follows the opponent whenever turning cannot swing a live hitbox to
 * the other side: neutral states, stun/blockstun, and a move's recovery tail.
 * Startup and active frames stay committed (flipping mid-swing teleported the
 * hitbox behind the character), and dashes, jumps and knockdowns keep their
 * take-off facing. Recovery is free because its boxes are gone, which removes
 * the long "both fighters with their backs to each other" window after a
 * whiffed fireball or a cross-up.
 */
function canTurn(f) {
  if (f.y !== 0 || f.vy !== 0 || f.wakeup > 0) return false;
  if (f.state === 'dash' || f.state === 'jump' || f.state === 'knockdown') return false;
  // A dodge slides backwards and a parry opens a guard in front of the body:
  // turning during either one would move the escape, or the catch, to the far
  // side of the fighter.
  if (isDefending(f)) return false;
  if (f.state === 'attack' || f.state === 'projectile' || f.state === 'special') {
    const m = f.moveId ? moveFor(f, f.moveId) : null;
    return Boolean(m) && (f.moveFrame || 0) >= m.startup + m.active;
  }
  return TURNING_STATES.has(f.state);
}

function reface(f, other) {
  if (!canTurn(f)) return;
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

  // Snapshot the pre-movement gap so passivity can tell an advancing walk_f /
  // dash from a retreating or stationary one.
  if (s.antiStall) markDistance(s);

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
      // A launched victim can outlast its stun in the air. Expiring it up there
      // dropped the fighter to idle mid-flight: the hurt drawing gave way to
      // the jump loop and the landing carried no reaction. Hold the last stun
      // frame until the body is back on the ground.
      if (f.hitstun === 1 && f.state === 'hitstun' && f.y < 0) {
        // held
      } else {
        f.hitstun -= 1;
        if (f.hitstun === 0 && f.state === 'hitstun') f.state = 'idle';
      }
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
    if (f.dodgeCd > 0) f.dodgeCd -= 1;
    if (f.wakeup > 0) {
      // Hold the getup clock while a launched body is still in the air: it
      // used to expire mid-flight, snap y to 0 and stand the fighter up in
      // the sky. Floor time should only start on landing.
      if (f.state === 'knockdown' && f.y < 0) {
        // held
      } else {
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
  }
  // Wakeup flips knockdown -> idle AFTER the main push pass, which skips
  // downed bodies. Without this second pass a fighter standing on the body
  // interpenetrates for the one frame between getting up and the next push.
  if (woke) resolvePush(s.a, s.b);

  // Anti-stall (rules 2.2): passive frames are counted after all action and
  // damage resolution, but before the win check, so a stall penalty on the
  // final frame is reflected in the result. Gated off for 2.1 replays.
  if (s.antiStall) {
    updatePassivity(s, 'a');
    updatePassivity(s, 'b');
  }

  if (s.a.hp <= 0 || s.b.hp <= 0) {
    s.over = true;
    s.winner = s.a.hp <= 0 && s.b.hp <= 0 ? 'draw' : s.a.hp <= 0 ? 'b' : 'a';
    s.reason = 'ko';
    s.events.push({ frame: s.frame, type: 'ko', winner: s.winner });
  } else if (s.frame >= CONFIG.MATCH_TICKS * CONFIG.FRAMES_PER_TICK) {
    s.over = true;
    // Four-level time-up chain (rules 2.2). The first level that separates the
    // fighters wins; only a genuinely even, damage-free, equally passive match
    // ends in a double loss. 2.1 replays keep the old HP-only rule.
    let winner;
    let reason;
    if (!s.antiStall) {
      winner = s.a.hp === s.b.hp ? 'draw' : s.a.hp > s.b.hp ? 'a' : 'b';
      reason = 'time_up';
    } else if (s.a.hp !== s.b.hp) {
      winner = s.a.hp > s.b.hp ? 'a' : 'b';
      reason = 'time_up';
    } else if (s.a.damageDealt !== s.b.damageDealt) {
      winner = s.a.damageDealt > s.b.damageDealt ? 'a' : 'b';
      reason = 'time_up_damage';
    } else if (s.a.aggression !== s.b.aggression) {
      winner = s.a.aggression > s.b.aggression ? 'a' : 'b';
      reason = 'time_up_aggression';
    } else {
      winner = 'double_loss';
      reason = 'time_up_stall';
    }
    s.winner = winner;
    s.reason = reason;
    s.events.push({ frame: s.frame, type: 'time_up', winner, reason });
  }
  return s;
}
