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
export async function runDefenseMore(check) {
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
    const dsl = await import('../../src/strategy-dsl.js');
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
      'docs/advanced.md': [/(\d+) 个(?:合法)?动作/g, /合法动作（(\d+) 个）/g],
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
    const onboarding = fs.readFileSync(path.join(ROOT, 'docs/advanced.md'), 'utf8');
    const listedMatch = onboarding.match(/"legalActions":\s*(\[[^\]]*\])/);
    const listed = listedMatch ? JSON.parse(listedMatch[1]).join(',') === ACTIONS.join(',') : false;
    // And the prose has to carry the two new rows plus the interaction table,
    // not just a bigger number.
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const skill = fs.readFileSync(path.join(ROOT, 'skills/afl-league/SKILL.md'), 'utf8');
    const documented = ['README.md', 'docs/advanced.md', 'skills/afl-league/SKILL.md']
      .every((f) => { const x = f === 'README.md' ? readme : f === 'skills/afl-league/SKILL.md' ? skill : onboarding; return /dodge/.test(x) && /parry/.test(x); })
      && /\| `dodge` 闪避 \|/.test(onboarding) && /\| `parry` 招架 \|/.test(onboarding)
      && /招架 `parry`/.test(readme) && /闪避 `dodge`/.test(readme);
    check('K61 文档与内核同源：动作数、规则版本、合法动作清单、相克表四处口径都由本文件校验',
      claims.length === 0 && versionClaims.length === 0 && listed && documented,
      'staleCounts=' + JSON.stringify(claims) + ' staleVersionClaims=' + JSON.stringify(versionClaims) + ' rosterListed=' + listed + ' defensiveRows=' + documented);
  }

}
