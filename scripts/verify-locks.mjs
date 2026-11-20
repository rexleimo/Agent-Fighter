/**
 * Task 3 acceptance: archetype action locks.
 *  - moveFor still returns fireball frame data for every fighter (compat)
 *  - actionAvailable is false for rush/counter/antiAir, true for multi/volley
 *  - a melee fighter spamming fireball emits input_locked == attempts, no
 *    fireball damage, under rules 2.2
 */
import { FIGHTER_KITS, lockedActions, actionAvailable } from '../src/kits/index.js';
import { moveFor } from '../src/rules.js';
import { createMatch } from '../src/engine.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  PASS  ${name}  |  ${detail}`); }
  else { fail += 1; console.error(`  FAIL  ${name}  |  ${detail}`); }
};

const byArchetype = { rush: [], counter: [], antiAir: [], multi: [], volley: [] };
for (const [id, kit] of Object.entries(FIGHTER_KITS)) byArchetype[kit.archetype].push(id);

// 1. frame data preserved, availability differs by archetype
let compat = true;
let lockedOk = true;
for (const [arch, ids] of Object.entries(byArchetype)) {
  for (const id of ids) {
    const m = moveFor({ fighterId: id, moveId: 'fireball' }, 'fireball');
    if (!m || m.startup !== 12) compat = false;
    const available = actionAvailable(id, 'fireball');
    const shouldLock = ['rush', 'counter', 'antiAir'].includes(arch);
    if (available === shouldLock) lockedOk = false;
  }
}
check('全 roster 的 moveFor 仍返回 fireball 帧数据（兼容）', compat);
check('rush/counter/antiAir 锁 fireball，multi/volley 不锁', lockedOk,
  Object.entries(byArchetype).map(([a, ids]) => `${a}:${actionAvailable(ids[0], 'fireball')}`).join(' '));
check('lockedActions 与 actionAvailable 一致',
  Object.entries(FIGHTER_KITS).every(([id, k]) => actionAvailable(id, 'fireball') === !lockedActions(id).includes('fireball')));

// 2. every locked fighter spamming fireball: all attempts rejected, no damage
for (const arch of ['rush', 'counter', 'antiAir']) {
  const id = byArchetype[arch][0];
  const m = createMatch({ seed: 5, matchId: 'lock-' + arch, fighters: { a: id, b: 'quartz' } });
  let attempts = 0;
  let lockedTicks = new Set();
  let fireballHits = 0;
  while (!m.over && m.tick < 200) {
    const tick = m.tick;
    attempts += 1;
    const out = m.advance('fireball', 'idle');
    for (const e of out.events) {
      if (e.type === 'input_locked' && e.by === 'a' && e.action === 'fireball') lockedTicks.add(tick);
      if (e.type === 'hit' && e.move === 'fireball' && e.by === 'a') fireballHits += 1;
    }
  }
  check(`${arch}/${id} 全量发波被拒（每拍都有 input_locked）`,
    lockedTicks.size === attempts && fireballHits === 0,
    `attempts=${attempts} lockedTicks=${lockedTicks.size} fireballHits=${fireballHits}`);
}

// 3. unlocked fighter can still fire
{
  const m = createMatch({ seed: 5, matchId: 'lock-volley', fighters: { a: 'quartz', b: 'quartz' } });
  let spawns = 0;
  while (!m.over && m.tick < 60) {
    const out = m.advance('fireball', 'idle');
    spawns += out.events.filter((e) => e.type === 'spawn' && e.move === 'fireball' && e.by === 'a').length;
  }
  check('volley/quartz 仍可正常发波', spawns > 0, `spawns=${spawns}`);
}

console.log(`\n${pass}/${pass + fail} lock checks passed`);
if (fail) process.exit(1);
