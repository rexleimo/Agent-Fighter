// 离线自测：不连服务器，用手工构造的 observation 验证策略分支。
// 改完 strategy.mjs / strategy.config.json 后跑 `npm test`，秒级反馈。
import assert from 'node:assert/strict';
import { strategy, ACTIONS } from './strategy.mjs';

function obs(patch = {}) {
  const base = {
    matchId: 'local_test', tick: 10, frame: 60, deadlineMs: 100,
    self: {
      hp: 1000, meter: 0, x: 300, y: 0, vx: 0, vy: 0, facing: 1,
      state: 'idle', moveId: null, moveFrame: 0, moveFrames: 0,
      recovery: 0, hitstun: 0, blockstun: 0, combo: 0,
      canCancel: false, inCorner: false, actionable: true,
    },
    opponent: {
      hp: 1000, meter: 0, x: 500, y: 0, vx: 0, vy: 0, facing: -1,
      state: 'idle', moveId: null, moveFrame: 0, moveFrames: 0,
      recovery: 0, hitstun: 0, blockstun: 0, combo: 0,
      canCancel: false, inCorner: false, actionable: true,
    },
    derived: {
      distanceX: 200, frameAdvantage: 0, punishable: false,
      opponentAirborne: false, opponentAttacking: false, opponentBlocking: false,
      threat: 'neutral', projectileIncoming: false,
      inRange: { lp: false, mp: false, hp: false, lk: false, mk: false, hk: false, dp: false, throw: false },
    },
    history: [], legalActions: ACTIONS,
  };
  const merged = {
    ...base,
    ...patch,
    self: { ...base.self, ...(patch.self || {}) },
    opponent: { ...base.opponent, ...(patch.opponent || {}) },
    derived: {
      ...base.derived,
      ...(patch.derived || {}),
      inRange: { ...base.derived.inRange, ...((patch.derived || {}).inRange || {}) },
    },
  };
  return merged;
}

const cases = [
  ['受击硬直时防御', () => strategy(obs({ self: { hitstun: 12 } })), 'block'],
  ['命中可取消时追击', () => strategy(obs({ self: { canCancel: true }, opponent: { hitstun: 16 } })), 'hp'],
  ['波动迫近时防御', () => strategy(obs({ derived: { projectileIncoming: true, threat: 'projectile' } })), 'block'],
  ['对手跳入时升龙', () => strategy(obs({ derived: { threat: 'jump_in', distanceX: 80, inRange: { dp: true } } })), 'dp'],
  ['远距离发波', () => strategy(obs({ derived: { distanceX: 400 } })), 'fireball'],
  ['中距离进场', () => strategy(obs({ derived: { distanceX: 160 } })), 'walk_f'],
  ['贴身重拳', () => strategy(obs({ derived: { distanceX: 60, inRange: { hp: true, mp: true } } })), 'hp'],
  ['够不到重拳用中拳', () => strategy(obs({ derived: { distanceX: 70, inRange: { mp: true } } })), 'mp'],
];

let passed = 0;
for (const [name, run, expected] of cases) {
  const got = run();
  assert.ok(ACTIONS.includes(got), `${name}: 返回了非法动作 ${got}`);
  assert.equal(got, expected, `${name}: 期望 ${expected}，实际 ${got}`);
  console.log(`  PASS  ${name.padEnd(20, ' ')} → ${got}`);
  passed += 1;
}
console.log(`\n${passed}/${cases.length} 条策略分支通过。策略可以上场了：npm start`);
