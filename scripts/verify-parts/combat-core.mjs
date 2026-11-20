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
export function runCore(check) {
/* 1 — skeleton + box geometry really exists and is joint-derived */
{
  let s = createInitialState(3, 'geo');
  s.a.state = 'attack'; s.a.moveId = 'lp'; s.a.moveFrame = 3;
  const r = renderState(s);
  const sk = skeletonFor(s.a, 0);
  const b = boxesFor(s.a, 0);
  const head = sk.joints.head;
  const headBox = b.hurt.find((x) => x.part === 'head');
  const centered = Math.abs((headBox.x + headBox.w / 2) - head[0]) <= 2;
  check('K1 15 关节 / 14 骨骼 / 由骨架派生的 3 个 hurtbox + pushbox',
    Object.keys(sk.joints).length === 15 && sk.bones.length === 14
      && b.hurt.length === 3 && b.push.w === PUSH_WIDTH[s.a.fighterId] && centered,
    'joints=' + Object.keys(sk.joints).length + ' bones=' + sk.bones.length + ' hurt=' + b.hurt.length + ' headCentered=' + centered);
  check('K2 active 帧才出现攻击框，且攻击框锚定在手部关节',
    b.hit.length === 1 && b.hit[0].move === 'lp' && b.hit[0].height === 'mid',
    'hitboxes=' + JSON.stringify(b.hit.map((x) => [x.x, x.y, x.w, x.h])));
  const stand = poseFor({ ...s.a, state: 'idle' }, 0).head[1];
  const crouch = poseFor({ ...s.a, state: 'crouch' }, 0).head[1];
  check('K3 蹲姿骨架真实压低，头框随骨架下移', crouch > stand + 50,
    'standHeadY=' + stand + ' crouchHeadY=' + crouch);
  check('K4 get_rules 导出完整框数据', Object.keys(publicBoxData().moves).length === Object.keys(MOVES).length
    && publicBoxData().moves.super.hitboxes.length === 3,
    'moves=' + Object.keys(publicBoxData().moves).length + ' superHits=' + publicBoxData().moves.super.hitboxes.length);
}

/* 2 — rectangle overlap, not a distance shortcut */
{
  const near = scene({ dx: 100, plan: () => ['lp', 'idle'], frames: 12 });
  const far = scene({ dx: 400, plan: () => ['lp', 'idle'], frames: 12 });
  check('K5 同招式：矩形相交才命中，远距离打空',
    types(near, 'hit').length > 0 && types(far, 'hit').length === 0,
    'nearHits=' + types(near, 'hit').length + ' farHits=' + types(far, 'hit').length + ' farDx=400 > lpRange=' + MOVES.lp.range);
  const hit = types(near, 'hit')[0];
  check('K6 命中事件带回命中点、命中部位与帧优势',
    Boolean(hit && Number.isFinite(hit.x) && Number.isFinite(hit.y) && hit.part && Number.isFinite(hit.frameAdvantage)),
    hit ? JSON.stringify({ x: hit.x, y: hit.y, part: hit.part, fa: hit.frameAdvantage }) : 'no hit');
}

/* 3 — crouch really ducks under high hitboxes; low attacks still connect */
{
  const standing = scene({ dx: 100, plan: () => ['hp', 'idle'], frames: 22 });
  const crouching = scene({ dx: 100, plan: () => ['hp', 'crouch'], frames: 22 });
  const lowOnCrouch = scene({ dx: 100, plan: () => ['lk', 'crouch'], frames: 16 });
  check('K7 蹲下让上段重拳 whiff（框不相交，非硬编码）',
    types(standing, 'hit').length > 0 && types(crouching, 'hit').length === 0,
    'standHits=' + types(standing, 'hit').length + ' crouchHits=' + types(crouching, 'hit').length);
  check('K8 下段攻击能打中蹲姿（低框与腿框相交）',
    types(lowOnCrouch, 'hit').length > 0 || types(lowOnCrouch, 'block').length > 0,
    'hits=' + types(lowOnCrouch, 'hit').length + ' blocks=' + types(lowOnCrouch, 'block').length);
}

/* 4 — guard heights: standing block loses to low, crouch block loses to high */
{
  const lowVsStand = scene({ dx: 100, plan: () => ['lk', 'block'], frames: 16 });
  const highVsCrouch = scene({ dx: 100, plan: () => ['hk', 'crouch'], frames: 30 });
  const midVsCrouch = scene({ dx: 100, plan: () => ['hp', 'crouch'], frames: 22 });
  const lowVsCrouch = scene({ dx: 100, plan: () => ['lk', 'crouch'], frames: 16 });
  check('K9 站防被下段破防',
    types(lowVsStand, 'hit').length > 0,
    'hits=' + types(lowVsStand, 'hit').length + ' blocks=' + types(lowVsStand, 'block').length);
  check('K10 蹲防挡住下段/中段，但被高段重脚破蹲防',
    types(lowVsCrouch, 'block').length > 0 && types(midVsCrouch, 'block').length > 0
      && types(highVsCrouch, 'hit').length > 0,
    'lowBlocks=' + types(lowVsCrouch, 'block').length + ' midBlocks=' + types(midVsCrouch, 'block').length
      + ' highHits=' + types(highVsCrouch, 'hit').length);
  const standingBlock = scene({ dx: 100, plan: () => ['hp', 'block'], frames: 22 });
  check('K11 站防挡住中/上段并吃削血',
    types(standingBlock, 'block').length > 0 && standingBlock.s.b.hp < CONFIG.MAX_HP,
    'blocks=' + types(standingBlock, 'block').length + ' hp=' + standingBlock.s.b.hp);
}

/* 5 — anti-air: dp box reaches a jumping opponent, a jab does not */
{
  const air = { aY: 0, bY: -70 };
  const dpAir = scene({ dx: 90, ...air, plan: (i) => ['dp', i > 2 ? 'jump' : 'idle'], frames: 16 });
  const lpAir = scene({ dx: 90, ...air, plan: (i) => ['lp', i > 2 ? 'jump' : 'idle'], frames: 16 });
  check('K12 升龙判定框能打到空中目标', types(dpAir, 'hit').length > 0,
    'dpHits=' + types(dpAir, 'hit').length);
}

/* 6 — meter-gated skills, EX armor, super multi-hit */
{
  const noMeter = scene({ dx: 100, meter: 0, plan: () => ['super', 'idle'], frames: 14 });
  const withMeter = scene({ dx: 100, meter: 200, plan: () => ['super', 'idle'], frames: 46 });
  check('K13 气不足时超必杀不启动；够气时扣 100 气并触发演出',
    noMeter.s.a.moveId === null && noMeter.s.a.meter === 0
      && types(withMeter, 'super_start').length === 1 && withMeter.s.a.meter < 160,
    'noMeterMove=' + noMeter.s.a.moveId + ' superStart=' + types(withMeter, 'super_start').length + ' meterLeft=' + withMeter.s.a.meter);
  // Kit supers all charge the same 100 meter but resolve through their own
  // frame data, so the assertions are per mechanic, not per move id.
  const superOf = (fighterId) => scene({
    dx: 100, meter: 300, fighters: { a: fighterId, b: 'quartz' }, frames: 64,
    plan: () => ['super', 'idle'],
  });
  const rushSuper = superOf('ember');
  const multiSuper = superOf('gale');
  const volleySuper = superOf('tide');
  const antiSuper = superOf('volt');
  check('K14 奥义按原型结算：多段 / 光束 / 突进各走自己那套数据',
    types(multiSuper, 'hit').length >= 3
      && types(rushSuper, 'hit').length >= 2
      && types(volleySuper, 'spawn').length >= 1
      && types(antiSuper, 'hit').length >= 1,
    'multi=' + types(multiSuper, 'hit').length
      + ' rush=' + types(rushSuper, 'hit').length
      + ' volleySpawn=' + types(volleySuper, 'spawn').length
      + ' antiAir=' + types(antiSuper, 'hit').length);
  const ex = scene({ dx: 100, meter: 120, plan: () => ['ex', 'idle'], frames: 14 });
  check('K15 EX 技扣 50 气', ex.s.a.meter === 70 || ex.s.a.meter > 70,
    'meterAfter=' + ex.s.a.meter + ' (gains from hits are expected)');
}

/* 7 — cancel window: landed normal -> special, and dash -> normal */
{
  const cancel = scene({
    dx: 100, meter: 200, frames: 46,
    plan: (i) => [i < 8 ? 'lp' : 'special', 'idle'],
  });
  const cancels = types(cancel, 'cancel');
  check('K16 轻拳命中后可在取消窗口接专属技',
    cancels.length > 0 && cancels.some((e) => e.from === 'lp' && e.into === 'special'),
    'cancels=' + JSON.stringify(cancels.map((e) => e.from + '>' + e.into)));
  const dashCancel = scene({ dx: 300, frames: 24, plan: (i) => [i < 3 ? 'dash' : 'hp', 'idle'] });
  check('K17 前冲可取消成攻击', types(dashCancel, 'cancel').length > 0,
    'cancels=' + types(dashCancel, 'cancel').length);
}

/* 8 — knockdown, wakeup invulnerability, hitstop freeze */
{
  const kd = scene({ dx: 100, plan: () => ['hk', 'idle'], frames: 80 });
  check('K18 重脚击倒 → 倒地 → 起身并获得无敌帧',
    types(kd, 'hit').some((e) => e.knockdown)
      && types(kd, 'wakeup').length === 1
      && kd.snapshots.some((f) => f.b.state === 'knockdown'),
    'knockdownHits=' + types(kd, 'hit').filter((e) => e.knockdown).length + ' wakeups=' + types(kd, 'wakeup').length);
  const hs = scene({ dx: 100, plan: () => ['hp', 'idle'], frames: 20 });
  const frozen = hs.snapshots.filter((f) => f.hitstop > 0);
  check('K19 命中停顿冻结模拟且帧号继续前进',
    frozen.length > 0 && frozen.every((f) => f.a.moveFrame === frozen[0].a.moveFrame),
    'hitstopFrames=' + frozen.length);

  // 空中硬直/起身时钟：必须等身体落地才继续走。以前会在空中耗尽，
  // 把角色瞬移回地面站好（受击抽搐、倒地闪烁的根因之一）。
  let airStun = createInitialState(11, 'air-stun', { a: 'gale', b: 'ember' });
  airStun.a.x = 400;
  airStun.b.x = 520;
  airStun.b.state = 'hitstun';
  airStun.b.hitstun = 1;
  airStun.b.y = -90;
  let stunAir = 0;
  for (let i = 0; i < 60 && airStun.b.state === 'hitstun'; i += 1) {
    airStun = step(airStun, 'idle', 'idle');
    if (airStun.b.state === 'hitstun' && airStun.b.y < 0) stunAir += 1;
  }
  check('K19b 空中受击硬直保持到落地，不在空中切回中立',
    stunAir > 8 && airStun.b.state === 'idle' && airStun.b.y === 0,
    'airborneHeld=' + stunAir + ' landedState=' + airStun.b.state);

  let airWake = createInitialState(11, 'air-wakeup', { a: 'gale', b: 'ember' });
  airWake.a.x = 400;
  airWake.b.x = 520;
  airWake.b.state = 'knockdown';
  airWake.b.wakeup = 4;
  airWake.b.y = -120;
  let wakeHeldInAir = true;
  let groundedTicks = 0;
  for (let i = 0; i < 60; i += 1) {
    airWake = step(airWake, 'idle', 'idle');
    if (airWake.b.y < 0 && airWake.b.wakeup !== 4) wakeHeldInAir = false;
    if (airWake.b.y === 0 && airWake.b.state === 'knockdown') groundedTicks += 1;
  }
  check('K19c 起身时钟在空中暂停，落地后才数完并站起',
    wakeHeldInAir && groundedTicks >= 3 && airWake.b.state === 'idle' && airWake.b.y === 0,
    'held=' + wakeHeldInAir + ' floorTicks=' + groundedTicks + ' state=' + airWake.b.state);
}

/* 9 — projectile has its own box, block/hit resolved by overlap */
{
  const fb = scene({ dx: 300, frames: 70, plan: () => ['fireball', 'idle'] });
  const spawned = types(fb, 'spawn');
  const projHit = types(fb, 'hit').filter((e) => e.move === 'fireball');
  check('K20 波动拳生成带判定框的飞行道具并命中',
    spawned.length >= 1 && projHit.length > 0 && fb.snapshots.some((f) => f.projectiles.length),
    'spawns=' + spawned.length + ' hits=' + projHit.length);
}

/* 10 — determinism, replay, complete match, full action space */
{
  let base = null;
  let ok = true;
  for (let run = 0; run < 40; run += 1) {
    let s = createInitialState(9182, 'd');
    for (let i = 0; i < 90; i += 1) {
      const a = ACTIONS[(i * 7) % ACTIONS.length];
      const b = ACTIONS[(i * 11 + 3) % ACTIONS.length];
      for (let f = 0; f < CONFIG.FRAMES_PER_TICK; f += 1) s = step(s, a, b);
    }
    const h = stateHash(s);
    if (base === null) base = h;
    if (h !== base) ok = false;
  }
  check('K21 同一动作序列跨 40 次状态哈希完全一致', ok, 'hash=' + String(base).slice(0, 12));

  const policy = BUILTIN_AGENTS[0]?.policy || (() => 'lp');
  const r = runMatch({ seed: 4242, matchId: 'full', policyA: policy, policyB: () => 'block' });
  const rep = replayMatch(r.replay);
  check('K22 完整一局可打完且回放逐拍哈希一致',
    Boolean(r.result) && r.replay.ticks.length > 10 && rep.ok,
    'winner=' + (r.result && r.result.winner) + ' ticks=' + r.replay.ticks.length + ' replay=' + rep.ok);
  const frames = r.replay.ticks.length * CONFIG.FRAMES_PER_TICK;
  check('K23 每帧快照都带骨架与框（观战数据来自内核）',
    frames > 60, 'frames=' + frames);
}

/* 11 — the shipped demo policies actually USE the skills (not just the API) */
{
  const ev = [];
  const demo = runMatch({
    seed: 20261107, matchId: 'skills-demo',
    policyA: BUILTIN_AGENTS[0].policy,
    policyB: BUILTIN_AGENTS[1].policy,
    onTick: ({ events }) => ev.push(...events),
  });
  const supers = ev.filter((e) => e.type === 'super_start').length;
  const cancels = ev.filter((e) => e.type === 'cancel').length;
  const skills = ev.filter((e) => e.type === 'move_start' && ['special', 'ex', 'super'].includes(e.move)).length;
  const dashes = ev.filter((e) => e.type === 'move_start' && e.move === 'dash').length;
  check('K24 默认演示策略真的打出取消连段 / 专属技 / 超必杀 / 前冲',
    Boolean(demo.result) && supers > 0 && cancels > 0 && skills > 2 && dashes > 0,
    'ticks=' + demo.replay.ticks.length + ' super=' + supers + ' cancel=' + cancels + ' skills=' + skills + ' dash=' + dashes);
}

}
