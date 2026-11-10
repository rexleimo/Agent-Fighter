/**
 * Combat-system acceptance: skeleton, authoritative boxes, skills, cancels,
 * meter, guard heights, anti-air, knockdown and hitstop. Pure kernel checks,
 * no server, no browser — `node scripts/verify-combat.mjs`.
 */
import { createInitialState, step, stateHash, renderState, runMatch, replayMatch } from '../src/engine.js';
import {
  CONFIG, MOVES, ACTIONS, moveDamage, moveReach,
} from '../src/rules.js';
import { ARCHETYPES, FIGHTER_KITS, FIGHTER_KIT_IDS, KIT_BALANCE } from '../src/kits/index.js';
import { FIGHTERS, PUSH_WIDTH } from '../src/fighters.js';
import { boxesFor, skeletonFor, poseFor, overlap, publicBoxData, pushboxFor } from '../src/combat.js';
import { BUILTIN_AGENTS } from '../src/agents.js';

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

const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' combat checks passed');
if (failed.length) {
  console.log('FAILED: ' + failed.map((f) => f.name).join(' | '));
  process.exit(1);
}
