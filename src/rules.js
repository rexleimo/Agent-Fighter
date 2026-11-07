/**
 * Frame data. All numbers are integers (fixed point), no floats, so every
 * match is byte-for-byte reproducible from (seed, action sequence).
 *
 * `hitboxes` are LOCAL rects anchored to a SKELETON JOINT (see combat.js).
 * x/y are the top-left offset from that joint, w/h the size, from/to are
 * active-frame offsets relative to `startup`. The kernel resolves hits by
 * AABB overlap of these boxes against hurtboxes derived from the opponent's
 * live skeleton. `range` is only a human/agent-facing reach hint now.
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
  JUMP_VY: -15,
  JUMP_VX: 4,
  WALK_F: 4,
  WALK_B: 3,
  DASH_F: 13,
  ROUND_SECONDS: 60,
  DEFAULT_ACTION: 'block',
  RULES_VERSION: '2.0',
});

export const ACTIONS = Object.freeze([
  'idle', 'walk_f', 'walk_b', 'jump', 'crouch',
  'lp', 'mp', 'hp', 'lk', 'mk', 'hk',
  'dp', 'fireball', 'block', 'throw',
  'dash', 'special', 'ex', 'super',
]);

const CANCEL_BASIC = ['special', 'ex', 'super', 'dp'];
const CANCEL_HEAVY = ['special', 'ex', 'super'];
const CANCEL_SPECIAL = ['super'];

export const MOVES = Object.freeze({
  lp: {
    kind: 'attack', pose: 'punch', startup: 3, active: 2, recovery: 7,
    damage: 38, range: 132, hitstun: 12, blockstun: 8, meterGain: 10, pushback: 5,
    height: 'mid', label: '轻拳', cancelInto: CANCEL_BASIC, cancelWindow: 7, hitstop: 3,
    hitboxes: [{ anchor: 'handF', x: -6, y: -16, w: 34, h: 30, from: 0, to: 1, height: 'mid', hitId: 0 }],
  },
  mp: {
    kind: 'attack', pose: 'punch', startup: 6, active: 3, recovery: 12,
    damage: 68, range: 146, hitstun: 16, blockstun: 10, meterGain: 14, pushback: 8,
    height: 'mid', label: '中拳', cancelInto: CANCEL_BASIC, cancelWindow: 8, hitstop: 4,
    hitboxes: [{ anchor: 'handF', x: -6, y: -20, w: 44, h: 34, from: 0, to: 2, height: 'mid', hitId: 0 }],
  },
  hp: {
    kind: 'attack', pose: 'punch', startup: 10, active: 4, recovery: 19,
    damage: 110, range: 158, hitstun: 20, blockstun: 12, meterGain: 18, pushback: 12,
    height: 'mid', label: '重拳', cancelInto: CANCEL_HEAVY, cancelWindow: 9, hitstop: 6, knockdown: true,
    hitboxes: [{ anchor: 'handF', x: -8, y: -26, w: 54, h: 44, from: 0, to: 3, height: 'mid', hitId: 0 }],
  },
  lk: {
    kind: 'attack', pose: 'kick', startup: 4, active: 2, recovery: 8,
    damage: 34, range: 138, hitstun: 11, blockstun: 8, meterGain: 9, pushback: 5,
    height: 'low', label: '轻脚', cancelInto: CANCEL_BASIC, cancelWindow: 7, hitstop: 3,
    hitboxes: [{ anchor: 'footF', x: -10, y: -18, w: 46, h: 26, from: 0, to: 1, height: 'low', hitId: 0 }],
  },
  mk: {
    kind: 'attack', pose: 'kick', startup: 7, active: 3, recovery: 13,
    damage: 62, range: 156, hitstun: 15, blockstun: 10, meterGain: 13, pushback: 9,
    height: 'low', label: '中脚', cancelInto: CANCEL_BASIC, cancelWindow: 8, hitstop: 4,
    hitboxes: [{ anchor: 'footF', x: -10, y: -24, w: 60, h: 30, from: 0, to: 2, height: 'low', hitId: 0 }],
  },
  hk: {
    kind: 'attack', pose: 'kick', startup: 11, active: 4, recovery: 20,
    damage: 100, range: 176, hitstun: 19, blockstun: 12, meterGain: 17, pushback: 13,
    height: 'high', label: '重脚', cancelInto: CANCEL_HEAVY, cancelWindow: 9, hitstop: 6,
    knockdown: true, launch: true,
    hitboxes: [{ anchor: 'footF', x: -12, y: -52, w: 62, h: 58, from: 0, to: 3, height: 'high', hitId: 0 }],
  },
  dp: {
    kind: 'attack', pose: 'dp', startup: 3, active: 7, recovery: 24,
    damage: 135, range: 120, hitstun: 24, blockstun: 14, meterGain: 22, pushback: 14,
    height: 'high', label: '升龙', antiAir: true, invuln: 3, knockdown: true, launch: true,
    cancelInto: CANCEL_SPECIAL, cancelWindow: 10, hitstop: 7, vfx: 'burst',
    hitboxes: [{ anchor: 'hip', x: 0, y: -176, w: 96, h: 176, from: 0, to: 6, height: 'high', hitId: 0 }],
  },
  fireball: {
    kind: 'projectile', pose: 'projectile', startup: 12, active: 2, recovery: 22,
    damage: 58, range: 600, hitstun: 16, blockstun: 10, meterGain: 12, pushback: 9,
    height: 'mid', label: '波动', vfx: 'wave',
    // No melee hitbox: the spawned projectile owns a hitbox (see projectileBox).
    projectile: { speed: 9, y: -116, w: 30, h: 40, damage: 58, hitstun: 16, blockstun: 10, hitstop: 4, life: 110 },
    hitboxes: [],
  },
  throw: {
    kind: 'attack', pose: 'throw', startup: 5, active: 2, recovery: 22,
    damage: 125, range: 74, hitstun: 26, blockstun: 0, meterGain: 16, pushback: 20,
    unblockable: true, knockdown: true, height: 'throw', label: '投技', hitstop: 6,
    hitboxes: [{ anchor: 'chest', x: 0, y: -46, w: 46, h: 88, from: 0, to: 1, height: 'throw', unblockable: true, hitId: 0 }],
  },
  dash: {
    kind: 'movement', pose: 'dash', startup: 0, active: 0, recovery: 9,
    damage: 0, range: 0, hitstun: 0, blockstun: 0, meterGain: 0, pushback: 0,
    label: '前冲', cancelInto: ['lp', 'mp', 'hp', 'lk', 'mk', 'hk', 'throw', 'special', 'ex', 'super'],
    cancelWindow: 9, hitboxes: [],
  },
  special: {
    kind: 'attack', pose: 'special', startup: 8, active: 5, recovery: 18,
    damage: 96, range: 196, hitstun: 22, blockstun: 12, meterGain: 20, pushback: 16,
    height: 'mid', label: '专属技', cancelInto: CANCEL_SPECIAL, cancelWindow: 8, hitstop: 6,
    knockdown: true, vfx: 'signature',
    hitboxes: [{ anchor: 'handF', x: -12, y: -58, w: 86, h: 104, from: 0, to: 4, height: 'mid', hitId: 0 }],
  },
  ex: {
    kind: 'attack', pose: 'special', startup: 6, active: 6, recovery: 16,
    damage: 148, range: 176, hitstun: 26, blockstun: 16, meterGain: 0, pushback: 20,
    height: 'mid', label: 'EX 强化技', meterCost: CONFIG.EX_COST, armor: 1, invuln: 2,
    cancelInto: CANCEL_SPECIAL, cancelWindow: 9, hitstop: 8, knockdown: true, vfx: 'burst',
    hitboxes: [{ anchor: 'hip', x: -14, y: -178, w: 108, h: 176, from: 0, to: 5, height: 'mid', hitId: 0 }],
  },
  super: {
    kind: 'attack', pose: 'super', startup: 10, active: 12, recovery: 30,
    damage: 96, range: 280, hitstun: 18, blockstun: 16, meterGain: 0, pushback: 26,
    height: 'mid', label: '超必杀', meterCost: CONFIG.SUPER_COST, invuln: 6,
    multiHit: true, superFlash: true, hitstop: 8, knockdown: true, vfx: 'super',
    hitboxes: [
      { anchor: 'hip', x: 4, y: -196, w: 132, h: 194, from: 0, to: 2, height: 'mid', hitId: 0, damageScale: 0.8 },
      { anchor: 'hip', x: 4, y: -196, w: 160, h: 194, from: 4, to: 6, height: 'mid', hitId: 1, damageScale: 0.8 },
      { anchor: 'hip', x: 4, y: -200, w: 190, h: 200, from: 8, to: 11, height: 'mid', hitId: 2, damageScale: 1.4, knockdown: true, hitstop: 12 },
    ],
  },
});

/**
 * Character kits (B1).
 *
 * Every fighter shares the same ACTION space — the agent-facing verbs never
 * change, so a written strategy stays portable and ranked mirror matches stay
 * fair. What differs per fighter is *which mechanics the three meter skills
 * use*:
 *
 *   rush      closes distance with an advancing strike
 *   volley    zoning projectile (EX fires a staggered pair, super is a beam)
 *   counter   parry stance: absorbs one melee hit and answers with a fixed hit
 *   antiAir   invulnerable rising uppercut, the jump-in answer
 *   multi     multi-hit string with the widest cancel window
 *
 * `KIT_BALANCE` is the contract these numbers must satisfy; verify-combat
 * asserts the real frame data sits inside those bands, so a kit cannot be
 * buffed by accident without renegotiating the budget on purpose.
 */
export const KIT_IDS = Object.freeze(['rush', 'volley', 'counter', 'antiAir', 'multi']);

const CANCEL_SUPER_ONLY = ['super'];

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

export const KITS = Object.freeze({
  rush: {
    id: 'rush',
    label: '突进压制',
    blurb: '带身位前冲的强攻技：命中即倒，距离越近收益越高。',
    tags: ['advance', 'knockdown', 'close-range'],
    moves: {
      special: {
        kind: 'attack', pose: 'rush', startup: 10, active: 4, recovery: 22,
        damage: 112, range: 150, hitstun: 24, blockstun: 14, meterGain: 20, pushback: 12,
        height: 'mid', label: '突进', cancelInto: CANCEL_SUPER_ONLY, cancelWindow: 8, hitstop: 6,
        knockdown: true, vfx: 'rush', advance: { vx: 7 },
        hitboxes: [{ anchor: 'handF', x: -14, y: -70, w: 96, h: 112, from: 0, to: 3, height: 'mid', hitId: 0 }],
      },
      ex: {
        kind: 'attack', pose: 'rush', startup: 8, active: 5, recovery: 20,
        damage: 156, range: 158, hitstun: 26, blockstun: 16, meterGain: 0, pushback: 16,
        height: 'mid', label: 'EX 突进', meterCost: CONFIG.EX_COST, armor: 1,
        cancelInto: CANCEL_SUPER_ONLY, cancelWindow: 9, hitstop: 8, knockdown: true,
        vfx: 'rush', advance: { vx: 9 },
        hitboxes: [{ anchor: 'handF', x: -16, y: -78, w: 108, h: 124, from: 0, to: 4, height: 'mid', hitId: 0 }],
      },
      super: {
        kind: 'attack', pose: 'rush', startup: 12, active: 10, recovery: 28,
        damage: 96, range: 200, hitstun: 18, blockstun: 16, meterGain: 0, pushback: 20,
        height: 'mid', label: '奥义 · 突进', meterCost: CONFIG.SUPER_COST, invuln: 6,
        multiHit: true, superFlash: true, hitstop: 8, knockdown: true, vfx: 'super',
        advance: { vx: 8 },
        hitboxes: [
          { anchor: 'hip', x: -6, y: -196, w: 150, h: 196, from: 0, to: 2, height: 'mid', hitId: 0, damageScale: 0.7 },
          { anchor: 'hip', x: -6, y: -196, w: 176, h: 196, from: 4, to: 6, height: 'mid', hitId: 1, damageScale: 0.7 },
          { anchor: 'hip', x: -6, y: -200, w: 208, h: 200, from: 8, to: 9, height: 'mid', hitId: 2, damageScale: 1.6, knockdown: true, hitstop: 12 },
        ],
      },
    },
  },

  volley: {
    id: 'volley',
    label: '波动牵制',
    blurb: '把对手钉在中远距离：EX 连发两发，奥义是一道横向光柱。',
    tags: ['projectile', 'zoning', 'range'],
    moves: {
      special: {
        kind: 'projectile', pose: 'volley', startup: 12, active: 2, recovery: 24,
        damage: 62, range: 600, hitstun: 16, blockstun: 10, meterGain: 14, pushback: 9,
        height: 'mid', label: '波动', cancelInto: CANCEL_SUPER_ONLY, cancelWindow: 8,
        vfx: 'wave',
        projectile: { speed: 10, y: -116, w: 34, h: 44, damage: 62, hitstun: 16, blockstun: 10, hitstop: 4, life: 120 },
        hitboxes: [],
      },
      ex: {
        kind: 'projectile', pose: 'volley', startup: 10, active: 2, recovery: 22,
        damage: 55, range: 620, hitstun: 18, blockstun: 12, meterGain: 0, pushback: 10,
        height: 'mid', label: 'EX 波动', meterCost: CONFIG.EX_COST,
        cancelInto: CANCEL_SUPER_ONLY, cancelWindow: 9, vfx: 'wave',
        projectile: { speed: 11, y: -116, w: 38, h: 48, damage: 55, hitstun: 18, blockstun: 12, hitstop: 5, life: 120, count: 2, stagger: 4 },
        hitboxes: [],
      },
      super: {
        kind: 'projectile', pose: 'volley', startup: 14, active: 2, recovery: 34,
        damage: 150, range: 640, hitstun: 26, blockstun: 18, meterGain: 0, pushback: 24,
        height: 'mid', label: '奥义 · 光柱', meterCost: CONFIG.SUPER_COST, invuln: 4,
        superFlash: true, knockdown: true, vfx: 'super',
        projectile: { speed: 13, y: -122, w: 96, h: 92, damage: 150, hitstun: 26, blockstun: 18, hitstop: 8, life: 120, knockdown: true },
        hitboxes: [],
      },
    },
  },

  counter: {
    id: 'counter',
    label: '当身反击',
    blurb: '架住一次近身攻击并把伤害还回去；对飞行道具无效，赌对了才赚。',
    tags: ['parry', 'counter', 'punish'],
    moves: {
      special: {
        kind: 'attack', pose: 'counter', startup: 4, active: 12, recovery: 20,
        damage: 130, range: 120, hitstun: 24, blockstun: 12, meterGain: 12, pushback: 10,
        height: 'mid', label: '当身', cancelInto: CANCEL_SUPER_ONLY, cancelWindow: 8,
        vfx: 'ring', counter: { damage: 130, hitstun: 24, knockdown: true },
        hitboxes: [],
      },
      ex: {
        kind: 'attack', pose: 'counter', startup: 3, active: 16, recovery: 18,
        damage: 172, range: 130, hitstun: 26, blockstun: 14, meterGain: 0, pushback: 12,
        height: 'mid', label: 'EX 当身', meterCost: CONFIG.EX_COST, invuln: 4,
        cancelInto: CANCEL_SUPER_ONLY, cancelWindow: 9, vfx: 'ring',
        counter: { damage: 172, hitstun: 26, knockdown: true },
        hitboxes: [],
      },
      super: {
        kind: 'attack', pose: 'counter', startup: 5, active: 20, recovery: 26,
        damage: 250, range: 150, hitstun: 30, blockstun: 18, meterGain: 0, pushback: 18,
        height: 'mid', label: '奥义 · 反照', meterCost: CONFIG.SUPER_COST, invuln: 8,
        superFlash: true, vfx: 'super',
        counter: { damage: 250, hitstun: 30, knockdown: true },
        hitboxes: [],
      },
    },
  },

  antiAir: {
    id: 'antiAir',
    label: '升龙对空',
    blurb: '起手无敌的上升拳：专治跳入，落地即被罚。',
    tags: ['invuln', 'anti-air', 'launcher'],
    moves: {
      special: {
        kind: 'attack', pose: 'antiAir', startup: 3, active: 7, recovery: 26,
        damage: 120, range: 132, hitstun: 24, blockstun: 14, meterGain: 22, pushback: 14,
        height: 'high', label: '升龙', cancelInto: CANCEL_SUPER_ONLY, cancelWindow: 10,
        hitstop: 7, invuln: 4, knockdown: true, launch: true, antiAir: true, vfx: 'burst',
        hitboxes: [{ anchor: 'hip', x: -4, y: -180, w: 100, h: 182, from: 0, to: 6, height: 'high', hitId: 0 }],
      },
      ex: {
        kind: 'attack', pose: 'antiAir', startup: 2, active: 8, recovery: 24,
        damage: 162, range: 140, hitstun: 26, blockstun: 16, meterGain: 0, pushback: 16,
        height: 'high', label: 'EX 升龙', meterCost: CONFIG.EX_COST, invuln: 6, armor: 1,
        cancelInto: CANCEL_SUPER_ONLY, cancelWindow: 9, hitstop: 8, knockdown: true,
        launch: true, antiAir: true, vfx: 'burst',
        hitboxes: [{ anchor: 'hip', x: -6, y: -190, w: 112, h: 192, from: 0, to: 7, height: 'high', hitId: 0 }],
      },
      super: {
        kind: 'attack', pose: 'antiAir', startup: 4, active: 12, recovery: 30,
        damage: 96, range: 160, hitstun: 20, blockstun: 16, meterGain: 0, pushback: 20,
        height: 'high', label: '奥义 · 天冲', meterCost: CONFIG.SUPER_COST, invuln: 8,
        multiHit: true, superFlash: true, hitstop: 8, knockdown: true, launch: true,
        antiAir: true, vfx: 'super',
        hitboxes: [
          { anchor: 'hip', x: -6, y: -190, w: 118, h: 192, from: 0, to: 3, height: 'high', hitId: 0, damageScale: 0.9 },
          { anchor: 'hip', x: -8, y: -206, w: 140, h: 208, from: 6, to: 11, height: 'high', hitId: 1, damageScale: 1.4, knockdown: true, hitstop: 12 },
        ],
      },
    },
  },

  multi: {
    id: 'multi',
    label: '多段连击',
    blurb: '同一招里挂多段判定，收招还能接超必杀；单段不重，但全中很痛。',
    tags: ['multi-hit', 'combo', 'cancel'],
    moves: {
      special: {
        kind: 'attack', pose: 'multi', startup: 8, active: 8, recovery: 20,
        damage: 100, range: 196, hitstun: 20, blockstun: 12, meterGain: 18, pushback: 8,
        height: 'mid', label: '连段', cancelInto: CANCEL_SUPER_ONLY, cancelWindow: 10,
        multiHit: true, vfx: 'signature',
        hitboxes: [
          { anchor: 'handF', x: -12, y: -58, w: 86, h: 104, from: 0, to: 3, height: 'mid', hitId: 0, damageScale: 0.5 },
          { anchor: 'handF', x: -14, y: -66, w: 96, h: 112, from: 5, to: 7, height: 'mid', hitId: 1, damageScale: 0.85 },
        ],
      },
      ex: {
        kind: 'attack', pose: 'multi', startup: 6, active: 10, recovery: 18,
        damage: 118, range: 200, hitstun: 22, blockstun: 14, meterGain: 0, pushback: 10,
        height: 'mid', label: 'EX 连段', meterCost: CONFIG.EX_COST,
        cancelInto: CANCEL_SUPER_ONLY, cancelWindow: 10, hitstop: 6, multiHit: true, vfx: 'burst',
        hitboxes: [
          { anchor: 'handF', x: -12, y: -58, w: 88, h: 104, from: 0, to: 2, height: 'mid', hitId: 0, damageScale: 0.45 },
          { anchor: 'handF', x: -14, y: -66, w: 96, h: 112, from: 4, to: 6, height: 'mid', hitId: 1, damageScale: 0.45 },
          { anchor: 'hip', x: -6, y: -150, w: 120, h: 152, from: 8, to: 9, height: 'mid', hitId: 2, damageScale: 0.75, knockdown: true },
        ],
      },
      super: {
        kind: 'attack', pose: 'multi', startup: 10, active: 12, recovery: 30,
        damage: 90, range: 240, hitstun: 18, blockstun: 16, meterGain: 0, pushback: 14,
        height: 'mid', label: '奥义 · 百裂', meterCost: CONFIG.SUPER_COST, invuln: 6,
        multiHit: true, superFlash: true, hitstop: 6, vfx: 'super',
        hitboxes: [
          { anchor: 'handF', x: -8, y: -60, w: 92, h: 108, from: 0, to: 2, height: 'mid', hitId: 0, damageScale: 0.5 },
          { anchor: 'handF', x: -10, y: -62, w: 96, h: 110, from: 3, to: 5, height: 'mid', hitId: 1, damageScale: 0.5 },
          { anchor: 'hip', x: -8, y: -150, w: 128, h: 152, from: 6, to: 7, height: 'mid', hitId: 2, damageScale: 0.6 },
          { anchor: 'hip', x: -8, y: -160, w: 140, h: 162, from: 8, to: 9, height: 'mid', hitId: 3, damageScale: 0.6 },
          { anchor: 'hip', x: -10, y: -176, w: 176, h: 178, from: 10, to: 11, height: 'mid', hitId: 4, damageScale: 0.8, knockdown: true, hitstop: 12 },
        ],
      },
    },
  },
});

/**
 * Balance contract: damage / reach bands each kit must sit inside. The bands
 * encode the trade — rush trades reach for damage, volley trades damage for
 * range, counter trades whiff risk for the single biggest answer.
 */
export const KIT_BALANCE = Object.freeze({
  rush: { special: [100, 125], ex: [145, 175], super: [260, 310], reach: [120, 180] },
  volley: { special: [50, 80], ex: [95, 125], super: [140, 175], reach: [240, 640] },
  counter: { special: [120, 145], ex: [160, 190], super: [230, 280], reach: [120, 220] },
  antiAir: { special: [110, 130], ex: [150, 180], super: [200, 250], reach: [120, 220] },
  multi: { special: [125, 145], ex: [180, 210], super: [250, 300], reach: [150, 220] },
});

export const SKILL_ACTIONS = Object.freeze(['special', 'ex', 'super']);

export function isValidKit(id) {
  return Object.prototype.hasOwnProperty.call(KITS, id);
}

/** Skill moves of a kit, or null for an unknown kit. */
export function kitMoves(kit) {
  const k = KITS[kit];
  return k ? k.moves : null;
}

/**
 * The move table a specific fighter fights with. `f` may be a fighter state
 * (has `kit`) or a kit id. Everything the kernel resolves must go through
 * this, so a kit's frame data is what actually runs.
 */
export function moveFor(f, action) {
  const kit = typeof f === 'string' ? f : (f && f.kit);
  const table = kitMoves(kit);
  return (table && table[action]) || MOVES[action];
}

export function totalFor(f, action) {
  const m = moveFor(f, action);
  return m ? m.startup + m.active + m.recovery : 0;
}

export const ATTACK_ACTIONS = Object.freeze(
  Object.keys(MOVES).filter((id) => MOVES[id].kind !== 'movement'),
);

export function moveTotal(id) {
  const m = MOVES[id];
  return m ? m.startup + m.active + m.recovery : 0;
}

export function isAttack(action) {
  return Object.prototype.hasOwnProperty.call(MOVES, action) && MOVES[action].kind !== 'movement';
}

export function canAfford(f, action) {
  const m = MOVES[action];
  return !m || !m.meterCost || f.meter >= m.meterCost;
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
