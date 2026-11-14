/**
 * Frame data. All numbers are integers (fixed point), no floats, so every
 * match is byte-for-byte reproducible from (seed, action sequence).
 *
 * `hitboxes` are LOCAL rects anchored to a SKELETON JOINT (see combat.js).
 * x/y are the top-left offset from that joint, w/h the size, from/to are
 * active-frame offsets relative to `startup`. The kernel resolves hits by
 * AABB overlap of these boxes against hurtboxes derived from the opponent's
 * live skeleton. `range` is only a human/agent-facing reach hint now.
 *
 * Two tables live here and nowhere else:
 *
 *   MOVES   the universal action space — every fighter shares the same
 *           normals, dash, throw, dp, fireball and the defensive layer
 *           (block / crouch / dodge / parry), so a written strategy
 *           stays portable across the roster.
 *   the per-fighter meter skills live in ./kits/index.js and are resolved
 *           through `moveFor`, which prefers the fighter's own kit.
 */
import {
  CONFIG,
  CHAIN_LIGHT, CHAIN_MEDIUM, CHAIN_HEAVY, CANCEL_METER, CANCEL_SUPER_ONLY,
  CHAIN_NORMALS_LIGHT, CHAIN_NORMALS_MEDIUM, CHAIN_NORMALS_HEAVY,
} from './config.js';
import { FIGHTER_KITS } from './kits/index.js';

// The defensive layer is tuned in CONFIG (shared with the kits), so the move
// table reads it from there instead of growing a second set of literals.
const {
  DODGE_ACTIVE, DODGE_RECOVERY, DODGE_INVULN, DODGE_BACK_VX, DODGE_COOLDOWN, DODGE_METER,
  PARRY_ACTIVE, PARRY_RECOVERY, PARRY_METER,
} = CONFIG;

export { CONFIG };

export const ACTIONS = Object.freeze([
  'idle', 'walk_f', 'walk_b', 'jump', 'crouch',
  'lp', 'mp', 'hp', 'lk', 'mk', 'hk',
  'dp', 'fireball', 'block', 'throw',
  'dash', 'special', 'ex', 'super',
  // The active defensive layer (rules 2.1). Appended last so every existing
  // action keeps its index.
  'dodge', 'parry',
]);

export const MOVES = Object.freeze({
  lp: {
    kind: 'attack', pose: 'punch', startup: 3, active: 2, recovery: 7,
    damage: 38, range: 132, hitstun: 12, blockstun: 8, meterGain: 10, pushback: 5,
    height: 'mid', label: '轻拳', cancelInto: CHAIN_LIGHT, hitCancelInto: CHAIN_NORMALS_LIGHT, cancelWindow: 7, hitstop: 3,
    hitboxes: [{ anchor: 'handF', x: -6, y: -16, w: 34, h: 30, from: 0, to: 1, height: 'mid', hitId: 0 }],
  },
  mp: {
    kind: 'attack', pose: 'punch', startup: 6, active: 3, recovery: 12,
    damage: 68, range: 146, hitstun: 16, blockstun: 10, meterGain: 14, pushback: 8,
    height: 'mid', label: '中拳', cancelInto: CHAIN_MEDIUM, hitCancelInto: CHAIN_NORMALS_MEDIUM, cancelWindow: 8, hitstop: 4,
    hitboxes: [{ anchor: 'handF', x: -6, y: -20, w: 44, h: 34, from: 0, to: 2, height: 'mid', hitId: 0 }],
  },
  hp: {
    kind: 'attack', pose: 'punch', startup: 10, active: 4, recovery: 19,
    damage: 110, range: 158, hitstun: 20, blockstun: 12, meterGain: 18, pushback: 12,
    height: 'mid', label: '重拳', cancelInto: CHAIN_HEAVY, hitCancelInto: CHAIN_NORMALS_HEAVY, cancelWindow: 9, hitstop: 6,
    // No knockdown: a heavy normal that puts the opponent on the floor ends
    // the string before the special can come out, so the knockdown lives on
    // the launcher kick and on the skills instead.
    hitboxes: [{ anchor: 'handF', x: -8, y: -26, w: 54, h: 44, from: 0, to: 3, height: 'mid', hitId: 0 }],
  },
  lk: {
    kind: 'attack', pose: 'kick', startup: 4, active: 2, recovery: 8,
    damage: 34, range: 138, hitstun: 11, blockstun: 8, meterGain: 9, pushback: 5,
    height: 'low', label: '轻脚', cancelInto: CHAIN_LIGHT, hitCancelInto: CHAIN_NORMALS_LIGHT, cancelWindow: 7, hitstop: 3,
    hitboxes: [{ anchor: 'footF', x: -10, y: -18, w: 46, h: 26, from: 0, to: 1, height: 'low', hitId: 0 }],
  },
  mk: {
    kind: 'attack', pose: 'kick', startup: 7, active: 3, recovery: 13,
    damage: 62, range: 156, hitstun: 15, blockstun: 10, meterGain: 13, pushback: 9,
    height: 'low', label: '中脚', cancelInto: CHAIN_MEDIUM, hitCancelInto: CHAIN_NORMALS_MEDIUM, cancelWindow: 8, hitstop: 4,
    hitboxes: [{ anchor: 'footF', x: -10, y: -24, w: 60, h: 30, from: 0, to: 2, height: 'low', hitId: 0 }],
  },
  hk: {
    kind: 'attack', pose: 'kick', startup: 11, active: 4, recovery: 20,
    damage: 100, range: 176, hitstun: 19, blockstun: 12, meterGain: 17, pushback: 13,
    height: 'high', label: '重脚', cancelInto: CHAIN_HEAVY, hitCancelInto: CHAIN_NORMALS_HEAVY, cancelWindow: 9, hitstop: 6,
    knockdown: true, launch: true,
    hitboxes: [{ anchor: 'footF', x: -12, y: -52, w: 62, h: 58, from: 0, to: 3, height: 'high', hitId: 0 }],
  },
  dp: {
    kind: 'attack', pose: 'dp', startup: 3, active: 7, recovery: 24,
    damage: 135, range: 120, hitstun: 24, blockstun: 14, meterGain: 22, pushback: 14,
    height: 'high', label: '升龙', antiAir: true, invuln: 3, knockdown: true, launch: true,
    cancelInto: CANCEL_METER, cancelWindow: 10, hitstop: 7, vfx: 'burst',
    hitboxes: [{ anchor: 'hip', x: 0, y: -176, w: 96, h: 176, from: 0, to: 6, height: 'high', hitId: 0 }],
  },
  fireball: {
    kind: 'projectile', pose: 'projectile', startup: 12, active: 2, recovery: 22,
    damage: 58, range: 600, hitstun: 16, blockstun: 10, meterGain: 12, pushback: 9,
    height: 'mid', label: '波动', vfx: 'wave', cancelInto: CANCEL_METER, cancelWindow: 8,
    // No melee hitbox: the spawned projectile owns a hitbox (see projectileBox).
    projectile: { speed: 9, y: -116, w: 30, h: 40, damage: 58, hitstun: 16, blockstun: 10, hitstop: 4, life: 110 },
    hitboxes: [],
  },
  throw: {
    kind: 'attack', pose: 'throw', startup: 5, active: 2, recovery: 22,
    damage: 125, range: 152, hitstun: 26, blockstun: 0, meterGain: 16, pushback: 20,
    unblockable: true, knockdown: true, height: 'throw', label: '投技', hitstop: 6,
    // The answer to the whole defensive layer: a throw ignores guard AND the
    // dodge i-frames. It is the only way to punish someone who keeps reading
    // you, which is why its own recovery is the longest of the normals.
    breaksDodge: true,
    cancelInto: CANCEL_METER, cancelWindow: 8,
    // Reach spans the art-sized pushbox gap (up to 128u) plus the opponent's
    // near hurtbox edge; the old 46u box could never connect once bodies were
    // kept apart at their visible width.
    hitboxes: [{ anchor: 'chest', x: 0, y: -46, w: 146, h: 88, from: 0, to: 1, height: 'throw', unblockable: true, breaksDodge: true, hitId: 0 }],
  },
  dash: {
    kind: 'movement', pose: 'dash', startup: 0, active: 0, recovery: 9,
    damage: 0, range: 0, hitstun: 0, blockstun: 0, meterGain: 0, pushback: 0,
    label: '前冲', cancelInto: ['lp', 'mp', 'hp', 'lk', 'mk', 'hk', 'throw', 'special', 'ex', 'super'],
    cancelWindow: 9, hitboxes: [],
  },
  /**
   * 闪避 — the only action in the game whose whole purpose is to NOT be there.
   * Ten frames of invulnerability that double as the backstep (5 units per
   * frame = 50 units away), then eight frames of recovery in which the i-frames
   * are gone and you cannot act. A strike that lands inside the window is
   * EVAPORATED (event `evade`, +15 meter); a THROW is not, because
   * `breaksDodge` is a property of the incoming move, not a special case in the
   * kernel (see combat.js `defensiveVerdict`).
   */
  dodge: {
    kind: 'defense', pose: 'dodge', startup: 0, active: DODGE_ACTIVE, recovery: DODGE_RECOVERY,
    damage: 0, range: 0, hitstun: 0, blockstun: 0, meterGain: 0, pushback: 0,
    height: null, label: '闪避', invuln: DODGE_INVULN,
    evade: { back: DODGE_BACK_VX, cooldown: DODGE_COOLDOWN, meterGain: DODGE_METER },
    hitboxes: [],
  },
  /**
   * 招架 — the read-based version of blocking. It covers EVERY blockable
   * height (low / mid / high / overhead) and even dissipates a projectile, and
   * on success there is no damage, no chip, no blockstun: the defender is free
   * on the very next frame and banks 25 meter. Miss the eight-frame window and
   * the sixteen-frame recovery is NOT a guard, so the punish is full damage.
   * Throws break it, exactly like they break a dodge — the reward for reading
   * the opponent is what pays for the risk of guessing wrong.
   */
  parry: {
    kind: 'defense', pose: 'parry', startup: 0, active: PARRY_ACTIVE, recovery: PARRY_RECOVERY,
    damage: 0, range: 0, hitstun: 0, blockstun: 0, meterGain: 0, pushback: 0,
    height: null, label: '招架',
    parry: { meterGain: PARRY_METER, stopsProjectile: true },
    hitboxes: [],
  },
  special: {
    kind: 'attack', pose: 'special', startup: 8, active: 5, recovery: 18,
    damage: 96, range: 196, hitstun: 22, blockstun: 12, meterGain: 20, pushback: 16,
    height: 'mid', label: '专属技', cancelInto: CANCEL_METER, cancelWindow: 8, hitstop: 6,
    knockdown: true, vfx: 'signature',
    hitboxes: [{ anchor: 'handF', x: -12, y: -58, w: 86, h: 104, from: 0, to: 4, height: 'mid', hitId: 0 }],
  },
  ex: {
    kind: 'attack', pose: 'special', startup: 6, active: 6, recovery: 16,
    damage: 148, range: 176, hitstun: 26, blockstun: 16, meterGain: 0, pushback: 20,
    height: 'mid', label: 'EX 强化技', meterCost: CONFIG.EX_COST, armor: 1, invuln: 2,
    cancelInto: CANCEL_METER, cancelWindow: 9, hitstop: 8, knockdown: true, vfx: 'burst',
    hitboxes: [{ anchor: 'hip', x: -14, y: -178, w: 108, h: 176, from: 0, to: 5, height: 'mid', hitId: 0 }],
  },
  super: {
    kind: 'attack', pose: 'super', startup: 10, active: 12, recovery: 30,
    damage: 96, range: 280, hitstun: 18, blockstun: 16, meterGain: 0, pushback: 26,
    height: 'mid', label: '超必杀', meterCost: CONFIG.SUPER_COST, invuln: 6,
    multiHit: true, superFlash: true, grounded: true, hitstop: 8, knockdown: true, vfx: 'super',
    cancelInto: CANCEL_SUPER_ONLY, cancelWindow: 8,
    hitboxes: [
      { anchor: 'hip', x: 4, y: -196, w: 132, h: 194, from: 0, to: 2, height: 'mid', hitId: 0, damageScale: 0.8 },
      { anchor: 'hip', x: 4, y: -196, w: 160, h: 194, from: 4, to: 6, height: 'mid', hitId: 1, damageScale: 0.8 },
      { anchor: 'hip', x: 4, y: -200, w: 190, h: 200, from: 8, to: 11, height: 'mid', hitId: 2, damageScale: 1.4, knockdown: true, hitstop: 12 },
    ],
  },
});

/**
 * The move table a specific fighter fights with.
 *
 * `f` may be a fighter state (`fighterId`), a fighter definition (`id`) or a
 * kit id string. The fighter's own kit wins; the universal table is the
 * fallback for anything the kit does not define (and for custom fighters
 * that are not part of the roster). Everything the kernel resolves goes
 * through here, so a kit's frame data is what actually runs.
 */
export function moveFor(f, action) {
  const table = fighterMoves(f);
  return (table && table[action]) || MOVES[action];
}

function fighterMoves(f) {
  if (!f || typeof f === 'string') return null;
  const id = f.fighterId || f.id;
  const kit = id ? FIGHTER_KITS[id] : null;
  return kit ? kit.moves : null;
}

export function totalFor(f, action) {
  const m = moveFor(f, action);
  return m ? m.startup + m.active + m.recovery : 0;
}

/** Potential damage of a move: melee scales, or the projectile payload. */
export function moveDamage(m) {
  if (!m) return 0;
  if (m.counter) return m.counter.damage;
  if (m.projectile) return m.projectile.damage * (m.projectile.count || 1);
  return (m.hitboxes || []).reduce((n, hb) => n + Math.round(m.damage * (hb.damageScale || 1)), 0);
}

export function moveReach(m) {
  if (!m) return 0;
  if (m.projectile) return Math.min(640, m.range || 600);
  return m.range || 0;
}

/**
 * Every mechanic a move carries, ordered so the FIRST entry is the one that
 * names the move best: a five-hit advancing string is a "multi-hit" move that
 * happens to advance, not an "advance" move that happens to hit five times.
 */
export function mechanicsOf(m) {
  if (!m) return [];
  const out = [];
  // A defensive action is defined by what it avoids, so that is the mechanic
  // that names it — ahead of the backstep, which is just how the evade travels.
  if (m.kind === 'defense') out.push(m.parry ? 'parry' : 'evade');
  if (m.projectile) out.push('projectile');
  if (m.counter) out.push('counter');
  if (m.multiHit) out.push('multi-hit');
  if (m.advance || m.evade) out.push('advance');
  if (m.invuln) out.push('invuln');
  if (m.armor) out.push('armor');
  if (m.unblockable) out.push('unblockable');
  if (m.breaksDodge) out.push('breaks-dodge');
  if (m.knockdown) out.push('knockdown');
  if (m.launch) out.push('launch');
  if (!out.length) out.push('strike');
  return out;
}

/**
 * Which entries of the move table are OFFENCES.
 *
 * This used to be `kind !== 'movement'`, i.e. "anything that is not a dash".
 * That inference broke the moment the table gained a third family: a defensive
 * action is neither movement nor attack, and under the old rule it would have
 * been treated as a cancel target, an aerial attack and a whiffed move in the
 * training report. So the classification is a whitelist on `kind` now, and the
 * defensive layer is derived from the same table instead of a second list.
 */
export const ATTACK_ACTIONS = Object.freeze(
  Object.keys(MOVES).filter((id) => isAttackKind(MOVES[id])),
);

export const DEFENSE_ACTIONS = Object.freeze(
  Object.keys(MOVES).filter((id) => MOVES[id].kind === 'defense'),
);

function isAttackKind(m) {
  return Boolean(m) && (m.kind === 'attack' || m.kind === 'projectile');
}

/**
 * Which fighter states are COMMITTED to a move in flight.
 *
 * The kernel asked this question with its own inline list in four different
 * places (the busy branch, the frame-phase readout, the momentum rule and the
 * facing rule), which is exactly the kind of list that silently forgets the
 * next state. It lives here, beside the move table, and every caller reads it.
 */
export const COMMITTED_STATES = Object.freeze([
  'attack', 'projectile', 'special', 'dash', 'dodge', 'parry',
]);

/** States that keep their own horizontal speed between frames. */
export const MOMENTUM_STATES = Object.freeze(['walk', 'jump', 'dash']);

/** Is this fighter mid-move (so it cannot start another action this frame)? */
export function isCommitted(f) {
  return Boolean(f && f.moveId && COMMITTED_STATES.includes(f.state));
}

export function isDefense(action) {
  return Object.prototype.hasOwnProperty.call(MOVES, action) && MOVES[action].kind === 'defense';
}

/**
 * Is this fighter committed to an active defensive action right now?
 *
 * Kit-aware on purpose: a fighter could be handed its own `dodge` with
 * different frame data, and the answer has to follow the table it fights with.
 */
export function isDefending(f) {
  if (!f || !f.moveId) return false;
  if (f.state !== 'dodge' && f.state !== 'parry') return false;
  const m = moveFor(f, f.moveId);
  return Boolean(m && m.kind === 'defense');
}

export function moveTotal(id) {
  const m = MOVES[id];
  return m ? m.startup + m.active + m.recovery : 0;
}

export function isAttack(action) {
  if (!Object.prototype.hasOwnProperty.call(MOVES, action)) return false;
  return isAttackKind(MOVES[action]);
}

/**
 * The defensive layer as DATA, so `get_rules` publishes the matrix instead of
 * describing it in prose nobody checks. Five incoming kinds x four guards, and
 * every cell is what the kernel actually resolves in combat.js.
 */
export function defensiveRules() {
  const dodge = MOVES.dodge;
  const parry = MOVES.parry;
  return {
    version: CONFIG.RULES_VERSION,
    note: '防御不是二元。站防/蹲防安全但吃削血与硬直；招架读对了完全免伤并回大条气，读错了吃满伤；闪避用无敌帧穿过判定与弹道并拉出距离，但被投技破解。',
    actions: {
      block: {
        label: '站防', covers: ['mid', 'high', 'overhead'], losesTo: ['low', 'throw'],
        cost: '削血 max(1, 伤害/10) + blockstun，回 4 气；按住即持续防御',
      },
      crouch: {
        label: '蹲防', covers: ['low', 'mid'], losesTo: ['high', 'overhead', 'throw'],
        cost: '同站防；骨架压到 58%，高段拳会因框不相交而打空',
      },
      parry: {
        label: '招架', covers: ['low', 'mid', 'high', 'overhead', 'projectile'], losesTo: ['throw', 'unblockable'],
        window: parry.active, recovery: parry.recovery, meterGain: parry.parry.meterGain,
        cost: `窗口 ${parry.active} 帧（≥1 个决策拍）；空挥后 ${parry.recovery} 帧破绽期不是防御，被打中吃全额伤害`,
        reward: `无伤害 / 无削血 / 无 blockstun，防御方次帧即可行动并回 ${parry.parry.meterGain} 气；进攻方收招不变 → 白送一个确反`,
      },
      dodge: {
        label: '闪避', covers: ['strike-invuln', 'projectile-invuln'], losesTo: ['throw', 'breaksDodge'],
        invuln: dodge.invuln, active: dodge.active, recovery: dodge.recovery,
        back: dodge.evade.back, distance: dodge.evade.back * dodge.invuln,
        cooldown: dodge.evade.cooldown, meterGain: dodge.evade.meterGain,
        cost: `无敌只有前 ${dodge.invuln} 帧，之后 ${dodge.recovery} 帧可被抓；起手后 ${dodge.evade.cooldown} 帧内不能再闪（含闪避本体 ${dodge.active + dodge.recovery} 帧）`,
        reward: `判定/弹体整个消失（不结算削血），回 ${dodge.evade.meterGain} 气并后撤 ${dodge.evade.back * dodge.invuln} 单位`,
      },
    },
    matrix: [
      { incoming: 'low 拳脚', block: '破防吃满伤', crouch: '挡住(削血)', parry: '完全无效化(+25 气)', dodge: '无敌穿过(+15 气)' },
      { incoming: 'mid 拳脚', block: '挡住(削血)', crouch: '挡住(削血)', parry: '完全无效化(+25 气)', dodge: '无敌穿过(+15 气)' },
      { incoming: 'high / overhead', block: '挡住(削血)', crouch: '破防吃满伤', parry: '完全无效化(+25 气)', dodge: '无敌穿过(+15 气)' },
      { incoming: '飞行道具', block: '挡住(削 6)', crouch: '挡住(削 6)', parry: '消弹(+25 气)', dodge: '穿过并打散弹体(+15 气)' },
      { incoming: '投技 / unblockable', block: '破防', crouch: '破防', parry: '破防', dodge: '破防(breaksDodge)' },
    ],
    ownership: '这张表是说明，不是第二套规则：真正的裁定在 src/combat.js 的 guardResult() / defensiveVerdict()，招式上的 breaksDodge / unblockable 是数据。',
  };
}

export function canAfford(f, action) {
  const m = moveFor(f, action);
  return !m || !m.meterCost || f.meter >= m.meterCost;
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
