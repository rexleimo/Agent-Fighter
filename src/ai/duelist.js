import { ACTIONS } from '../rules.js';

/**
 * Advanced "duelist" bot — a stateful, aggressive fighting AI for the
 * exhibition rooms. It is still deterministic behaviour (no LLM, 100 ms ticks,
 * replay-safe): the observation carries `seed` + `tick`, so all variation is a
 * seeded PRNG. Nothing here calls a model or reads the clock.
 *
 * What makes it feel like a person rather than a robot:
 *  - committed combos: a landed normal is cancelled into the next legal link
 *    of the chain ladder all the way to special / super (real hit-confirms);
 *  - spacing intent: closes with dashes, stops at its style's preferred range;
 *  - reactions with cooldowns: anti-air, throw-on-evade, whiff-punish and EX
 *    are gated so a true condition can't turn into a 200x spam loop;
 *  - rhythm: seeded mix-ups in the opening normal and approach tempo, so two
 *    duelists trade initiative instead of repeating one loop.
 *
 * The policy is a closure with per-match memory. Replays store the resulting
 * ACTIONS, so playback stays deterministic.
 */

const CHAIN_NEXT = Object.freeze({
  lp: 'mp', mp: 'hp', lk: 'mk', mk: 'hk', hk: 'dp', hp: 'special',
  special: 'super', ex: 'super',
});

/** Fast xorshift PRNG seeded from the match seed + side salt. */
function rng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

/** Next legal link of a landed move, or null when the string must end. */
function chainLink(o) {
  const fd = o.frameData || {};
  const s = o.self;
  if (!fd.moveId || !fd.hitLanded) return null;
  let next = CHAIN_NEXT[fd.moveId];
  if (!next) return null;
  if (next === 'super' && !s.canSuper) next = s.canEx ? 'ex' : null;
  if (!next) return null;
  return (s.cancelInto || []).includes(next) ? next : null;
}

/**
 * @param {'rushdown'|'footsies'} style
 *   rushdown — closes hard, pressures with fast normals into combos.
 *   footsies — holds a slightly longer range, whiff-punishes, mixes fireballs.
 */
export function createDuelist(style = 'rushdown') {
  const rush = style !== 'footsies';
  const preferred = rush ? 104 : 146;   // desired striking distance
  const cd = { antiAir: 0, throw: 0, special: 0, fireball: 0, super: 0 };
  let seedSeen = null;
  let rand = rng(1);
  let lastAction = null;
  let sameCount = 0;

  return function duelist(o) {
    const s = o.self || {};
    const der = o.derived || {};
    // const tick = o.tick || 0;

    if (seedSeen !== o.seed) { seedSeen = o.seed; rand = rng((o.seed >>> 0) ^ (rush ? 0x1234 : 0xabcd)); }
    for (const k of Object.keys(cd)) if (cd[k] > 0) cd[k] -= 1;

    const dist = der.distanceX ?? 999;
    const act = s.actionable === true;
    const inMyRange = (id) => der.inRange?.[id] === true;
    const hold = () => (s.moveId ? s.moveId : 'block');
    const REPEAT_CAP = 6;

    // Advance repetition tracking; if one action sticks too long, reset spacing.
    const step = (action) => {
      if (action === lastAction) sameCount += 1; else sameCount = 1;
      lastAction = action;
      return action;
    };
    const throttled = (action, cdKey, ticks) => {
      if (cdKey) cd[cdKey] = ticks;
      return step(action);
    };

    // If we've looped the same action, force a neutral approach/retreat.
    const breakLoop = () => (dist > preferred ? 'walk_f' : 'walk_b');

    // --- 1. Survival: can't act while stunned ---
    if (s.hitstun > 0 || s.blockstun > 0) return 'block';

    // --- 2. Combo: a CONFIRMED hit cancels into the next legal link ---
    if (!act) {
      const link = chainLink(o);
      return link || hold();
    }
    const link = chainLink(o);
    if (link) return throttled(link, null, 0);

    // --- 3. Reactions (all gated by cooldown + actionable) ---
    if (act) {
      if (der.opponentEvading && dist < 160 && cd.throw === 0 && inMyRange('throw')) {
        return throttled('throw', 'throw', 10);
      }
      if (der.threat === 'jump_in' && inMyRange('dp') && cd.antiAir === 0) {
        return throttled('dp', 'antiAir', 14);
      }
      if (der.projectileIncoming && dist < 170) {
        return step(rand() < 0.5 && s.canEx ? 'ex' : 'jump');
      }
      if (der.boxOverlap && s.canEx) return step('ex');
      if (der.punishable && dist < 170 && inMyRange('hp')) return step('hp');
    }

    // --- 4. Super finisher: occasional, not every time meter is full ---
    if (act && s.canSuper && dist < 230 && cd.super === 0 && rand() < 0.35) {
      return throttled('super', 'super', 22);
    }

    // --- 5. Spacing approach ---
    if (dist > 300 && act) return step('dash');
    if (dist > preferred + 24) return step('walk_f');
    if (!rush && dist < 90 && rand() < 0.5) return step('walk_b');

    // --- 6. In range: open a string with a mix of normals ---
    if (act && (inMyRange('lp') || inMyRange('mp') || inMyRange('hp'))) {
      if (sameCount > REPEAT_CAP) return breakLoop();
      const roll = rand();
      if (roll < 0.5) return step('lp');
      if (roll < 0.7) return step('lk');
      if (roll < 0.85) return step('mp');
      return step('hp');
    }
    if (act && inMyRange('mk')) return step('mk');

    // --- 7. Fireball / special at range, throttled, footsies only ---
    if (act && !rush && dist > 150 && dist < 520 && cd.fireball === 0 && rand() < 0.3) {
      return throttled('fireball', 'fireball', 16);
    }
    if (act && cd.special === 0 && inMyRange('special') && rand() < 0.4) {
      return throttled('special', 'special', 16);
    }

    // --- 8. Default: keep the pressure on, never default to passive block ---
    if (!act) return hold();
    if (dist > preferred) return step('walk_f');
    return step('walk_b');
  };
}
