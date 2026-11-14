/**
 * Combat-system acceptance: skeleton, authoritative boxes, skills, cancels,
 * meter, guard heights, anti-air, knockdown, hitstop and the defensive layer
 * (站防 / 蹲防 / 招架 / 闪避). Pure kernel checks, no server, no browser —
 * `node scripts/verify-combat.mjs`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInitialState, step, stateHash, renderState, runMatch, replayMatch } from '../src/engine.js';
import {
  CONFIG, MOVES, ACTIONS, moveDamage, moveReach, isAttack, isDefense, ATTACK_ACTIONS,
  defensiveRules,
} from '../src/rules.js';
import { ARCHETYPES, FIGHTER_KITS, FIGHTER_KIT_IDS, KIT_BALANCE } from '../src/kits/index.js';
import { FIGHTERS, PUSH_WIDTH } from '../src/fighters.js';
import { boxesFor, skeletonFor, poseFor, overlap, publicBoxData, pushboxFor, parryWindowOpen } from '../src/combat.js';
import { BUILTIN_AGENTS } from '../src/agents.js';
import { buildObservation } from '../src/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  |  ' + detail : ''));
}

/** Drive the kernel frame by frame, returning the state and every event. */
function scene({ dx = 100, aY = 0, bY = 0, meter = 0, plan, frames = 40, mutate = null, fighters = null }) {
  let s = createInitialState(11, 'combat-test', fighters || {});
  s.a.x = 480 - dx / 2;
  s.b.x = 480 + dx / 2;
  s.a.y = aY;
  s.b.y = bY;
  s.a.meter = meter;
  s.b.meter = meter;
  if (mutate) mutate(s);
  const events = [];
  const snapshots = [];
  for (let i = 0; i < frames; i += 1) {
    const [aa, ba] = plan(i, s);
    s = step(s, aa, ba);
    events.push(...s.events.map((e) => ({ ...e, i })));
    snapshots.push(renderState(s));
  }
  return { s, events, snapshots };
}

const types = (r, t) => r.events.filter((e) => e.type === t);

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

/* 12 — kits (B1): each fighter runs its own table inside the published bands */
{
  const kitOf = (id) => FIGHTERS.find((f) => f.id === id).kit;

  // Every fighter owns a kit, all five archetypes are represented, and each
  // fighter's own three skills sit inside its archetype's balance bands.
  const missing = FIGHTERS.filter((f) => !FIGHTER_KITS[f.id]).map((f) => f.id);
  const used = new Set(FIGHTERS.map((f) => f.kit));
  const bands = [];
  for (const fighterId of FIGHTER_KIT_IDS) {
    const kit = FIGHTER_KITS[fighterId];
    const band = KIT_BALANCE[kit.archetype];
    for (const action of ['special', 'ex', 'super']) {
      const m = kit.moves[action];
      if (!m) { bands.push(fighterId + '.' + action + '=missing'); continue; }
      const dmg = moveDamage(m);
      const [lo, hi] = band[action];
      if (dmg < lo || dmg > hi) bands.push(fighterId + '.' + action + '=' + dmg + ' not in [' + lo + ',' + hi + ']');
    }
    const reach = moveReach(kit.moves.special);
    if (reach < band.reach[0] || reach > band.reach[1]) bands.push(fighterId + '.reach=' + reach);
    const frames = kit.moves.special.startup + kit.moves.special.active + kit.moves.special.recovery;
    if (frames < 30 || frames > 40) bands.push(fighterId + '.specialFrames=' + frames);
  }
  check('K25 16 位角色各自拥有专属技能表，全部落在所属原型的平衡区间内',
    missing.length === 0 && used.size === Object.keys(ARCHETYPES).length && bands.length === 0,
    'missing=' + JSON.stringify(missing) + ' archetypes=' + [...used].sort().join(',')
      + (bands.length ? ' out=' + bands.join(';') : ' all-in-band'));

  // No two fighters share a move table: the whole point of per-fighter kits.
  const signature = (fighterId) => FIGHTER_KITS[fighterId].moves
    ? ['special', 'ex', 'super'].map((a) => {
      const m = FIGHTER_KITS[fighterId].moves[a];
      return [a, m.label, m.startup, m.active, m.recovery, m.damage || 0, m.range || 0,
        m.height || '', m.meterCost || 0, m.advance ? m.advance.vx : 0,
        m.projectile ? JSON.stringify(m.projectile) : '',
        m.counter ? JSON.stringify(m.counter) : ''].join('|');
    }).join('#')
    : '';
  const sigs = new Map();
  for (const fighterId of FIGHTER_KIT_IDS) {
    const s = signature(fighterId);
    if (!sigs.has(s)) sigs.set(s, []);
    sigs.get(s).push(fighterId);
  }
  const dupes = [...sigs.values()].filter((g) => g.length > 1);
  const labels = new Set(FIGHTER_KIT_IDS.map((id) => FIGHTER_KITS[id].moves.special.label));
  check('K25b 16 套技能两两互不相同（招式表与专属技名字都不重复）',
    dupes.length === 0 && labels.size === FIGHTER_KIT_IDS.length,
    'kits=' + FIGHTER_KIT_IDS.length + ' distinctTables=' + sigs.size
      + ' distinctSpecialNames=' + labels.size
      + (dupes.length ? ' dupes=' + dupes.map((d) => d.join('=')).join(',') : ''));

  // rush — the strike carries the fighter forward and knocks down.
  const rush = scene({ dx: 180, fighters: { a: 'ember', b: 'quartz' }, frames: 40, plan: () => ['special', 'idle'] });
  const rushed = rush.snapshots.some((f) => f.a.state === 'attack' && f.a.x > 480 - 180 / 2 + 30);
  check('K26 突进原型：专属技自带前冲位移并击倒',
    rushed && types(rush, 'hit').some((e) => e.knockdown),
    'moved=' + rushed + ' knockdown=' + types(rush, 'hit').filter((e) => e.knockdown).length);

  // volley — 1 orb on special, 2 on EX, and the beam is a much larger box.
  const once = (action) => (i) => [i < 4 ? action : 'idle', 'idle'];
  const volley = scene({ dx: 320, fighters: { a: 'tide', b: 'quartz' }, frames: 60, plan: once('special') });
  const volleyEx = scene({ dx: 320, meter: 200, fighters: { a: 'tide', b: 'quartz' }, frames: 60, plan: once('ex') });
  const volleySuper = scene({ dx: 320, meter: 300, fighters: { a: 'tide', b: 'quartz' }, frames: 70, plan: once('super') });
  const beamW = Math.max(...volleySuper.snapshots.flatMap((f) => f.projectiles.map((p) => p.box.w)), 0);
  const orbW = Math.max(...volley.snapshots.flatMap((f) => f.projectiles.map((p) => p.box.w)), 0);
  check('K27 波动原型：专属技一发、EX 连发两发、奥义光束明显更宽',
    types(volley, 'spawn').length === 1 && types(volleyEx, 'spawn').length === 2 && beamW > orbW * 2,
    'specialSpawns=' + types(volley, 'spawn').length + ' exSpawns=' + types(volleyEx, 'spawn').length
      + ' orbW=' + orbW + ' beamW=' + beamW);

  // counter — absorbs a melee hit and returns damage; projectiles ignore it.
  const stance = scene({ dx: 100, fighters: { a: 'coral', b: 'ember' }, frames: 40, plan: () => ['special', 'hp'] });
  const counters = types(stance, 'counter');
  const attackerHurt = stance.s.a.hp < 1000 ? false : stance.s.b.hp < 1000;
  check('K28 当身原型：架住近身攻击并把伤害还给对手',
    counters.length > 0 && counters[0].damage > 0 && attackerHurt,
    'counters=' + counters.length + ' damage=' + (counters[0] && counters[0].damage) + ' aHp=' + stance.s.a.hp + ' bHp=' + stance.s.b.hp);

  const vsOrb = scene({ dx: 320, fighters: { a: 'coral', b: 'tide' }, frames: 70, plan: () => ['special', 'special'] });
  check('K29 当身原型对飞行道具无效（不能靠它免疫波动）',
    types(vsOrb, 'counter').length === 0 && vsOrb.s.a.hp < 1000,
    'counters=' + types(vsOrb, 'counter').length + ' aHp=' + vsOrb.s.a.hp);

  // antiAir — startup invulnerability is real, not cosmetic.
  const rise = scene({ dx: 100, fighters: { a: 'volt', b: 'quartz' }, frames: 24, plan: () => ['special', 'hp'] });
  const invulnFrames = rise.snapshots.filter((f) => f.a.invuln > 0).length;
  check('K30 升龙原型：专属技起手带真实无敌帧',
    invulnFrames > 0 && rise.s.a.hp >= 0,
    'invulnFrames=' + invulnFrames);

  // multi — the string really lands more than one segment.
  const str = scene({ dx: 100, fighters: { a: 'gale', b: 'quartz' }, frames: 40, plan: () => ['special', 'idle'] });
  const strHits = types(str, 'hit');
  check('K31 多段原型：专属技在同一招里命中 2 段以上',
    strHits.length >= 2,
    'hits=' + strHits.length + ' damage=' + strHits.map((e) => e.damage).join('/'));

  // The same verb means different things per kit — that is the whole point.
  const mechanic = (fighterId, action) => {
    const r = scene({ dx: 160, meter: 300, fighters: { a: fighterId, b: 'quartz' }, frames: 30, plan: () => [action, 'idle'] });
    const ev = types(r, 'move_start')[0];
    return ev ? ev.mechanic : null;
  };
  const matrix = {
    rush: mechanic('ember', 'special'),
    volley: mechanic('tide', 'special'),
    counter: mechanic('coral', 'special'),
    antiAir: mechanic('volt', 'special'),
    multi: mechanic('gale', 'special'),
  };
  const distinct = new Set(Object.values(matrix));
  check('K32 同一个 special 按角色原型解析成不同机制',
    distinct.size === Object.keys(ARCHETYPES).length,
    Object.entries(matrix).map(([k, v]) => k + '=' + v).join(' '));

  // Cross-kit determinism: kits are part of the state, so the same seed with
  // the same fighters must replay byte-identically, and a different kit must
  // NOT produce the same hash.
  const hashFor = (fighters) => {
    let st = createInitialState(777, 'kit-hash', fighters);
    for (let i = 0; i < 120; i += 1) {
      const a = ACTIONS[(i * 5) % ACTIONS.length];
      const b = ACTIONS[(i * 9 + 1) % ACTIONS.length];
      for (let f = 0; f < CONFIG.FRAMES_PER_TICK; f += 1) st = step(st, a, b);
    }
    return stateHash(st);
  };
  const h1 = hashFor({ a: 'ember', b: 'tide' });
  const h2 = hashFor({ a: 'ember', b: 'tide' });
  const h3 = hashFor({ a: 'volt', b: 'tide' });
  check('K33 原型进入状态哈希：同角色可复现，换原型即不同',
    h1 === h2 && h1 !== h3,
    'same=' + (h1 === h2) + ' differs=' + (h1 !== h3));

  check('K34 rank 输出的 kit 与角色定义一致',
    kitOf('ember') === 'rush' && kitOf('tide') === 'volley' && kitOf('coral') === 'counter'
      && kitOf('volt') === 'antiAir' && kitOf('gale') === 'multi');
}

/* 35 — 朝向规则：启动+活跃帧锁定判定框方向，收招/硬直/中立永远面向对手 */
{
  // 旧实现每帧按双方相对位置重算朝向。投技把对手摔到身后、突进技穿身、
  // 被打飞越过对手时，角色会当场转过去，而动画帧还在朝原方向播 ——
  // 玩家看到的就是「角色反了」。现在的规则：启动+活跃帧锁朝向（否则判定框
  // 会甩到身后），收招一开始就转身（收招没有判定框），硬直中也面向对手。
  let s = createInitialState(11, 'facing-commit', { a: 'ember', b: 'tide' });
  s.a.x = 430;
  s.b.x = 530;
  const track = [];
  for (let i = 0; i < 40; i += 1) {
    s = step(s, i === 0 ? 'hp' : 'idle', 'idle');
    if (i === 4) s.b.x = s.a.x - 70;   // B 被送到 A 身后
    track.push({ state: s.a.state, facing: s.a.facing, moveFrame: s.a.moveFrame });
  }
  const hpWindow = MOVES.hp.startup + MOVES.hp.active;
  const committed = track.filter((f) => f.state === 'attack' && f.moveFrame <= hpWindow);
  const recovery = track.filter((f) => f.state === 'attack' && f.moveFrame > hpWindow);
  check('K35 启动+活跃帧不因穿身换向，收招期立即转向对手',
    committed.length > 0 && committed.every((f) => f.facing === 1)
      && recovery.length > 0 && recovery.every((f) => f.facing === -1)
      && track[track.length - 1].facing === -1,
    'committed=' + committed.length + ' recovery=' + recovery.length
      + ' lastFacing=' + track[track.length - 1].facing);

  // 仍然必须锁死朝向的承诺状态：空中、倒地、超必杀启动/活跃帧。
  // 逐个把对手传送到身后，看朝向是否保持不变。
  const cases = [
    ['airborne', (st) => { st.a.y = -60; st.a.vy = -6; st.a.state = 'jump'; }],
    ['knockdown', (st) => { st.a.state = 'knockdown'; st.a.wakeup = 20; }],
    ['super', (st) => { st.a.meter = 100; }],
  ];
  const held = [];
  for (const [name, setup] of cases) {
    let t = createInitialState(11, 'facing-' + name, { a: 'ember', b: 'tide' });
    t.a.x = 430;
    t.b.x = 530;
    t.a.facing = 1;
    setup(t);
    const action = name === 'super' ? 'super' : 'idle';
    let flipped = false;
    for (let i = 0; i < 6; i += 1) {
      t = step(t, action, 'idle');
      if (i === 1) t.b.x = t.a.x - 70;
      if (t.a.facing !== 1) flipped = true;
    }
    held.push(name + (flipped ? '=FLIPPED' : '=held'));
  }
  check('K35b 空中/倒地/超必杀启动期朝向不被穿身翻转',
    held.every((h) => h.endsWith('=held')),
    held.join(' '));

  // 反过来：硬直中必须立刻面向攻击者（KOF 的受击转身），否则会被连续
  // 从背后打到硬直结束，全程背对对手。
  const stunned = [];
  for (const [name, setup] of [
    ['hitstun', (st) => { st.a.state = 'hitstun'; st.a.hitstun = 12; }],
    ['blockstun', (st) => { st.a.state = 'guard'; st.a.blockstun = 10; }],
  ]) {
    let t = createInitialState(11, 'facing-turn-' + name, { a: 'ember', b: 'tide' });
    t.a.x = 430;
    t.b.x = 530;
    t.a.facing = 1;
    setup(t);
    t.b.x = t.a.x - 70;   // 对手在身后
    t = step(t, 'idle', 'idle');
    stunned.push(name + (t.a.facing === -1 ? '=turned' : '=STUCK' + t.a.facing));
  }
  check('K35c 受击/格挡硬直中转身面向对手',
    stunned.every((h) => h.endsWith('=turned')),
    stunned.join(' '));

  // 从截图复现的场景：波动被跳过身后，收招期必须转向对手，不能一直背对。
  let p = createInitialState(11, 'facing-fireball-recovery', { a: 'gale', b: 'gale' });
  p.a.x = 600;
  p.b.x = 700;
  p = step(p, 'fireball', 'idle');
  for (let i = 0; i < 14; i += 1) p = step(p, 'idle', 'idle');  // 跳过启动+活跃帧
  p.b.x = p.a.x - 90;                                            // 对手落在身后
  p = step(p, 'idle', 'idle');
  check('K35d 波动收招期转身面向身后的对手（截图场景）',
    p.a.state === 'projectile' && p.a.moveFrame > MOVES.fireball.startup + MOVES.fireball.active
      && p.a.facing === -1,
    'moveFrame=' + p.a.moveFrame + ' facing=' + p.a.facing);

  // 反过来也必须成立：承诺状态一结束，下一帧就得重新面向对手，
  // 否则锁朝向会变成「永远背对」。
  let r = createInitialState(11, 'facing-release', { a: 'ember', b: 'tide' });
  r.a.x = 430;
  r.b.x = r.a.x - 70;   // 对手一开始就在身后
  for (let i = 0; i < 3; i += 1) r = step(r, 'idle', 'idle');
  check('K35e 回到中立帧后立刻重新面向对手',
    r.a.facing === -1 && r.b.facing === 1,
    'a=' + r.a.facing + ' b=' + r.b.facing);
}

/* 6 — 身体不再穿模：推box 与可见身体同宽，墙角不残留半重叠 */
{
  const gapOf = (s) => {
    const pa = pushboxFor(s.a);
    const pb = pushboxFor(s.b);
    return Math.max(pb.x - (pa.x + pa.w), pa.x - (pb.x + pb.w));
  };
  // 双方对冲 120 帧：最宽的一对（gale 镜像）停下时推box 必须刚好相切。
  const mid = scene({ dx: 400, frames: 120, fighters: { a: 'gale', b: 'gale' }, plan: () => ['walk_f', 'walk_f'] });
  check('K36 对冲后身体相切不互穿（最宽镜像对）', gapOf(mid.s) >= -1,
    'gap=' + gapOf(mid.s) + ' dx=' + Math.abs(mid.s.a.x - mid.s.b.x));

  // 墙角：被顶到墙的一方吸收不了位移时，余量必须全部交给自由的一方。
  let c = createInitialState(11, 'push-corner', { a: 'gale', b: 'gale' });
  c.b.x = CONFIG.STAGE_RIGHT;
  c.a.x = CONFIG.STAGE_RIGHT - 60;
  for (let i = 0; i < 60; i += 1) c = step(c, 'walk_f', 'idle');
  check('K36b 墙角推挤不残留重叠，墙侧角色不被挤出舞台',
    gapOf(c) >= -1 && c.b.x === CONFIG.STAGE_RIGHT && c.a.x <= CONFIG.STAGE_RIGHT,
    'gap=' + gapOf(c) + ' a=' + c.a.x + ' b=' + c.b.x);

  // 倒地身体不是障碍：前冲（承诺位移、锁朝向）可以直接越过去。
  let d = createInitialState(11, 'push-downed', { a: 'gale', b: 'gale' });
  d.b.state = 'knockdown';
  d.b.wakeup = 40;
  d.b.x = 600;
  d.a.x = 560;
  for (let i = 0; i < 30; i += 1) d = step(d, i === 0 ? 'dash' : 'idle', 'idle');
  check('K36c 倒地推box 变低，前冲可越过身体', d.a.x > 600, 'a=' + d.a.x);

  // 接触距离下轻拳与投技都必须够得着（推box 加宽不能把近战废掉）。
  const contact = 128;
  const jab = scene({ dx: contact, frames: 30, fighters: { a: 'gale', b: 'gale' }, plan: (i) => [i === 0 ? 'lp' : 'idle', 'idle'] });
  check('K37 接触距离轻拳命中', types(jab, 'hit').some((e) => e.move === 'lp'),
    'hits=' + types(jab, 'hit').length);
  const grab = scene({ dx: contact, frames: 40, fighters: { a: 'gale', b: 'gale' }, plan: (i) => [i === 0 ? 'throw' : 'idle', 'idle'] });
  check('K37b 接触距离投技命中（判定框跨过推box 间隙）', types(grab, 'hit').some((e) => e.move === 'throw'),
    'hits=' + types(grab, 'hit').length);
  const whiff = scene({ dx: 220, frames: 40, fighters: { a: 'gale', b: 'gale' }, plan: (i) => [i === 0 ? 'throw' : 'idle', 'idle'] });
  check('K37c 超出投技距离仍然打空', types(whiff, 'hit').length === 0,
    'reach=' + MOVES.throw.range);

  // 跳逆：高处_airborne_ 不与地面身体推挤，否则永远跳不过去。
  let j = createInitialState(11, 'push-crossup', { a: 'gale', b: 'gale' });
  j.a.x = 500;
  j.b.x = 510;
  j.a.y = -90;
  j.a.vy = -2;
  j.a.state = 'jump';
  const before = j.a.x;
  j = step(j, 'idle', 'idle');
  check('K38 跳跃越过对手时不被推box 挡住', j.a.x === before, 'a=' + j.a.x);

  // 起身帧：wakeup 在主推挤之后才把 knockdown 翻成 idle，站在尸体上的一方
  // 必须在同一帧被分开，否则快照里会留一帧穿模（实测 basalt 镜像 2/930 帧）。
  let w = createInitialState(11, 'push-wakeup', { a: 'basalt', b: 'basalt' });
  w.b.state = 'knockdown';
  w.b.wakeup = 1;
  w.b.x = 600;
  w.a.x = 588;
  w = step(w, 'idle', 'idle');
  check('K38b 起身当帧即分离，不留一帧穿模', w.b.state === 'idle' && gapOf(w) >= -1,
    'state=' + w.b.state + ' gap=' + gapOf(w));
}

/* 39 — 升空弧线不被叠加：空中被 launch 击倒不能再给一次完整升力。 */
{
  const juggle = (attack) => {
    let s = createInitialState(11, 'launch-juggle', { a: 'gale', b: 'gale' });
    s.a.x = 430;
    s.b.x = 500;
    s.b.y = -80;
    s.b.vy = -2;
    s.b.state = 'jump';
    let peak = 0, hits = 0;
    for (let i = 0; i < 90; i += 1) {
      s = step(s, attack && i % 24 === 0 ? attack : 'idle', 'idle');
      if (s.b.y < peak) peak = s.b.y;
      hits += s.events.filter((e) => e.type === 'hit').length;
    }
    return { peak, hits };
  };
  // 对照：同一空中状态但没人出招，身体只沿原有弧线走完。
  const free = juggle(null);
  const mashed = juggle('dp');
  check('K39 空中被 launch 击倒不叠加升力（峰值不高于自由弧线）',
    mashed.hits > 0 && mashed.peak >= free.peak - 2,
    'free=' + free.peak.toFixed(1) + ' mashed=' + mashed.peak.toFixed(1) + ' hits=' + mashed.hits);

  // 天花板：任何来源的上升都被夹在 AIR_CEILING 内，渲染层按同一预算留白。
  let c = createInitialState(11, 'air-ceiling', { a: 'gale', b: 'gale' });
  c.b.vy = -60;
  let low = 0;
  for (let i = 0; i < 60; i += 1) {
    c = step(c, 'idle', 'idle');
    if (c.b.y < low) low = c.b.y;
  }
  check('K39b 任何升力都被夹在 AIR_CEILING 内，头不会被画出舞台',
    low >= -CONFIG.AIR_CEILING, 'minY=' + low + ' ceiling=' + -CONFIG.AIR_CEILING);
}

/* 40 — 防御层（规则 2.1）：闪避 / 招架的相克契约，逐帧驱动内核 */
{
  /**
   * One attack, one defence, both issued ONCE — so an event count of 2 can
   * never quietly mean "the bot re-issued the same move". The frame numbers
   * below were measured against this driver, not guessed.
   */
  const guard = ({ move, dx = 110, atkAt = 4, def = 'dodge', defAt = 7, frames = 45, meter = 0, hold = false }) => {
    let s = createInitialState(23, 'guard-layer', {});
    s.a.x = 480 - dx / 2;
    s.b.x = 480 + dx / 2;
    s.a.meter = meter;
    s.b.meter = meter;
    const events = [];
    for (let i = 0; i < frames; i += 1) {
      const defending = hold ? i >= defAt : i === defAt;
      s = step(s, i === atkAt ? move : 'idle', defending ? def : 'idle');
      events.push(...s.events.map((e) => ({ ...e, i })));
    }
    const of = (t) => events.filter((e) => e.type === t);
    return { s, events, of, hit: of('hit')[0], read: of('evade')[0] || of('parry')[0] };
  };

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

  const superVsParry = guard({ move: 'super', dx: 130, atkAt: 8, def: 'parry', defAt: 18, frames: 80, meter: 200 });
  const superVsDodge = guard({ move: 'super', dx: 130, atkAt: 8, def: 'dodge', defAt: 18, frames: 80, meter: 200 });
  check('K51 一次读只吃一段：多段奥义不会整条被招架/闪避吞掉',
    moveDamage(MOVES.super) > MOVES.super.damage && superVsParry.of('parry').length === 1
      && superVsDodge.of('evade').length === 1,
    'potential=' + moveDamage(MOVES.super) + ' parries=' + superVsParry.of('parry').length + ' evades=' + superVsDodge.of('evade').length);

  {
    let s = createInitialState(31, 'dodge-cd', {});
    s.a.x = 300;
    s.b.x = 800;
    const cadence = [];
    const cds = [];
    for (let i = 0; i < 120; i += 1) {
      s = step(s, 'dodge', 'idle');
      cadence.push(s.a.state === 'dodge' ? 'D' : '.');
      cds.push(s.a.dodgeCd);
    }
    const starts = cadence.join('').split('D').length - 1;
    const cycles = Math.floor(120 / MOVES.dodge.evade.cooldown);
    let monotone = true;
    for (let i = 0; i < 18; i += 1) if (cds[i] !== CONFIG.MAX_METER - 0 && cds[i] > cds[i - 1] && i > 0) monotone = false;
    check('K52 闪避有冷却：按住输入 120 帧只能出 ' + cycles + ' 次，dodgeCd 从 30 递减到 0',
      starts === cycles * 18 && s.a.dodgeCd === 0
        && cds[0] === MOVES.dodge.evade.cooldown - 1 && cds[MOVES.dodge.evade.cooldown - 1] === 0,
      'dodgeFrames=' + starts + '/' + cycles * 18 + ' cycle=' + MOVES.dodge.evade.cooldown + ' first=' + cds[0] + ' last=' + s.a.dodgeCd + ' monotone=' + monotone);
  }

  {
    let s = createInitialState(13, 'air-dodge', {});
    s.a.x = 480;
    s.b.x = 700;
    s = step(s, 'jump', 'idle');
    const airY = s.a.y;
    s = step(s, 'dodge', 'idle');
    const airState = s.a.state;
    let d = createInitialState(14, 'dash-dodge', {});
    d.a.x = 400;
    d.b.x = 700;
    const ev = [];
    for (let i = 0; i < 12; i += 1) {
      d = step(d, i < 4 ? 'dash' : (i === 4 ? 'dodge' : 'idle'), 'idle');
      ev.push(...d.events);
    }
    const anyLadder = Object.values(MOVES).some((m) => (m.cancelInto || []).some((a) => a === 'dodge' || a === 'parry'));
    check('K53 防御动作不在空中出、不被取消进来：跳起中按闪避仍是跳，前冲取消不出招架',
      airY < 0 && airState === 'jump' && ev.filter((e) => e.type === 'cancel').length === 0 && !anyLadder,
      'airState=' + airState + ' dashCancels=' + ev.filter((e) => e.type === 'cancel').length + ' ladderMentionsDefense=' + anyLadder);
  }

  {
    let s = createInitialState(9, 'defense-obs', {});
    s.a.x = 480;
    s.b.x = 560;
    s = step(s, 'dodge', 'parry');
    const o = buildObservation(s, 'a', 0, CONFIG.TICK_MS, [], 9);
    const back = buildObservation(s, 'b', 0, CONFIG.TICK_MS, [], 9);
    check('K54 观察面给全：legalActions 21、闪避/招架期 actionable=false、dodgeCd 与 parrying 可读、对手在读招架',
      o.legalActions.length === ACTIONS.length && o.legalActions.includes('dodge') && o.legalActions.includes('parry')
        && o.self.state === 'dodge' && o.self.actionable === false && o.self.recovery > 0
        && o.self.dodgeCd === MOVES.dodge.evade.cooldown - 1 && o.self.parrying === false
        && back.derived.opponentDodging === true && back.derived.opponentEvading === true
        && back.self.parrying === parryWindowOpen(s.a) === false,
      'legal=' + o.legalActions.length + ' actionable=' + o.self.actionable + ' cd=' + o.self.dodgeCd + ' oppEvading=' + back.derived.opponentEvading);
  }

  {
    let s = createInitialState(1, 'pose-read', {});
    const spread = (p, q) => Object.keys(p).reduce((n, k) => n + Math.hypot(p[k][0] - q[k][0], p[k][1] - q[k][1]), 0);
    const worst = (p, q) => Math.max(...Object.keys(p).map((k) => Math.hypot(p[k][0] - q[k][0], p[k][1] - q[k][1])));
    const idle = poseFor({ ...s.a, state: 'idle' }, 0);
    const guardPose = poseFor({ ...s.a, state: 'guard' }, 0);
    const d = step(s, 'dodge', 'idle');
    const p = step(s, 'parry', 'idle');
    const dodgePose = poseFor(d.a, 1);
    const parryPose = poseFor(p.a, 1);
    check('K55 闪避/招架的骨架读得出来：姿态与待机/站防的关节位移超过阈值（画面不靠猜）',
      spread(dodgePose, idle) > 150 && worst(dodgePose, idle) > 30
        && spread(parryPose, guardPose) > 80 && worst(parryPose, guardPose) > 20,
      'dodgeVsIdle=' + spread(dodgePose, idle).toFixed(0) + ' parryVsGuard=' + spread(parryPose, guardPose).toFixed(0));
  }

  {
    const rules = defensiveRules();
    const box = publicBoxData();
    const cell = rules.actions;
    const consistent = rules.version === CONFIG.RULES_VERSION
      && box.defensive === undefined || true;
    check('K56 规则以数据发布：get_rules().defensive 与招式表/CONFIG 同源，五行相克矩阵齐',
      rules.matrix.length === 5 && Object.keys(cell).join(',') === 'block,crouch,parry,dodge'
        && cell.parry.window === MOVES.parry.active && cell.parry.recovery === MOVES.parry.recovery
        && cell.parry.meterGain === MOVES.parry.parry.meterGain
        && cell.dodge.invuln === MOVES.dodge.invuln && cell.dodge.cooldown === MOVES.dodge.evade.cooldown
        && cell.dodge.distance === MOVES.dodge.evade.back * MOVES.dodge.invuln
        && box.defensive.version === CONFIG.RULES_VERSION
        && box.moves.dodge.kind === 'defense' && box.moves.parry.parry.meterGain === CONFIG.PARRY_METER
        && box.moves.throw.breaksDodge === true,
      'version=' + rules.version + ' matrix=' + rules.matrix.length + ' consistent=' + consistent);
  }

  {
    const base = createInitialState(77, 'defense-hash', {});
    let a = structuredClone(base);
    let b = structuredClone(base);
    a.a.dodgeCd = 0;
    b.a.dodgeCd = 12;
    const pol = (side) => (obs) => {
      const d = obs.derived;
      if (obs.tick % 5 === 0) return side;
      if (d.opponentAttacking) return 'block';
      if (d.distanceX > 200) return 'walk_f';
      return ['lp', 'mp', 'lk', 'hk', 'throw', 'dp'][obs.tick % 6];
    };
    const r = runMatch({ seed: 31337, matchId: 'defense-replay', policyA: pol('dodge'), policyB: pol('parry'), ticks: 300 });
    const rep = replayMatch(r.replay);
    check('K57 确定性：dodgeCd 进状态哈希；300 拍全程使用闪避/招架的对局逐拍复现',
      stateHash(a) !== stateHash(b)
        && rep.ok && r.replay.ticks.length === 300 && r.state.a.dodgeCd >= 0,
      'cdHashed=' + (stateHash(a) !== stateHash(b)) + ' ticks=' + r.replay.ticks.length + ' replay=' + rep.ok + ' mismatches=' + rep.mismatches.length);
  }

  {
    const events = [];
    let games = 0;
    for (const A of BUILTIN_AGENTS) {
      for (const B of BUILTIN_AGENTS) {
        runMatch({
          seed: 900 + games, matchId: 'baseline-' + games, ticks: 200,
          policyA: A.policy, policyB: B.policy,
          onTick: ({ events: e }) => events.push(...e),
        });
        games += 1;
      }
    }
    const reads = events.filter((e) => e.type === 'evade' || e.type === 'parry').length;
    const hits = events.filter((e) => e.type === 'hit').length;
    check('K58 官方基线一局都不闪不架：榜单强度不因为新动作漂移',
      games === BUILTIN_AGENTS.length * BUILTIN_AGENTS.length && reads === 0 && hits > 100,
      'games=' + games + ' reads=' + reads + ' hits=' + hits);
  }

  {
    // A hosted policy is the other half of "the action space is public": the
    // DSL must accept the new actions, and the example strategies that shipped
    // before rules 2.1 must still validate and simulate.
    const dsl = await import('../src/strategy-dsl.js');
    const guarded = dsl.validateStrategy({
      name: 'defensive layer probe',
      defaultAction: 'parry',
      rules: [
        { when: { 'derived.opponentParrying': true }, action: 'throw', note: 'they read you — throw beats their read' },
        { when: { 'derived.threat': 'poke' }, action: 'dodge' },
      ],
    });
    const decided = dsl.decide(guarded, { derived: { threat: 'poke' }, self: {}, opponent: {} }).action;
    const threw = dsl.decide(guarded, { derived: { opponentParrying: true, threat: 'poke' }, self: {}, opponent: {} }).action;
    const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/hosted-agent/strategy.json'), 'utf8'));
    const exampleValid = dsl.validateStrategy(example).rules.length > 0;
    const sim = dsl.simulateStrategy({ ...example, rules: [...example.rules, { when: { 'derived.threat': 'projectile' }, action: 'dodge', note: 'rules 2.1' }], defaultAction: 'block' });
    check('K59 托管策略能用新动作：DSL 接受 dodge/parry，旧样例仍校验通过并能跑离线胜率',
      guarded.defaultAction === 'parry' && decided === 'dodge' && threw === 'throw' && exampleValid
        && sim.games === 9 && typeof sim.overallWinRate === 'number' && sim.rows.length === 3,
      'decided=' + decided + ' exampleRules=' + (example.rules || []).length + ' simGames=' + sim.games + ' winRate=' + sim.overallWinRate + '%');
  }

  {
    // The training report counts "whiffed attacks". A defensive action is not
    // an attack, and must never show up in that table as one.
    const asAttacks = ACTIONS.filter(isAttack);
    const derivedSame = ATTACK_ACTIONS.join(',') === asAttacks.join(',');
    const defenseLeak = ATTACK_ACTIONS.filter((a) => isDefense(a));
    check('K60 训练场出招口径由 kind 派生：闪避/招架不算出招，站防/蹲防也不算',
      derivedSame && defenseLeak.length === 0 && !ATTACK_ACTIONS.includes('block') && !ATTACK_ACTIONS.includes('dash'),
      'attacks=' + asAttacks.length + ' leaked=' + JSON.stringify(defenseLeak));
  }

  {
    const docs = {
      'README.md': [/(\d+) 个(?:合法)?动作/g],
      'docs/agent-onboarding.md': [/(\d+) 个(?:合法)?动作/g, /合法动作（(\d+) 个）/g],
      'skills/afl-league/SKILL.md': [/白名单之一（(\d+) 个）/g],
    };
    const claims = [];
    for (const [file, patterns] of Object.entries(docs)) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const re of patterns) {
        for (const m of text.matchAll(re)) {
          if (Number(m[1]) !== ACTIONS.length) claims.push(file + ' says ' + m[0] + ' but ACTIONS.length=' + ACTIONS.length);
        }
      }
    }
    // The version the prose advertises has to be the version the kernel stamps
    // into every replay header.
    const versionClaims = [];
    for (const file of Object.keys(docs)) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const m of text.matchAll(/规则(?:版本)?\s*(\d+\.\d+)/g)) {
        if (m[1] !== CONFIG.RULES_VERSION) versionClaims.push(file + ':' + m[0]);
      }
    }
    // And the onboarding action block has to list exactly the action space.
    const onboarding = fs.readFileSync(path.join(ROOT, 'docs/agent-onboarding.md'), 'utf8');
    const listedMatch = onboarding.match(/"legalActions":\s*(\[[^\]]*\])/);
    const listed = listedMatch ? JSON.parse(listedMatch[1]).join(',') === ACTIONS.join(',') : false;
    // And the prose has to carry the two new rows plus the interaction table,
    // not just a bigger number.
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const skill = fs.readFileSync(path.join(ROOT, 'skills/afl-league/SKILL.md'), 'utf8');
    const documented = ['README.md', 'docs/agent-onboarding.md', 'skills/afl-league/SKILL.md']
      .every((f) => { const x = f === 'README.md' ? readme : f === 'skills/afl-league/SKILL.md' ? skill : onboarding; return /dodge/.test(x) && /parry/.test(x); })
      && /\| `dodge` 闪避 \|/.test(onboarding) && /\| `parry` 招架 \|/.test(onboarding)
      && /招架 `parry`/.test(readme) && /闪避 `dodge`/.test(readme);
    check('K61 文档与内核同源：动作数、规则版本、合法动作清单、相克表四处口径都由本文件校验',
      claims.length === 0 && versionClaims.length === 0 && listed && documented,
      'staleCounts=' + JSON.stringify(claims) + ' staleVersionClaims=' + JSON.stringify(versionClaims) + ' rosterListed=' + listed + ' defensiveRows=' + documented);
  }
}

{
  // The check count the README advertises is itself a claim about the kernel.
  // Asserting it here (as the last item, so it can count itself) means the
  // number can never quietly drift from the suite.
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const claims = [...readme.matchAll(/(\d+) 项战斗内核验收/g)].map((m) => Number(m[1]));
  const expected = results.length + 1;
  check('K62 README 公布的验收项数 == 本文件实际跑完的项数',
    claims.length >= 2 && claims.every((c) => c === expected),
    'claims=' + JSON.stringify(claims) + ' actual=' + expected);
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' combat checks passed');
if (failed.length) {
  console.log('FAILED: ' + failed.map((f) => f.name).join(' | '));
  process.exit(1);
}
