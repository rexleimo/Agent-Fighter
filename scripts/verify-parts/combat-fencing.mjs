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
export function runFencing(check) {
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

}
