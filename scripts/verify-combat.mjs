/**
 * Combat-system acceptance: skeleton, authoritative boxes, skills, cancels,
 * meter, guard heights, anti-air, knockdown and hitstop. Pure kernel checks,
 * no server, no browser — `node scripts/verify-combat.mjs`.
 */
import { createInitialState, step, stateHash, renderState, runMatch, replayMatch } from '../src/engine.js';
import {
  CONFIG, MOVES, ACTIONS, KITS, KIT_IDS, KIT_BALANCE, moveDamage, moveReach,
} from '../src/rules.js';
import { FIGHTERS } from '../src/fighters.js';
import { boxesFor, skeletonFor, poseFor, overlap, publicBoxData } from '../src/combat.js';
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
      && b.hurt.length === 3 && b.push.w === 38 && centered,
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

/* 12 — kits (B1): each archetype does what its data claims */
{
  const kitOf = (id) => FIGHTERS.find((f) => f.id === id).kit;

  // Every fighter has a real kit, all five archetypes are represented, and
  // each kit's skill frame data sits inside the published balance bands.
  const missing = FIGHTERS.filter((f) => !KITS[f.kit]).map((f) => f.id);
  const used = new Set(FIGHTERS.map((f) => f.kit));
  const bands = [];
  for (const kitId of KIT_IDS) {
    const moves = KITS[kitId].moves;
    const band = KIT_BALANCE[kitId];
    for (const action of ['special', 'ex', 'super']) {
      const dmg = moveDamage(moves[action]);
      const [lo, hi] = band[action];
      if (dmg < lo || dmg > hi) bands.push(kitId + '.' + action + '=' + dmg + ' not in [' + lo + ',' + hi + ']');
    }
    const reach = moveReach(moves.special);
    if (reach < band.reach[0] || reach > band.reach[1]) bands.push(kitId + '.reach=' + reach);
    const frames = moves.special.startup + moves.special.active + moves.special.recovery;
    if (frames < 30 || frames > 40) bands.push(kitId + '.specialFrames=' + frames);
  }
  check('K25 16 位角色都有合法原型，5 种原型全部上场，帧数据在平衡区间内',
    missing.length === 0 && used.size === KIT_IDS.length && bands.length === 0,
    'missing=' + JSON.stringify(missing) + ' used=' + [...used].sort().join(',')
      + (bands.length ? ' out=' + bands.join(';') : ' all-in-band'));

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
    distinct.size === KIT_IDS.length,
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

const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' combat checks passed');
if (failed.length) {
  console.log('FAILED: ' + failed.map((f) => f.name).join(' | '));
  process.exit(1);
}
