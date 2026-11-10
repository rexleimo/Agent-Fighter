/**
 * Rush archetype — pressure by advancing.
 *
 * Four fighters share the archetype but NOT the moves: each one owns a
 * different way of closing distance.
 *
 *   ember   mid advancing strike, knocks down (the plainest pressure)
 *   pyre    LOW advancing flame — beats crouching blockers, loses to standing
 *   abyss   advancing strike with armor and no knockdown — keeps the opponent
 *           in hitstun instead of on the floor, so a combo can continue
 *   forge   slow overhead hammer, no advance — beats crouch blocking, is
 *           blocked by standing guard
 *
 * The balance contract (KIT_BALANCE in ./index.js) is checked by
 * scripts/verify-combat.mjs against every fighter's real numbers, so a kit
 * cannot drift out of band by accident.
 */
import { CONFIG, CANCEL_METER, CANCEL_SUPER_ONLY } from '../config.js';

export const rush = {
  id: 'rush',
  label: '突进压制',
  blurb: '带身位前冲的强攻技：命中即倒，距离越近收益越高。',
  tags: ['advance', 'knockdown', 'close-range'],
  fighters: {
    ember: {
      label: '炎冲压制',
      blurb: '贴身火拳：专属技前冲击倒，EX 带装甲硬吃一拳，奥义是三段追打。',
      moves: {
        special: {
          kind: 'attack', pose: 'rush', startup: 10, active: 4, recovery: 20,
          damage: 112, range: 150, hitstun: 24, blockstun: 14, meterGain: 20, pushback: 12,
          height: 'mid', label: '炎冲', cancelInto: CANCEL_METER, cancelWindow: 8, hitstop: 6,
          knockdown: true, vfx: 'rush', advance: { vx: 7 },
          hitboxes: [{ anchor: 'handF', x: -14, y: -70, w: 96, h: 112, from: 0, to: 3, height: 'mid', hitId: 0 }],
        },
        ex: {
          kind: 'attack', pose: 'rush', startup: 8, active: 5, recovery: 19,
          damage: 158, range: 158, hitstun: 26, blockstun: 16, meterGain: 0, pushback: 16,
          height: 'mid', label: '炎虎', meterCost: CONFIG.EX_COST, armor: 1,
          cancelInto: CANCEL_METER, cancelWindow: 9, hitstop: 8, knockdown: true,
          vfx: 'burst', advance: { vx: 9 },
          hitboxes: [{ anchor: 'handF', x: -16, y: -78, w: 108, h: 124, from: 0, to: 4, height: 'mid', hitId: 0 }],
        },
        super: {
          kind: 'attack', pose: 'super', startup: 12, active: 10, recovery: 28,
          damage: 96, range: 200, hitstun: 18, blockstun: 16, meterGain: 0, pushback: 20,
          height: 'mid', label: '炎狱连打', meterCost: CONFIG.SUPER_COST, invuln: 6,
          multiHit: true, superFlash: true, grounded: true, hitstop: 8, knockdown: true, vfx: 'super',
          advance: { vx: 8 },
          hitboxes: [
            { anchor: 'hip', x: -6, y: -196, w: 150, h: 196, from: 0, to: 2, height: 'mid', hitId: 0, damageScale: 0.7 },
            { anchor: 'hip', x: -6, y: -196, w: 176, h: 196, from: 4, to: 6, height: 'mid', hitId: 1, damageScale: 0.7 },
            { anchor: 'hip', x: -6, y: -200, w: 208, h: 200, from: 8, to: 9, height: 'mid', hitId: 2, damageScale: 1.6, knockdown: true, hitstop: 12 },
          ],
        },
      },
    },

    pyre: {
      label: '燎野压制',
      blurb: '低段前推的地火：专烧蹲防的人，站防反而挡住了它。',
      moves: {
        special: {
          kind: 'attack', pose: 'rush', startup: 12, active: 6, recovery: 20,
          damage: 105, range: 170, hitstun: 22, blockstun: 12, meterGain: 20, pushback: 10,
          height: 'low', label: '燎原地火', cancelInto: CANCEL_METER, cancelWindow: 8, hitstop: 5,
          knockdown: true, vfx: 'wave', advance: { vx: 6 },
          hitboxes: [{ anchor: 'footF', x: -12, y: -34, w: 128, h: 44, from: 0, to: 5, height: 'low', hitId: 0 }],
        },
        ex: {
          kind: 'attack', pose: 'rush', startup: 9, active: 8, recovery: 19,
          damage: 76, range: 176, hitstun: 20, blockstun: 12, meterGain: 0, pushback: 12,
          height: 'low', label: '双焰墙', meterCost: CONFIG.EX_COST, armor: 1,
          cancelInto: CANCEL_METER, cancelWindow: 9, hitstop: 7, knockdown: true,
          multiHit: true, vfx: 'wave', advance: { vx: 7 },
          hitboxes: [
            { anchor: 'footF', x: -12, y: -34, w: 128, h: 44, from: 0, to: 2, height: 'low', hitId: 0 },
            { anchor: 'footF', x: -6, y: -40, w: 150, h: 50, from: 4, to: 7, height: 'low', hitId: 1 },
          ],
        },
        super: {
          kind: 'attack', pose: 'super', startup: 14, active: 12, recovery: 26,
          damage: 90, range: 190, hitstun: 18, blockstun: 16, meterGain: 0, pushback: 22,
          height: 'overhead', label: '火柱爆发', meterCost: CONFIG.SUPER_COST, invuln: 4,
          multiHit: true, superFlash: true, grounded: true, hitstop: 8, vfx: 'super',
          hitboxes: [
            { anchor: 'hip', x: -4, y: -200, w: 132, h: 200, from: 0, to: 3, height: 'overhead', hitId: 0, damageScale: 0.75 },
            { anchor: 'hip', x: -4, y: -200, w: 156, h: 200, from: 5, to: 7, height: 'overhead', hitId: 1, damageScale: 0.75 },
            { anchor: 'hip', x: -4, y: -206, w: 186, h: 206, from: 9, to: 11, height: 'overhead', hitId: 2, damageScale: 1.6, knockdown: true, hitstop: 12 },
          ],
        },
      },
    },

    abyss: {
      label: '归渊压制',
      blurb: '带装甲的推压：把对手按在僵直里，而不是放倒，留给连段。',
      moves: {
        special: {
          kind: 'attack', pose: 'rush', startup: 12, active: 4, recovery: 22,
          damage: 118, range: 160, hitstun: 26, blockstun: 16, meterGain: 20, pushback: 8,
          height: 'mid', label: '渊压重掌', cancelInto: CANCEL_METER, cancelWindow: 9, hitstop: 7,
          armor: 1, vfx: 'rush', advance: { vx: 6 },
          hitboxes: [{ anchor: 'handF', x: -12, y: -76, w: 104, h: 120, from: 0, to: 3, height: 'mid', hitId: 0 }],
        },
        ex: {
          kind: 'attack', pose: 'rush', startup: 9, active: 5, recovery: 20,
          damage: 162, range: 168, hitstun: 28, blockstun: 18, meterGain: 0, pushback: 10,
          height: 'mid', label: '渊锁压杀', meterCost: CONFIG.EX_COST, armor: 1, invuln: 3,
          cancelInto: CANCEL_METER, cancelWindow: 9, hitstop: 9,
          vfx: 'burst', advance: { vx: 7 },
          hitboxes: [{ anchor: 'handF', x: -14, y: -84, w: 116, h: 132, from: 0, to: 4, height: 'mid', hitId: 0 }],
        },
        super: {
          kind: 'attack', pose: 'super', startup: 13, active: 12, recovery: 27,
          damage: 92, range: 200, hitstun: 18, blockstun: 16, meterGain: 0, pushback: 18,
          height: 'mid', label: '归渊连压', meterCost: CONFIG.SUPER_COST, invuln: 6,
          multiHit: true, superFlash: true, grounded: true, hitstop: 8, vfx: 'super', advance: { vx: 5 },
          hitboxes: [
            { anchor: 'hip', x: -8, y: -196, w: 146, h: 196, from: 0, to: 3, height: 'mid', hitId: 0, damageScale: 0.7 },
            { anchor: 'hip', x: -8, y: -196, w: 170, h: 196, from: 5, to: 7, height: 'mid', hitId: 1, damageScale: 0.7 },
            { anchor: 'hip', x: -8, y: -200, w: 204, h: 200, from: 9, to: 11, height: 'mid', hitId: 2, damageScale: 1.6, knockdown: true, hitstop: 12 },
          ],
        },
      },
    },

    forge: {
      label: '陨铸压制',
      blurb: '慢到离谱的上段重锤：不追人，只砸站着的对手。',
      moves: {
        special: {
          kind: 'attack', pose: 'special', startup: 16, active: 4, recovery: 20,
          damage: 120, range: 140, hitstun: 26, blockstun: 16, meterGain: 20, pushback: 18,
          height: 'overhead', label: '陨锤', cancelInto: CANCEL_METER, cancelWindow: 8, hitstop: 8,
          knockdown: true, vfx: 'signature',
          hitboxes: [{ anchor: 'handF', x: -18, y: -92, w: 112, h: 124, from: 0, to: 3, height: 'overhead', hitId: 0 }],
        },
        ex: {
          kind: 'attack', pose: 'special', startup: 13, active: 5, recovery: 18,
          damage: 168, range: 148, hitstun: 28, blockstun: 18, meterGain: 0, pushback: 20,
          height: 'overhead', label: '双吨锤', meterCost: CONFIG.EX_COST, armor: 1,
          cancelInto: CANCEL_METER, cancelWindow: 9, hitstop: 10, knockdown: true,
          vfx: 'burst',
          hitboxes: [{ anchor: 'handF', x: -20, y: -100, w: 124, h: 136, from: 0, to: 4, height: 'overhead', hitId: 0 }],
        },
        super: {
          kind: 'attack', pose: 'super', startup: 14, active: 12, recovery: 26,
          damage: 92, range: 190, hitstun: 18, blockstun: 16, meterGain: 0, pushback: 24,
          height: 'overhead', label: '熔星陨落', meterCost: CONFIG.SUPER_COST, invuln: 5,
          multiHit: true, superFlash: true, grounded: true, hitstop: 9, vfx: 'super',
          hitboxes: [
            { anchor: 'hip', x: -2, y: -200, w: 146, h: 200, from: 0, to: 3, height: 'overhead', hitId: 0, damageScale: 0.8 },
            { anchor: 'hip', x: -2, y: -200, w: 170, h: 200, from: 5, to: 7, height: 'overhead', hitId: 1, damageScale: 0.8 },
            { anchor: 'hip', x: -2, y: -206, w: 200, h: 206, from: 9, to: 11, height: 'overhead', hitId: 2, damageScale: 1.6, knockdown: true, hitstop: 14 },
          ],
        },
      },
    },
  },
};

export const rushKits = rush.fighters;
