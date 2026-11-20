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
  // Knockdown launch impulse. A grounded body only: applied in mid-air it
  // restarted the rise from wherever the victim already was, so each juggle hit
  // lifted the fighter another arc until the sprite left the stage.
  LAUNCH_VY: -7,
  // Highest a body can be above the floor. The stage draws the sprite cell 253px
  // above the feet, so this plus GROUND has to stay inside the canvas; verify-
  // render locks that arithmetic. A jump peaks at 112, so the clamp only ever
  // fires on a mis-tuned impulse.
  AIR_CEILING: 170,
  WALK_F: 4,
  WALK_B: 3,
  DASH_F: 13,
  ROUND_SECONDS: 60,
  // Anti-stall: a fighter that never engages must not be able to coast to a
  // draw on equal HP. The default action advances instead of standing guard,
  // so "do nothing" is never the server's idea of a strategy (rules 2.2).
  DEFAULT_ACTION: 'walk_f',
  // --- defensive layer (rules 2.1): 闪避 / 招架 -------------------------------
  // Agents decide once per tick (FRAMES_PER_TICK frames), so every defensive
  // window below is at least one tick wide: a 3-frame parry would be a dice
  // roll for a client that only gets ten decisions a second.
  DODGE_ACTIVE: 10,
  DODGE_RECOVERY: 8,
  DODGE_INVULN: 10,
  // The i-frames and the backstep cover the SAME frames, so what you see is
  // what is safe: 10 frames x 5 units = 50 units away from the attacker.
  DODGE_BACK_VX: 5,
  // Counted from the frame the dodge starts, so it covers the 18-frame move
  // itself: after landing there are still DODGE_COOLDOWN - 18 frames of vacuum.
  DODGE_COOLDOWN: 30,
  DODGE_METER: 15,
  PARRY_ACTIVE: 8,
  PARRY_RECOVERY: 16,
  PARRY_METER: 25,
  RULES_VERSION: '2.2',
  // --- anti-stall (rules 2.2) ------------------------------------------------
  // Passive = no attack, no closing distance, not being pressured. Three
  // seconds earns a warning; five seconds starts draining HP and gifting the
  // opponent meter. HP is clamped to >= 1 so stalling never produces a KO.
  STALL_WARN_FRAMES: 180,
  STALL_PENALTY_FRAMES: 300,
  STALL_DRAIN_HP: 20,
  STALL_METER_GIFT: 10,
  // --- matchmaking ----------------------------------------------------------
  // Opponent scoring: lower cost wins. Recent repeats and the last opponent
  // are penalised; waiting earns a credit so a lone registrant is not stuck.
  // REMATCH_HOLD_MS pauses an immediate rematch while another ranked room is
  // still running, so the two groups can cross over.
  RECENT_WINDOW: 6,
  REPEAT_PENALTY: 3,
  LAST_OPPONENT_PENALTY: 10,
  WAIT_CAP_MS: 60000,
  WAIT_CREDIT_MS: 5000,
  REMATCH_HOLD_MS: Number((typeof process !== 'undefined' && process.env.AFL_REMATCH_HOLD_MS) || 45000),
});

/**
 * Numeric dotted-version comparison, so rule gating never relies on string
 * ordering (`'2.10' < '2.2'` is true as strings). Missing segments are zero.
 */
export function versionAtLeast(version, minimum) {
  const a = String(version || '0').split('.').map((n) => Number(n) || 0);
  const b = String(minimum).split('.').map((n) => Number(n) || 0);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return true;
}

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
