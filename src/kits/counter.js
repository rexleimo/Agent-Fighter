/**
 * Counter archetype — 当身 (parry stance).
 *
 * The stance has no hitbox of its own. While it is open (the active frames),
 * a melee hit that lands is ABSORBED and answered with the stance's own
 * damage. Projectiles and throws are never counterable — that is the risk
 * that pays for the reward.
 *
 *   slag    molten mid answer, plain and heavy
 *   coral   the answer does NOT knock down: the opponent stays in hitstun
 *   basalt  launcher answer: the opponent is knocked down AND lifted
 *   noct    a dodge-in stance — the EX version starts invulnerable
 */
import { CONFIG, CANCEL_METER, CANCEL_SUPER_ONLY } from '../config.js';

export const counter = {
  id: 'counter',
  label: '当身反击',
  blurb: '架住一次近身攻击并把伤害还回去；对飞行道具无效，赌对了才赚。',
  tags: ['parry', 'counter', 'punish'],
  fighters: {
    slag: {
      label: '熔铸当身',
      blurb: '架住就熔回去：伤害最高的一段，但窗口只有一次机会。',
      moves: {
        special: {
          kind: 'attack', pose: 'counter', startup: 6, active: 12, recovery: 20,
          damage: 130, range: 120, hitstun: 24, blockstun: 12, meterGain: 12, pushback: 10,
          height: 'mid', label: '熔渣当身', cancelInto: CANCEL_METER, cancelWindow: 8, hitstop: 6,
          vfx: 'ring', counter: { damage: 130, hitstun: 24, knockdown: true },
          hitboxes: [],
        },
        ex: {
          kind: 'attack', pose: 'counter', startup: 5, active: 16, recovery: 18,
          damage: 172, range: 130, hitstun: 26, blockstun: 14, meterGain: 0, pushback: 12,
          height: 'mid', label: '熔铁重反击', meterCost: CONFIG.EX_COST, armor: 1,
          cancelInto: CANCEL_METER, cancelWindow: 9, hitstop: 7, vfx: 'ring',
          counter: { damage: 172, hitstun: 26, knockdown: true },
          hitboxes: [],
        },
        super: {
          kind: 'attack', pose: 'super', startup: 8, active: 18, recovery: 24,
          damage: 255, range: 150, hitstun: 30, blockstun: 18, meterGain: 0, pushback: 18,
          height: 'mid', label: '熔炉爆发', meterCost: CONFIG.SUPER_COST, invuln: 8,
          superFlash: true, grounded: true, vfx: 'super',
          counter: { damage: 255, hitstun: 30, knockdown: true },
          hitboxes: [],
        },
      },
    },

    coral: {
      label: '礁环当身',
      blurb: '反弹但不击倒：把对手留在僵直里，你可以再打一轮。',
      moves: {
        special: {
          kind: 'attack', pose: 'counter', startup: 7, active: 12, recovery: 19,
          damage: 128, range: 124, hitstun: 22, blockstun: 12, meterGain: 12, pushback: 6,
          height: 'mid', label: '礁环反击', cancelInto: CANCEL_METER, cancelWindow: 9, hitstop: 5,
          vfx: 'ring', counter: { damage: 128, hitstun: 22, knockdown: false },
          hitboxes: [],
        },
        ex: {
          kind: 'attack', pose: 'counter', startup: 6, active: 14, recovery: 18,
          damage: 168, range: 126, hitstun: 26, blockstun: 14, meterGain: 0, pushback: 8,
          height: 'mid', label: '珊瑚装甲反击', meterCost: CONFIG.EX_COST, armor: 1, invuln: 3,
          cancelInto: CANCEL_METER, cancelWindow: 10, hitstop: 6, vfx: 'ring',
          counter: { damage: 168, hitstun: 26, knockdown: false },
          hitboxes: [],
        },
        super: {
          kind: 'attack', pose: 'super', startup: 8, active: 16, recovery: 24,
          damage: 240, range: 146, hitstun: 28, blockstun: 18, meterGain: 0, pushback: 14,
          height: 'mid', label: '礁环反射', meterCost: CONFIG.SUPER_COST, invuln: 6,
          superFlash: true, grounded: true, vfx: 'super',
          counter: { damage: 240, hitstun: 28, knockdown: false },
          hitboxes: [],
        },
      },
    },

    basalt: {
      label: '断岳当身',
      blurb: '反击直接把人挑飞：击倒加浮空，落地还要再收一次。',
      moves: {
        special: {
          kind: 'attack', pose: 'counter', startup: 8, active: 12, recovery: 18,
          damage: 138, range: 124, hitstun: 26, blockstun: 13, meterGain: 12, pushback: 14,
          height: 'high', label: '断岳反击', cancelInto: CANCEL_METER, cancelWindow: 8, hitstop: 7,
          vfx: 'ring', counter: { damage: 138, hitstun: 26, knockdown: true, launch: true },
          hitboxes: [],
        },
        ex: {
          kind: 'attack', pose: 'counter', startup: 7, active: 14, recovery: 18,
          damage: 176, range: 132, hitstun: 28, blockstun: 15, meterGain: 0, pushback: 16,
          height: 'high', label: '磐壁反击', meterCost: CONFIG.EX_COST, armor: 1,
          cancelInto: CANCEL_METER, cancelWindow: 9, hitstop: 8, vfx: 'ring',
          counter: { damage: 176, hitstun: 28, knockdown: true, launch: true },
          hitboxes: [],
        },
        super: {
          kind: 'attack', pose: 'super', startup: 9, active: 18, recovery: 24,
          damage: 255, range: 152, hitstun: 32, blockstun: 18, meterGain: 0, pushback: 20,
          height: 'high', label: '崩岳反击', meterCost: CONFIG.SUPER_COST, invuln: 8,
          superFlash: true, grounded: true, vfx: 'super',
          counter: { damage: 255, hitstun: 32, knockdown: true, launch: true },
          hitboxes: [],
        },
      },
    },

    noct: {
      label: '影缚当身',
      blurb: '赌一手的当身：EX 带无敌起手，赌错就是空窗二十帧。',
      moves: {
        special: {
          kind: 'attack', pose: 'counter', startup: 8, active: 14, recovery: 18,
          damage: 132, range: 126, hitstun: 28, blockstun: 13, meterGain: 12, pushback: 12,
          height: 'mid', label: '影缚反击', cancelInto: CANCEL_METER, cancelWindow: 9, hitstop: 6,
          invuln: 2, vfx: 'ring', counter: { damage: 132, hitstun: 28, knockdown: true },
          hitboxes: [],
        },
        ex: {
          kind: 'attack', pose: 'counter', startup: 7, active: 14, recovery: 18,
          damage: 168, range: 134, hitstun: 26, blockstun: 14, meterGain: 0, pushback: 10,
          height: 'mid', label: '影匿反击', meterCost: CONFIG.EX_COST, invuln: 7,
          cancelInto: CANCEL_METER, cancelWindow: 10, hitstop: 6, vfx: 'ring',
          counter: { damage: 168, hitstun: 26, knockdown: false },
          hitboxes: [],
        },
        super: {
          kind: 'attack', pose: 'super', startup: 8, active: 16, recovery: 24,
          damage: 248, range: 148, hitstun: 30, blockstun: 18, meterGain: 0, pushback: 18,
          height: 'mid', label: '影葬连击', meterCost: CONFIG.SUPER_COST, invuln: 8,
          superFlash: true, grounded: true, vfx: 'super',
          counter: { damage: 248, hitstun: 30, knockdown: true },
          hitboxes: [],
        },
      },
    },
  },
};

export const counterKits = counter.fighters;
