/**
 * Multi-hit archetype — several hits inside one move.
 *
 *   cinder  a rising string of cuts that carries the opponent upward
 *   mist    LOW sliding strings: they hit legs, and they travel while hitting
 *   gale    advancing strings: the fighter walks into the opponent while the
 *           string keeps landing
 *
 * A multi-hit move declares one hitbox per hit. Each hitId can only land
 * once, so the string reads as a sequence of distinct beats instead of one
 * long overlapping box.
 */
import { CONFIG, CANCEL_METER, CANCEL_SUPER_ONLY } from '../config.js';

export const multi = {
  id: 'multi',
  label: '多段连击',
  blurb: '同一招里挂多段判定，收招还能接超必杀；单段不重，但全中很痛。',
  tags: ['multi-hit', 'combo', 'cancel'],
  fighters: {
    cinder: {
      label: '焚羽连斩',
      blurb: '空中三段：每一刀都把人往上顶，最后一刀才收。',
      moves: {
        special: {
          kind: 'attack', pose: 'multi', startup: 8, active: 8, recovery: 20,
          damage: 90, range: 196, hitstun: 20, blockstun: 12, meterGain: 18, pushback: 8,
          height: 'mid', label: '羽刃连斩', cancelInto: CANCEL_METER, cancelWindow: 10,
          hitstop: 5, multiHit: true, vfx: 'signature',
          hitboxes: [
            { anchor: 'handF', x: -12, y: -58, w: 86, h: 104, from: 0, to: 1, height: 'mid', hitId: 0, damageScale: 0.5 },
            { anchor: 'handF', x: -14, y: -66, w: 96, h: 112, from: 2, to: 4, height: 'mid', hitId: 1, damageScale: 0.5 },
            { anchor: 'hip', x: -6, y: -150, w: 120, h: 152, from: 5, to: 7, height: 'mid', hitId: 2, damageScale: 0.5, knockdown: true },
          ],
        },
        ex: {
          kind: 'attack', pose: 'multi', startup: 6, active: 12, recovery: 16,
          damage: 92, range: 204, hitstun: 22, blockstun: 14, meterGain: 0, pushback: 10,
          height: 'mid', label: '焚羽五连', meterCost: CONFIG.EX_COST,
          cancelInto: CANCEL_METER, cancelWindow: 10, hitstop: 6, multiHit: true,
          antiAir: true, vfx: 'burst',
          hitboxes: [
            { anchor: 'handF', x: -12, y: -58, w: 88, h: 104, from: 0, to: 1, height: 'mid', hitId: 0, damageScale: 0.4 },
            { anchor: 'handF', x: -14, y: -66, w: 96, h: 112, from: 2, to: 3, height: 'mid', hitId: 1, damageScale: 0.4 },
            { anchor: 'hip', x: -6, y: -150, w: 120, h: 152, from: 4, to: 5, height: 'mid', hitId: 2, damageScale: 0.4 },
            { anchor: 'hip', x: -8, y: -158, w: 132, h: 160, from: 6, to: 8, height: 'mid', hitId: 3, damageScale: 0.4 },
            { anchor: 'hip', x: -10, y: -170, w: 148, h: 172, from: 9, to: 11, height: 'mid', hitId: 4, damageScale: 0.4, knockdown: true, hitstop: 12 },
          ],
        },
        super: {
          kind: 'attack', pose: 'super', startup: 10, active: 14, recovery: 28,
          damage: 96, range: 220, hitstun: 18, blockstun: 16, meterGain: 0, pushback: 14,
          height: 'mid', label: '灰烬风暴', meterCost: CONFIG.SUPER_COST, invuln: 6,
          multiHit: true, superFlash: true, grounded: true, hitstop: 6, vfx: 'super',
          hitboxes: [
            { anchor: 'handF', x: -8, y: -60, w: 92, h: 108, from: 0, to: 1, height: 'mid', hitId: 0, damageScale: 0.5 },
            { anchor: 'handF', x: -10, y: -62, w: 96, h: 110, from: 2, to: 3, height: 'mid', hitId: 1, damageScale: 0.5 },
            { anchor: 'hip', x: -8, y: -150, w: 128, h: 152, from: 4, to: 5, height: 'mid', hitId: 2, damageScale: 0.5 },
            { anchor: 'hip', x: -8, y: -160, w: 140, h: 162, from: 6, to: 8, height: 'mid', hitId: 3, damageScale: 0.5 },
            { anchor: 'hip', x: -10, y: -170, w: 152, h: 172, from: 9, to: 10, height: 'mid', hitId: 4, damageScale: 0.5 },
            { anchor: 'hip', x: -12, y: -182, w: 176, h: 184, from: 11, to: 13, height: 'mid', hitId: 5, damageScale: 0.55, knockdown: true, hitstop: 12 },
          ],
        },
      },
    },

    mist: {
      label: '潜汐连斩',
      blurb: '贴地的滑铲连段：全打腿，站防的人反而吃不到。',
      moves: {
        special: {
          kind: 'attack', pose: 'multi', startup: 10, active: 8, recovery: 18,
          damage: 92, range: 180, hitstun: 18, blockstun: 11, meterGain: 18, pushback: 6,
          height: 'low', label: '潜汐滑铲', cancelInto: CANCEL_METER, cancelWindow: 10,
          hitstop: 4, multiHit: true, vfx: 'crescent', advance: { vx: 5 },
          hitboxes: [
            { anchor: 'footF', x: -12, y: -32, w: 118, h: 40, from: 0, to: 2, height: 'low', hitId: 0, damageScale: 0.45 },
            { anchor: 'footF', x: -8, y: -36, w: 128, h: 44, from: 3, to: 4, height: 'low', hitId: 1, damageScale: 0.45 },
            { anchor: 'footF', x: -4, y: -40, w: 140, h: 48, from: 5, to: 7, height: 'low', hitId: 2, damageScale: 0.55, knockdown: true },
          ],
        },
        ex: {
          kind: 'attack', pose: 'multi', startup: 7, active: 10, recovery: 15,
          damage: 105, range: 190, hitstun: 18, blockstun: 12, meterGain: 0, pushback: 7,
          height: 'low', label: '雾影三连', meterCost: CONFIG.EX_COST,
          cancelInto: CANCEL_METER, cancelWindow: 10, hitstop: 5, multiHit: true,
          vfx: 'crescent', advance: { vx: 6 },
          hitboxes: [
            { anchor: 'footF', x: -12, y: -32, w: 122, h: 42, from: 0, to: 2, height: 'low', hitId: 0, damageScale: 0.6 },
            { anchor: 'footF', x: -6, y: -36, w: 134, h: 46, from: 3, to: 5, height: 'low', hitId: 1, damageScale: 0.6 },
            { anchor: 'footF', x: -2, y: -42, w: 148, h: 52, from: 6, to: 9, height: 'low', hitId: 2, damageScale: 0.6, knockdown: true },
          ],
        },
        super: {
          kind: 'attack', pose: 'super', startup: 10, active: 14, recovery: 26,
          damage: 96, range: 200, hitstun: 18, blockstun: 16, meterGain: 0, pushback: 12,
          height: 'low', label: '匿流五连', meterCost: CONFIG.SUPER_COST, invuln: 6,
          multiHit: true, superFlash: true, grounded: true, hitstop: 6, vfx: 'super',
          hitboxes: [
            { anchor: 'footF', x: -12, y: -32, w: 124, h: 42, from: 0, to: 2, height: 'low', hitId: 0, damageScale: 0.55 },
            { anchor: 'footF', x: -8, y: -36, w: 132, h: 46, from: 3, to: 5, height: 'low', hitId: 1, damageScale: 0.55 },
            { anchor: 'footF', x: -4, y: -40, w: 140, h: 50, from: 6, to: 8, height: 'low', hitId: 2, damageScale: 0.55 },
            { anchor: 'footF', x: -2, y: -44, w: 148, h: 54, from: 9, to: 11, height: 'low', hitId: 3, damageScale: 0.55 },
            { anchor: 'footF', x: 0, y: -48, w: 158, h: 58, from: 12, to: 13, height: 'low', hitId: 4, damageScale: 0.55, knockdown: true, hitstop: 12 },
          ],
        },
      },
    },

    gale: {
      label: '裂空连斩',
      blurb: '边冲边打的快连段：位移和判定同时发生，追着人砍。',
      moves: {
        special: {
          kind: 'attack', pose: 'multi', startup: 9, active: 8, recovery: 19,
          damage: 95, range: 190, hitstun: 20, blockstun: 12, meterGain: 18, pushback: 7,
          height: 'mid', label: '疾风连斩', cancelInto: CANCEL_METER, cancelWindow: 10,
          hitstop: 5, multiHit: true, vfx: 'crescent', advance: { vx: 5 },
          hitboxes: [
            { anchor: 'handF', x: -10, y: -60, w: 90, h: 108, from: 0, to: 3, height: 'mid', hitId: 0, damageScale: 0.7 },
            { anchor: 'hip', x: -6, y: -146, w: 124, h: 150, from: 4, to: 7, height: 'mid', hitId: 1, damageScale: 0.7, knockdown: true },
          ],
        },
        ex: {
          kind: 'attack', pose: 'multi', startup: 7, active: 10, recovery: 16,
          damage: 105, range: 198, hitstun: 20, blockstun: 13, meterGain: 0, pushback: 8,
          height: 'mid', label: '裂空三连', meterCost: CONFIG.EX_COST,
          cancelInto: CANCEL_METER, cancelWindow: 10, hitstop: 6, multiHit: true,
          vfx: 'burst', advance: { vx: 6 },
          hitboxes: [
            { anchor: 'handF', x: -10, y: -60, w: 92, h: 108, from: 0, to: 2, height: 'mid', hitId: 0, damageScale: 0.6 },
            { anchor: 'hip', x: -6, y: -146, w: 126, h: 150, from: 3, to: 5, height: 'mid', hitId: 1, damageScale: 0.6 },
            { anchor: 'hip', x: -8, y: -158, w: 138, h: 162, from: 6, to: 9, height: 'mid', hitId: 2, damageScale: 0.6, knockdown: true },
          ],
        },
        super: {
          kind: 'attack', pose: 'super', startup: 9, active: 14, recovery: 26,
          damage: 95, range: 210, hitstun: 18, blockstun: 16, meterGain: 0, pushback: 12,
          height: 'mid', label: '疾风六连', meterCost: CONFIG.SUPER_COST, invuln: 6,
          multiHit: true, superFlash: true, grounded: true, hitstop: 6, vfx: 'super',
          hitboxes: [
            { anchor: 'handF', x: -8, y: -60, w: 92, h: 108, from: 0, to: 1, height: 'mid', hitId: 0, damageScale: 0.45 },
            { anchor: 'handF', x: -10, y: -62, w: 96, h: 110, from: 2, to: 3, height: 'mid', hitId: 1, damageScale: 0.45 },
            { anchor: 'hip', x: -8, y: -150, w: 128, h: 152, from: 4, to: 5, height: 'mid', hitId: 2, damageScale: 0.45 },
            { anchor: 'hip', x: -8, y: -160, w: 140, h: 162, from: 6, to: 8, height: 'mid', hitId: 3, damageScale: 0.45 },
            { anchor: 'hip', x: -10, y: -170, w: 152, h: 172, from: 9, to: 10, height: 'mid', hitId: 4, damageScale: 0.45 },
            { anchor: 'hip', x: -12, y: -182, w: 176, h: 184, from: 11, to: 13, height: 'mid', hitId: 5, damageScale: 0.45, knockdown: true, hitstop: 12 },
          ],
        },
      },
    },
  },
};

export const multiKits = multi.fighters;
