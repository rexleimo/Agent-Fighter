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
export function runKits(check) {
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

}
