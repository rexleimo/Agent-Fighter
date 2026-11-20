// Combat acceptance — extracted from scripts/verify-combat.mjs by responsibility.
import fs from 'node:fs';
import path from 'node:path';
import { createInitialState, step, stateHash, renderState, runMatch, replayMatch } from '../../src/engine.js';
import { CONFIG, MOVES, ACTIONS, moveDamage, moveReach, isAttack, isDefense, ATTACK_ACTIONS, defensiveRules } from '../../src/rules.js';
import { ARCHETYPES, FIGHTER_KITS, FIGHTER_KIT_IDS, KIT_BALANCE } from '../../src/kits/index.js';
import { FIGHTERS, PUSH_WIDTH } from '../../src/fighters.js';
import { boxesFor, skeletonFor, poseFor, overlap, publicBoxData, pushboxFor, parryWindowOpen } from '../../src/combat.js';
import { BUILTIN_AGENTS } from '../../src/agents.js';
import { buildObservation } from '../../src/protocol.js';
import { scene, types, guard, ROOT } from './combat-helpers.mjs';
export function runDefense(check) {
/* 40 — 防御层（规则 2.1）：闪避 / 招架的相克契约，逐帧驱动内核 */
{
  check('K40 闪避/招架进动作空间，且不被归类为出招',
    ACTIONS.length === 21 && ACTIONS.includes('dodge') && ACTIONS.includes('parry')
      && MOVES.dodge.kind === 'defense' && MOVES.parry.kind === 'defense'
      && !isAttack('dodge') && !isAttack('parry') && isDefense('dodge')
      && !ATTACK_ACTIONS.includes('dodge') && !ATTACK_ACTIONS.includes('parry'),
    'actions=' + ACTIONS.length + ' defenseOnly=' + (isDefense('dodge') && !isAttack('dodge')));

  const mid = guard({ move: 'mp', defAt: 7 });
  check('K41 闪避把一记中段拳整个穿过：不扣血、不给对方攒气、回自己 15 气',
    mid.of('evade').length === 1 && mid.of('hit').length === 0 && mid.of('block').length === 0
      && mid.s.b.hp === CONFIG.MAX_HP && mid.s.b.meter === MOVES.dodge.evade.meterGain
      && mid.s.a.meter === 0 && mid.read.absorbed === 'mp' && mid.read.height === 'mid',
    'evades=' + mid.of('evade').length + ' bHp=' + mid.s.b.hp + ' bMeter=' + mid.s.b.meter + ' aMeter=' + mid.s.a.meter);

  // Travel is measured with nobody attacking, so pushback cannot leak in.
  const travel = ({ x, facing, wall = false }) => {
    let s = createInitialState(29, 'dodge-travel', {});
    s.a.x = x;
    s.a.facing = facing;
    s.b.x = facing > 0 ? 900 : 60;
    s.b.facing = -facing;
    let peak = x;
    for (let i = 0; i < 30; i += 1) {
      s = step(s, 'dodge', 'idle');
      peak = facing > 0 ? Math.min(peak, s.a.x) : Math.max(peak, s.a.x);
    }
    return { back: Math.abs(x - s.a.x), x: s.a.x, peak };
  };
  const open = travel({ x: 480, facing: 1 });
  const caged = travel({ x: CONFIG.STAGE_RIGHT - 4, facing: -1 });
  check('K42 闪避真实后撤 50 单位（无敌期 10 帧 × 5），墙角被夹住不越界',
    open.back === MOVES.dodge.evade.back * MOVES.dodge.invuln
      && caged.x <= CONFIG.STAGE_RIGHT && caged.peak <= CONFIG.STAGE_RIGHT,
    'back=' + open.back + ' wallX=' + caged.x + '/' + CONFIG.STAGE_RIGHT);

  const late = guard({ move: 'mp', defAt: 11 });
  check('K43 闪避是读帧，不是免死：晚一拍就挨同一记中拳的满伤',
    late.of('evade').length === 0 && late.of('hit').length === 1
      && late.s.b.hp === CONFIG.MAX_HP - MOVES.mp.damage,
    'defAt=11 hits=' + late.of('hit').length + ' bHp=' + late.s.b.hp + '/' + (CONFIG.MAX_HP - MOVES.mp.damage));

  const grabbed = guard({ move: 'throw', dx: 90, defAt: 7 });
  check('K44 投技破闪避：落在无敌帧里的投技照样吃满伤并击倒，无敌帧不补偿任何气',
    grabbed.of('hit').length === 1 && grabbed.of('evade').length === 0
      && grabbed.s.b.hp === CONFIG.MAX_HP - MOVES.throw.damage
      && grabbed.hit.knockdown === true
      && grabbed.s.b.meter === Math.round(MOVES.throw.meterGain / 2) && MOVES.throw.breaksDodge === true,
    'bHp=' + grabbed.s.b.hp + ' knocked=' + grabbed.hit.knockdown + ' meter=' + grabbed.s.b.meter);

  const lowEv = guard({ move: 'lk', defAt: 7 });
  const highEv = guard({ move: 'hk', defAt: 10 });
  check('K45 闪避不挑高度：低段轻脚与高段重脚都在无敌帧里落空',
    lowEv.of('evade').length === 1 && highEv.of('evade').length === 1
      && lowEv.s.b.hp === CONFIG.MAX_HP && highEv.s.b.hp === CONFIG.MAX_HP,
    'lk=' + lowEv.s.b.hp + ' hk=' + highEv.s.b.hp);

  const parryRows = ['lk', 'mp', 'hk'].map((mv) => {
    const r = guard({ move: mv, def: 'parry', defAt: mv === 'hk' ? 10 : 7 });
    return { mv, ok: r.of('parry').length === 1 && r.of('hit').length === 0 && r.of('block').length === 0 && r.s.b.hp === CONFIG.MAX_HP && r.s.b.blockstun === 0 && r.s.b.meter === MOVES.parry.parry.meterGain, hp: r.s.b.hp };
  });
  check('K46 招架一口吃掉 low/mid/high 三择：零伤害、零削血、零防御硬直、回 25 气',
    parryRows.every((r) => r.ok),
    parryRows.map((r) => r.mv + '=' + r.hp).join(' '));

  // The projectile is timed off the frame it ACTUALLY connects, so the check
  // does not silently rot if the fireball speed is ever retuned.
  const contact = () => {
    let s = createInitialState(3, 'fb-contact', {});
    s.a.x = 380;
    s.b.x = 680;
    for (let i = 0; i < 90; i += 1) {
      s = step(s, i === 0 ? 'fireball' : 'idle', 'idle');
      if (s.b.hp !== CONFIG.MAX_HP) return i;
    }
    return -1;
  };
  const hitFrame = contact();
  const fbParry = guard({ move: 'fireball', dx: 300, atkAt: 0, def: 'parry', defAt: hitFrame - 2, frames: 70 });
  const fbDodge = guard({ move: 'fireball', dx: 300, atkAt: 0, def: 'dodge', defAt: hitFrame - 2, frames: 70 });
  const fbIdle = guard({ move: 'fireball', dx: 300, atkAt: 0, def: 'idle', defAt: -1, frames: 70 });
  const fbBlock = guard({ move: 'fireball', dx: 300, atkAt: 0, def: 'block', defAt: hitFrame - 2, frames: 70, hold: true });
  check('K47 招架把波动整发消掉、闪避从弹体里穿过去；两者都不吃削血（对照站防要挨 6）',
    hitFrame > 0 && fbParry.of('parry').length === 1 && fbParry.s.b.hp === CONFIG.MAX_HP && fbParry.s.projectiles.length === 0
      && fbDodge.of('evade').length === 1 && fbDodge.s.b.hp === CONFIG.MAX_HP && fbDodge.s.projectiles.length === 0
      && fbIdle.of('hit').length === 1 && fbBlock.s.b.hp === CONFIG.MAX_HP - 6,
    'contact=' + hitFrame + ' parry=' + fbParry.s.b.hp + ' dodge=' + fbDodge.s.b.hp + ' idle=' + fbIdle.s.b.hp + ' block=' + fbBlock.s.b.hp);

  const parryGrab = guard({ move: 'throw', dx: 90, def: 'parry', defAt: 6 });
  check('K48 招架被投技破：满伤 + 击倒，只拿到挨打的气，没有招架的 25',
    parryGrab.of('parry').length === 0 && parryGrab.of('hit').length === 1
      && parryGrab.s.b.hp === CONFIG.MAX_HP - MOVES.throw.damage
      && parryGrab.s.b.meter === Math.round(MOVES.throw.meterGain / 2),
    'bHp=' + parryGrab.s.b.hp + ' meter=' + parryGrab.s.b.meter);

  const parryWhiff = guard({ move: 'mp', def: 'parry', defAt: 0, atkAt: 16, frames: 60 });
  check('K49 空挥招架的破绽期不是防御：同一记中拳吃满伤，而不是削血或防硬直',
    parryWhiff.of('parry').length === 0 && parryWhiff.of('block').length === 0
      && parryWhiff.of('hit').length === 1
      && parryWhiff.s.b.hp === CONFIG.MAX_HP - MOVES.mp.damage && parryWhiff.s.b.blockstun === 0,
    'bHp=' + parryWhiff.s.b.hp + ' blockstun=' + parryWhiff.s.b.blockstun);

  // The reward for a read is a punish, not extra damage.
  {
    let s = createInitialState(17, 'parry-punish', {});
    s.a.x = 425;
    s.b.x = 535;
    const events = [];
    for (let i = 0; i < 40; i += 1) {
      const bAct = i === 7 ? 'parry' : (i >= 9 && i <= 11 ? 'lp' : 'idle');
      s = step(s, i === 4 ? 'mp' : 'idle', bAct);
      events.push(...s.events.map((e) => ({ ...e, i })));
    }
    const punish = events.filter((e) => e.type === 'hit' && e.by === 'b');
    const evadedChain = guard({ move: 'mp', defAt: 7, frames: 45 });
    // Same ladder with nobody dodging: the chain really was available.
    let plain = createInitialState(23, 'chain-control', {});
    plain.a.x = 425;
    plain.b.x = 535;
    const plainEvents = [];
    for (let i = 0; i < 45; i += 1) {
      plain = step(plain, i === 4 ? 'mp' : (i === 8 ? 'hp' : 'idle'), 'idle');
      plainEvents.push(...plain.events.map((e) => ({ ...e, i })));
    }
    check('K50 读对了就白送一个确反：招架当帧脱出并反打；被穿掉的攻段不能 hit-confirm 接链',
      punish.length === 1 && punish[0].move === 'lp' && s.a.hp === CONFIG.MAX_HP - MOVES.lp.damage
        && s.b.hp === CONFIG.MAX_HP
        && evadedChain.of('cancel').length === 0
        && plainEvents.filter((e) => e.type === 'hit').length > 0,
      'punish=' + JSON.stringify(punish.map((e) => e.move)) + ' aHp=' + s.a.hp + ' evadedCancels=' + evadedChain.of('cancel').length);
  }

  {
    // "An evaded or parried attack counts as a whiff for the attacker" is a
    // rule with a hole in it if the kernel only marks the box as consumed:
    // hit-cancel links are gated on hasHit, so a read must NOT leave the
    // attacker holding a confirm. Meter-move chain cancels stay legal on a
    // whiff — that is rules 2.0 behaviour and this change must not tighten it.
    const ladder = ({ def, defAt, link }) => {
      let s = createInitialState(23, 'confirm', {});
      s.a.x = 425;
      s.b.x = 535;
      s.a.meter = 250;
      const events = [];
      for (let i = 0; i < 45; i += 1) {
        const defending = def ? (def === 'block' ? i >= defAt : i === defAt) : false;
        s = step(s, i === 4 ? 'mp' : (i === 15 ? link : 'idle'), defending ? def : 'idle');
        events.push(...s.events.map((e) => e.type));
      }
      const c = (t) => events.filter((e) => e === t).length;
      return { cancels: c('cancel'), hits: c('hit'), reads: c('evade') + c('parry'), blocks: c('block'), bHp: s.b.hp };
    };
    const landed = ladder({ def: null, defAt: -1, link: 'hp' });
    const evaded = ladder({ def: 'dodge', defAt: 7, link: 'hp' });
    const parried = ladder({ def: 'parry', defAt: 7, link: 'hp' });
    const blocked = ladder({ def: 'block', defAt: 8, link: 'hp' });
    const chainCancelStillFree = ladder({ def: 'dodge', defAt: 7, link: 'special' });
    check('K50b 被读到的进攻按空防处理：闪/架掉的 mp 不能 hit-confirm 进 hp，打中/被防可以；气槽链取消不变',
      landed.cancels === 1 && landed.hits === 2
        && blocked.cancels === 1 && blocked.blocks >= 1
        && evaded.reads === 1 && evaded.cancels === 0 && evaded.hits === 0 && evaded.bHp === CONFIG.MAX_HP
        && parried.reads === 1 && parried.cancels === 0 && parried.hits === 0
        && chainCancelStillFree.cancels === 1,
      'landed=' + landed.cancels + ' blocked=' + blocked.cancels + '/' + blocked.blocks + ' evaded=' + evaded.cancels
        + ' parried=' + parried.cancels + ' meterLinkOnEvade=' + chainCancelStillFree.cancels);
  }

}
}
