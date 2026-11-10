/**
 * Anti-air archetype — the answer to a jump-in.
 *
 *   volt   one huge rising strike with real startup invulnerability
 *   prism  the same rise, but split into several rising hits that keep
 *          carrying the opponent upward
 *
 * Both launch the opponent (`launch`), so a whiffed jump-in is punished by
 * the air, not just by the damage.
 */
import { CONFIG, CANCEL_METER, CANCEL_SUPER_ONLY } from '../config.js';

export const antiAir = {
  id: 'antiAir',
  label: '升龙对空',
  blurb: '起手无敌的上升拳：专治跳入，落地即被罚。',
  tags: ['invuln', 'anti-air', 'launcher'],
  fighters: {
    volt: {
      label: '雷牙升拳',
      blurb: '起手四帧无敌，一记升拳把人从空中钉下来。',
      moves: {
        special: {
          kind: 'attack', pose: 'antiAir', startup: 3, active: 7, recovery: 26,
          damage: 122, range: 132, hitstun: 24, blockstun: 14, meterGain: 22, pushback: 14,
          height: 'high', label: '雷牙升拳', cancelInto: CANCEL_METER, cancelWindow: 10,
          hitstop: 7, invuln: 4, knockdown: true, launch: true, antiAir: true, vfx: 'burst',
          hitboxes: [{ anchor: 'hip', x: -6, y: -180, w: 116, h: 182, from: 0, to: 6, height: 'high', hitId: 0 }],
        },
        ex: {
          kind: 'attack', pose: 'antiAir', startup: 2, active: 8, recovery: 24,
          damage: 165, range: 140, hitstun: 26, blockstun: 16, meterGain: 0, pushback: 16,
          height: 'high', label: '雷霆升拳', meterCost: CONFIG.EX_COST, invuln: 6, armor: 1,
          cancelInto: CANCEL_METER, cancelWindow: 9, hitstop: 8, knockdown: true,
          launch: true, antiAir: true, vfx: 'burst',
          hitboxes: [{ anchor: 'hip', x: -8, y: -190, w: 128, h: 192, from: 0, to: 7, height: 'high', hitId: 0 }],
        },
        super: {
          kind: 'attack', pose: 'super', startup: 5, active: 12, recovery: 28,
          damage: 88, range: 160, hitstun: 20, blockstun: 16, meterGain: 0, pushback: 20,
          height: 'high', label: '天罚雷柱', meterCost: CONFIG.SUPER_COST, invuln: 8,
          multiHit: true, superFlash: true, grounded: true, hitstop: 8, knockdown: true, launch: true,
          antiAir: true, vfx: 'super',
          hitboxes: [
            { anchor: 'hip', x: -6, y: -190, w: 118, h: 192, from: 0, to: 4, height: 'high', hitId: 0, damageScale: 0.9 },
            { anchor: 'hip', x: -8, y: -206, w: 140, h: 208, from: 6, to: 11, height: 'high', hitId: 1, damageScale: 1.4, knockdown: true, launch: true, hitstop: 12 },
          ],
        },
      },
    },

    prism: {
      label: '折光升击',
      blurb: '把升拳拆成几段：起手无敌更长，一路上把人顶上去。',
      moves: {
        special: {
          kind: 'attack', pose: 'antiAir', startup: 5, active: 9, recovery: 24,
          damage: 62, range: 150, hitstun: 22, blockstun: 12, meterGain: 20, pushback: 10,
          height: 'high', label: '折光升拳', cancelInto: CANCEL_METER, cancelWindow: 10,
          hitstop: 6, invuln: 3, multiHit: true, knockdown: true, launch: true,
          antiAir: true, vfx: 'signature',
          hitboxes: [
            { anchor: 'hip', x: -4, y: -178, w: 112, h: 180, from: 0, to: 3, height: 'high', hitId: 0, damageScale: 0.9 },
            { anchor: 'hip', x: -6, y: -186, w: 124, h: 188, from: 4, to: 8, height: 'high', hitId: 1, damageScale: 0.9, knockdown: true, launch: true },
          ],
        },
        ex: {
          kind: 'attack', pose: 'antiAir', startup: 4, active: 11, recovery: 22,
          damage: 72, range: 156, hitstun: 24, blockstun: 14, meterGain: 0, pushback: 12,
          height: 'high', label: '棱镜升击', meterCost: CONFIG.EX_COST, invuln: 5, armor: 1,
          cancelInto: CANCEL_METER, cancelWindow: 10, hitstop: 7, multiHit: true,
          knockdown: true, launch: true, antiAir: true, vfx: 'burst',
          hitboxes: [
            { anchor: 'hip', x: -4, y: -178, w: 114, h: 180, from: 0, to: 2, height: 'high', hitId: 0, damageScale: 0.7 },
            { anchor: 'hip', x: -6, y: -186, w: 126, h: 188, from: 3, to: 6, height: 'high', hitId: 1, damageScale: 0.7 },
            { anchor: 'hip', x: -8, y: -194, w: 140, h: 196, from: 7, to: 10, height: 'high', hitId: 2, damageScale: 0.7, knockdown: true, launch: true },
          ],
        },
        super: {
          kind: 'attack', pose: 'super', startup: 6, active: 14, recovery: 26,
          damage: 62, range: 170, hitstun: 20, blockstun: 16, meterGain: 0, pushback: 18,
          height: 'high', label: '万花筒爆发', meterCost: CONFIG.SUPER_COST, invuln: 8,
          multiHit: true, superFlash: true, grounded: true, hitstop: 8, knockdown: true, launch: true,
          antiAir: true, vfx: 'super',
          hitboxes: [
            { anchor: 'hip', x: 0, y: -182, w: 104, h: 184, from: 0, to: 2, height: 'high', hitId: 0, damageScale: 0.75 },
            { anchor: 'hip', x: -2, y: -188, w: 120, h: 190, from: 3, to: 5, height: 'high', hitId: 1, damageScale: 0.75 },
            { anchor: 'hip', x: -4, y: -194, w: 136, h: 196, from: 6, to: 9, height: 'high', hitId: 2, damageScale: 0.75 },
            { anchor: 'hip', x: -6, y: -202, w: 156, h: 204, from: 10, to: 13, height: 'high', hitId: 3, damageScale: 1.25, knockdown: true, launch: true, hitstop: 12 },
          ],
        },
      },
    },
  },
};

export const antiAirKits = antiAir.fighters;
