/**
 * Shared tuning constants.
 *
 * These live in their own module because two independent tables need them:
 * the universal move table (rules.js) and the per-fighter skill kits
 * (kits.js). Putting them here keeps those two modules from importing each
 * other, which would be a cycle.
 */
export const CONFIG = Object.freeze({
  FPS: 60,
  FRAMES_PER_TICK: 6,
  TICK_MS: Number((typeof process !== 'undefined' && process.env.AFL_TICK_MS) || 100),
  MATCH_TICKS: 600,
  STAGE_WIDTH: 960,
  STAGE_LEFT: 40,
  STAGE_RIGHT: 920,
  GRAVITY: 1,
  MAX_HP: 1000,
  MAX_METER: 300,
  EX_COST: 50,
  SUPER_COST: 100,
  WAKEUP_FRAMES: 22,
  WAKEUP_INVULN: 8,
  // A cancel input that arrives before its window opens is held this long
  // instead of being dropped. Agents decide once per tick (100 ms) while the
  // window is a handful of frames wide, so a dropped input is a broken chain.
  CANCEL_BUFFER_FRAMES: 14,
  COMBO_FRAMES: 90,
  JUMP_VY: -15,
  JUMP_VX: 4,
  WALK_F: 4,
  WALK_B: 3,
  DASH_F: 13,
  ROUND_SECONDS: 60,
  DEFAULT_ACTION: 'block',
  RULES_VERSION: '2.0',
});

/**
 * Cancel ladders.
 *
 * A move can only be canceled into an action listed in its own `cancelInto`.
 * The normals form the KOF-style chain ladder light -> medium -> heavy; every
 * tier can additionally jump straight into the meter moves.
 *
 * Two lists per move, because they behave differently:
 *   `cancelInto`      every legal cancel target.
 *   `hitCancelInto`   the subset that additionally requires the move to have
 *                     CONNECTED. Walking a normal into another normal is a
 *                     hit-confirm chain; canceling into the meter moves is
 *                     allowed on a whiff as well (the classic chain cancel).
 */
export const CHAIN_NORMALS_LIGHT = Object.freeze(['mp', 'mk', 'hp', 'hk', 'dp']);
export const CHAIN_NORMALS_MEDIUM = Object.freeze(['hp', 'hk', 'dp']);
export const CHAIN_NORMALS_HEAVY = Object.freeze(['dp']);
export const CHAIN_LIGHT = Object.freeze([...CHAIN_NORMALS_LIGHT, 'special', 'ex', 'super']);
export const CHAIN_MEDIUM = Object.freeze([...CHAIN_NORMALS_MEDIUM, 'special', 'ex', 'super']);
export const CHAIN_HEAVY = Object.freeze([...CHAIN_NORMALS_HEAVY, 'special', 'ex', 'super']);
export const CANCEL_METER = Object.freeze(['special', 'ex', 'super']);
export const CANCEL_SUPER_ONLY = Object.freeze(['super']);
