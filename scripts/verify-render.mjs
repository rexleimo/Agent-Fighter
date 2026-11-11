#!/usr/bin/env node
/**
 * Drawing-selection contract for web/sprite.js.
 *
 * The projection from authoritative fighter state to drawing is what made
 * fighters read as "convulsing": switching hitstun drawings mid-stun, or
 * swapping the knockdown pose on a timer instead of on the body's height.
 * These checks lock the two invariants that fixed it, and the size contract
 * that answers 受击时一大一小: every shipped sheet carries the bake's own
 * standing-pose measurement, so the gate asserts it without reading a pixel.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectFrame } from '../web/sprite.js';
import { OFF_MODEL_ART } from './sprites/sheets.mjs';
import { MOVES, CONFIG } from '../src/rules.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const index = JSON.parse(fs.readFileSync(path.join(root, 'web/assets/sprites.json'), 'utf8'));

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });
const pick = (anim, f) => selectFrame(anim, f, 100);
// Every move id in the rules; clips without a phase map are skipped inside the
// recovery check, so this is the full candidate list, not a per-fighter subset.
const MOVE_CLIPS = Object.keys(MOVES);

// Stage order while a downed body gets up: floor -> kneel -> crouch -> stance.
const stageRank = (s) => {
  if (s.clipId === 'knockdown') return s.idx === 1 ? 0 : -1;
  if (s.clipId === 'getup') return s.idx === 0 ? 1 : 2;
  if (s.clipId === 'wakeup') return 3;
  return 99;
};

for (const entry of index.fighters) {
  const animFile = path.join(root, 'web' + entry.anim);
  const anim = JSON.parse(fs.readFileSync(animFile, 'utf8'));
  const tag = entry.id;

  check(tag + ' 有 knockdown/getup/wakeup 三段起身素材',
    anim.clips.knockdown && anim.clips.getup && anim.clips.wakeup,
    'knockdown=' + Boolean(anim.clips.knockdown) + ' getup=' + Boolean(anim.clips.getup) + ' wakeup=' + Boolean(anim.clips.wakeup));

  // One drawing while a combo keeps re-topping the stun, then the stagger for
  // the tail nobody re-tops. The anti-convulsion rule is that a single stun
  // never revisits a drawing: it only ever steps forward.
  const twoHurtCells = anim.clips.hitstun.frames.length > 1;
  const stunTop = [30, 24, 16, 12, 9].every((hs) => [0, -140].every((y) => {
    const s = pick(anim, { state: 'hitstun', hitstun: hs, y });
    return s.clipId === 'hitstun' && s.idx === 0;
  }));
  check(tag + ' 连段不断补硬直时只画同一个受击画格（不抽搐）', stunTop);

  const stunTail = !twoHurtCells || [8, 4, 1].every((hs) => [0, -140].every((y) => {
    const s = pick(anim, { state: 'hitstun', hitstun: hs, y });
    return s.clipId === 'hitstun' && s.idx === 1;
  }));
  check(tag + ' 没人补刀时硬直尾段收势到第二个受击画格', stunTail);

  const stunSeq = [];
  for (let hs = 30; hs >= 1; hs -= 1) stunSeq.push(pick(anim, { state: 'hitstun', hitstun: hs, y: 0 }).idx);
  check(tag + ' 单次硬直内受击画格单调前进，不回跳',
    stunSeq.every((v, i) => i === 0 || v >= stunSeq[i - 1])
      && stunSeq[0] === 0 && (stunSeq[stunSeq.length - 1] === (twoHurtCells ? 1 : 0)),
    'seq=' + stunSeq.join(''));

  // Airborne knockdown keeps the topple drawing regardless of the getup clock.
  const air = [22, 15, 10, 4, 1].every((wakeup) => {
    const s = pick(anim, { state: 'knockdown', wakeup, y: -40 });
    return s.clipId === 'knockdown' && s.idx === 0;
  });
  check(tag + ' 空中倒地只画倾倒画格（时钟不提前换姿势）', air);

  const grounded = [
    [20, 'knockdown', 1], [12, 'knockdown', 1],
    [11, 'getup', 0], [8, 'getup', 0],
    [6, 'getup', 1], [4, 'getup', 1],
    [3, 'wakeup', 0], [1, 'wakeup', 0],
  ].every(([wakeup, clipId, idx]) => {
    const s = pick(anim, { state: 'knockdown', wakeup, y: 0 });
    return s.clipId === clipId && s.idx === idx;
  });
  check(tag + ' 落地后 躺→跪→蹲→站 逐段推进', grounded);

  // As the wakeup clock counts down the stage must only ever move forward.
  const ranks = [];
  for (let w = 21; w >= 1; w -= 1) ranks.push(stageRank(pick(anim, { state: 'knockdown', wakeup: w, y: 0 })));
  const monotonic = ranks.every((r, i) => i === 0 || r >= ranks[i - 1]) && ranks[0] === 0 && ranks[ranks.length - 1] === 3;
  check(tag + ' 起身阶段单调前进，不回跳', monotonic, 'ranks=' + ranks.join(','));

  // 收招期不许冻在一格：按招式真实帧数把画格走回起手，末段交回待机循环，
  // 这样招式是在站姿里结束，而不是从弓步硬切到站姿。
  const worst = { move: '', run: 0, budget: 0 };
  const retractOk = MOVE_CLIPS.every((moveId) => {
    const clip = anim.clips[moveId];
    const spec = MOVES[moveId];
    if (!clip || !clip.phases || !spec) return true;
    const rec = clip.phases.recovery;
    const followThrough = rec[rec.length - 1];
    const picks = [];
    for (let mf = spec.startup + spec.active; mf < spec.startup + spec.active + spec.recovery; mf += 1) {
      picks.push(pick(anim, {
        state: 'attack', moveId, moveFrame: mf,
        phase: { phase: 'recovery', startup: spec.startup, active: spec.active, recovery: spec.recovery },
      }));
    }
    const cells = picks.map((p) => (p.clipId === moveId ? p.idx : -1)); // -1 = 已交回待机
    let run = 1, maxRun = 1;
    for (let i = 1; i < cells.length; i += 1) {
      run = cells[i] === cells[i - 1] ? run + 1 : 1;
      maxRun = Math.max(maxRun, run);
    }
    const budget = Math.ceil(spec.recovery / (followThrough + 1)) + 1;
    worst.move = moveId; worst.run = maxRun; worst.budget = budget;
    return cells[0] === followThrough && cells.every((v, i) => i === 0 || v <= cells[i - 1])
      && cells[cells.length - 1] === -1 && maxRun <= budget;
  });
  check(tag + ' 收招期沿本招画格收势并交回待机（不冻结、不硬切）', retractOk,
    'worst=' + worst.move + ' run=' + worst.run + ' budget=' + worst.budget);

  // 尺寸契约（不读一个像素）：bake 把每个 sheet 站姿画格的实测值写进 anim，
  // 这里只断言三件事 —— 站着打的 sheet 必须被度量过；度量结果要么落回站姿
  // 高度带内，要么显式登记为素材债；登记的数字必须和随包出去的元数据一致。
  // 有人重烤把残差改了却不改登记表，也会在这里红掉。
  const judged = ['base', 'react'].every((sheet) => anim.sheets[sheet] && anim.sheets[sheet].standing);
  check(tag + ' base/react 都带站姿高度实测（尺寸契约可核验）', judged,
    Object.entries(anim.sheets).filter(([, ref]) => ref.standing).map(([s]) => s).join(','));

  const debt = Object.entries(anim.sheets)
    .map(([sheet, ref]) => [sheet, ref.standing])
    .filter(([, s]) => s && s.offModel);
  const unregistered = debt.filter(([, s]) => !s.offModel.registered).map(([sheet]) => sheet);
  const stale = debt.filter(([sheet, s]) => {
    const entry = OFF_MODEL_ART[tag + '/' + sheet];
    return !entry || entry.residualShare !== s.residualShare;
  }).map(([sheet, s]) => sheet + '@' + s.residualShare);
  check(tag + ' 每个 sheet 的站姿都在高度带内，或登记为素材债',
    unregistered.length === 0 && stale.length === 0,
    'unregistered=' + (unregistered.join(',') || 'none') + ' stale-register=' + (stale.join(',') || 'none'));

  // 残差就是玩家真正看到的那一刀，登记项必须说清归零它要花多少次生图。
  for (const [sheet, s] of debt) {
    const entry = OFF_MODEL_ART[tag + '/' + sheet];
    check(tag + ' ' + sheet + ' 素材债已量化并给了归零代价',
      Boolean(entry) && s.residualShare > 0.75 && Boolean(entry.cost),
      'residualShare=' + s.residualShare + ' cost=' + (entry ? entry.cost : 'unregistered'));
  }
}

// The stage has to be tall enough for the highest a body can go: a frame is a
// tight crop offset from the anchor, so the topmost pixel the renderer can put
// down is GROUND - AIR_CEILING - (anchorY - minOy)*k. If it goes negative the
// fighter is drawn off the top of the canvas, which is the 错位 the reports are
// about. Read the extents from the shipped frames, not from a nominal square.
{
  const appSrc = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
  const ground = Number(appSrc.match(/const GROUND = (\d+);/)[1]);
  const spriteH = Number(appSrc.match(/const H = (\d+);/)[1]);
  const stageH = Number(html.match(/<canvas id="stage" width="\d+" height="(\d+)">/)[1]);
  let rise = 0, drop = 0;
  for (const entry of index.fighters) {
    const anim = JSON.parse(fs.readFileSync(path.join(root, 'web' + entry.anim), 'utf8'));
    const k = spriteH / anim.stanceHeight;
    for (const clip of Object.values(anim.clips)) for (const r of clip.frames) {
      rise = Math.max(rise, (anim.anchor[1] - r.oy) * k);
      drop = Math.max(drop, (r.oy + r.h - anim.anchor[1]) * k);
    }
  }
  const top = ground - CONFIG.AIR_CEILING - rise;
  const bottom = ground + drop;
  check('舞台留白容得下最高空中画格（精灵图不会被画出上下沿）',
    top >= 0 && bottom <= stageH,
    'top=' + top.toFixed(1) + ' bottom=' + bottom.toFixed(1) + ' stage=' + stageH + ' ground=' + ground);
}

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log((r.ok ? '  PASS ' : '  FAIL ') + r.name + (r.detail ? '  | ' + r.detail : ''));
}
console.log('');
console.log(failed.length ? failed.length + '/' + results.length + ' render checks FAILED' : results.length + '/' + results.length + ' render checks passed');
process.exit(failed.length ? 1 : 0);
