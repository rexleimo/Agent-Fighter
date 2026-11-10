/**
 * Volley archetype — control the space with projectiles.
 *
 * Three fighters share the archetype but not the projectile:
 *
 *   tide    one big slow orb, EX fires two, super is a wide tidal beam
 *   quartz  fast small shards, EX scatters three, super is a narrow verdict
 *           beam — short reach but the fastest thing in the game
 *   girder  fast narrow bolts that arrive like rebar, EX doubles up, super is
 *           the widest and fastest beam in the league
 *
 * A projectile is a real object with its own box: it travels, it can be
 * blocked, and it whiffs if the opponent leaves the lane.
 */
import { CONFIG, CANCEL_METER, CANCEL_SUPER_ONLY } from '../config.js';

export const volley = {
  id: 'volley',
  label: '波动牵制',
  blurb: '把对手钉在中远距离：EX 连发两发，奥义是一道横向光柱。',
  tags: ['projectile', 'zoning', 'range'],
  fighters: {
    tide: {
      label: '沧波牵制',
      blurb: '一发大水球压住中距，EX 连发两发，奥义是横扫全场的光柱。',
      moves: {
        special: {
          kind: 'projectile', pose: 'volley', startup: 12, active: 2, recovery: 24,
          damage: 62, range: 600, hitstun: 16, blockstun: 10, meterGain: 14, pushback: 9,
          height: 'mid', label: '沧波', cancelInto: CANCEL_METER, cancelWindow: 8, hitstop: 4,
          vfx: 'wave',
          projectile: { speed: 10, y: -116, w: 34, h: 44, damage: 62, hitstun: 16, blockstun: 10, hitstop: 4, life: 120 },
          hitboxes: [],
        },
        ex: {
          kind: 'projectile', pose: 'volley', startup: 10, active: 2, recovery: 22,
          damage: 58, range: 620, hitstun: 18, blockstun: 12, meterGain: 0, pushback: 10,
          height: 'mid', label: '双潮弹', meterCost: CONFIG.EX_COST,
          cancelInto: CANCEL_METER, cancelWindow: 9, hitstop: 5, vfx: 'wave',
          projectile: { speed: 11, y: -116, w: 38, h: 48, damage: 58, hitstun: 18, blockstun: 12, hitstop: 5, life: 120, count: 2, stagger: 4 },
          hitboxes: [],
        },
        super: {
          kind: 'projectile', pose: 'volley', startup: 14, active: 2, recovery: 34,
          damage: 150, range: 640, hitstun: 26, blockstun: 18, meterGain: 0, pushback: 24,
          height: 'mid', label: '潮汐光柱', meterCost: CONFIG.SUPER_COST, invuln: 4,
          superFlash: true, grounded: true, knockdown: true, vfx: 'super',
          projectile: { speed: 13, y: -122, w: 96, h: 92, damage: 150, hitstun: 26, blockstun: 18, hitstop: 8, life: 120, knockdown: true },
          hitboxes: [],
        },
      },
    },

    quartz: {
      label: '棱晶牵制',
      blurb: '又小又快的棱晶弹：出手快、弹道平，EX 三连散射逼对手乱动。',
      moves: {
        special: {
          kind: 'projectile', pose: 'volley', startup: 9, active: 2, recovery: 20,
          damage: 52, range: 600, hitstun: 14, blockstun: 9, meterGain: 14, pushback: 6,
          height: 'mid', label: '棱晶弹', cancelInto: CANCEL_METER, cancelWindow: 8, hitstop: 3,
          vfx: 'shard',
          projectile: { speed: 14, y: -112, w: 24, h: 34, damage: 52, hitstun: 14, blockstun: 9, hitstop: 3, life: 110 },
          hitboxes: [],
        },
        ex: {
          kind: 'projectile', pose: 'volley', startup: 8, active: 2, recovery: 18,
          damage: 38, range: 620, hitstun: 14, blockstun: 10, meterGain: 0, pushback: 6,
          height: 'mid', label: '三棱散射', meterCost: CONFIG.EX_COST,
          cancelInto: CANCEL_METER, cancelWindow: 9, hitstop: 3, vfx: 'shard',
          projectile: { speed: 15, y: -112, w: 22, h: 30, damage: 38, hitstun: 14, blockstun: 10, hitstop: 3, life: 110, count: 3, stagger: 3 },
          hitboxes: [],
        },
        super: {
          kind: 'projectile', pose: 'volley', startup: 12, active: 2, recovery: 30,
          damage: 148, range: 640, hitstun: 24, blockstun: 16, meterGain: 0, pushback: 20,
          height: 'mid', label: '判定光柱', meterCost: CONFIG.SUPER_COST, invuln: 5,
          superFlash: true, grounded: true, knockdown: true, vfx: 'super',
          projectile: { speed: 16, y: -120, w: 72, h: 84, damage: 148, hitstun: 24, blockstun: 16, hitstop: 8, life: 120, knockdown: true },
          hitboxes: [],
        },
      },
    },

    girder: {
      label: '定梁牵制',
      blurb: '像射钢筋一样的窄弹：奥义是最宽最快的一道架构光梁。',
      moves: {
        special: {
          kind: 'projectile', pose: 'volley', startup: 10, active: 2, recovery: 20,
          damage: 50, range: 620, hitstun: 15, blockstun: 9, meterGain: 13, pushback: 7,
          height: 'mid', label: '钢梁弹', cancelInto: CANCEL_METER, cancelWindow: 8, hitstop: 3,
          vfx: 'shard',
          projectile: { speed: 18, y: -108, w: 20, h: 30, damage: 50, hitstun: 15, blockstun: 9, hitstop: 3, life: 100 },
          hitboxes: [],
        },
        ex: {
          kind: 'projectile', pose: 'volley', startup: 7, active: 2, recovery: 16,
          damage: 50, range: 640, hitstun: 15, blockstun: 10, meterGain: 0, pushback: 7,
          height: 'mid', label: '双钢梁', meterCost: CONFIG.EX_COST,
          cancelInto: CANCEL_METER, cancelWindow: 9, hitstop: 3, vfx: 'shard',
          projectile: { speed: 19, y: -108, w: 20, h: 28, damage: 50, hitstun: 15, blockstun: 10, hitstop: 3, life: 100, count: 2, stagger: 2 },
          hitboxes: [],
        },
        super: {
          kind: 'projectile', pose: 'volley', startup: 13, active: 2, recovery: 30,
          damage: 165, range: 640, hitstun: 26, blockstun: 18, meterGain: 0, pushback: 26,
          height: 'mid', label: '架构光梁', meterCost: CONFIG.SUPER_COST, invuln: 6,
          superFlash: true, grounded: true, knockdown: true, vfx: 'super',
          projectile: { speed: 18, y: -118, w: 120, h: 88, damage: 165, hitstun: 26, blockstun: 18, hitstop: 8, life: 120, knockdown: true },
          hitboxes: [],
        },
      },
    },
  },
};

export const volleyKits = volley.fighters;
