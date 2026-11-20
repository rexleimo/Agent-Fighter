// Team verification — extracted from scripts/verify-team.mjs by responsibility.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CONFIG } from '../../src/config.js';
import { createMatch } from '../../src/engine.js';
import { BUILTIN_AGENTS } from '../../src/agents.js';
import { templatePolicy } from '../../sdk/agent-client.mjs';
import { authEnv, mcpTool, mcpInitialize, onboardPlayer } from '../lib/harness-auth.mjs';
import {
  TEAM_SIZE, TEAM_HEAL, TEAM_MAX_ROUNDS,
  normalizeTeam, createTeamState, teamRoundStart, applyRoundResult,
  isValidOrder, applyOrder, teamView, teamResult,
  createTeamReplay, appendTeamRound, replayTeamMatch, renderTeamReplay,
  flattenTeamReplay, parseTeamReplay,
} from '../../src/team.js';
import { attempt, bestEffort, withFinally } from '../lib/no-throw.mjs';

export async function runKernel(ctx) {
  const { check, runCheck, throwsWith, TEAM_A, TEAM_B, freshState, playRound } = ctx;
// ---------------------------------------------------------------- part 1

console.log('\n=== Agent Fighting League · team elimination verification ===\n');

await runCheck('T1 组队注册校验：恰好 3 名、合法且不重复', async () => {
  assert.deepEqual(normalizeTeam(TEAM_A), TEAM_A);
  assert.ok(await throwsWith(() => normalizeTeam(['quartz', 'volt']), /exactly 3/));
  assert.ok(await throwsWith(() => normalizeTeam([...TEAM_A, 'ember']), /exactly 3/));
  assert.ok(await throwsWith(() => normalizeTeam(['quartz', 'quartz', 'volt']), /duplicate/));
  assert.ok(await throwsWith(() => normalizeTeam(['quartz', 'volt', 'snk-bogus']), /unknown fighter/));
  return 'size=' + TEAM_SIZE;
});

await runCheck('T2 初始状态与内核开局注入（残血/气槽直接进场）', () => {
  const ts = freshState();
  assert.equal(ts.round, 1);
  assert.equal(ts.sides.a.order.length, 3);
  const rs = teamRoundStart(ts);
  assert.deepEqual(rs.fighters, { a: 'quartz', b: 'ember' });
  assert.equal(rs.start.a.hp, CONFIG.MAX_HP);
  const match = createMatch({
    seed: 1, matchId: 'inject', fighters: { a: 'quartz', b: 'volt' },
    start: { a: { hp: 500, meter: 120 }, b: { hp: CONFIG.MAX_HP, meter: 0 } },
  });
  assert.equal(match.state.a.hp, 500);
  assert.equal(match.state.a.meter, 120);
  assert.equal(match.replay.start.a.hp, 500);
  return 'hp=' + CONFIG.MAX_HP + ' injectOk';
});

await runCheck('T3 胜者回血 15%（500→650、950→1000 封顶），气槽携带、替补冻结', () => {
  const ts = freshState();
  ts.sides.a.roster.quartz.hp = 500;
  ts.sides.a.roster.quartz.meter = 120;
  ts.sides.a.roster.volt.hp = 777;
  ts.sides.a.roster.volt.meter = 90;
  const s1 = applyRoundResult(ts, { winner: 'a', reason: 'ko' });
  assert.equal(ts.sides.a.roster.quartz.hp, 500 + TEAM_HEAL);
  assert.equal(s1.healed.amount, TEAM_HEAL);
  assert.equal(ts.sides.a.roster.quartz.meter, 120);
  assert.equal(ts.sides.a.roster.volt.hp, 777, 'benched hp frozen');
  assert.equal(ts.sides.a.roster.volt.meter, 90, 'benched meter frozen');
  assert.equal(ts.sides.b.roster.ember.alive, false);
  assert.equal(ts.sides.b.roster.ember.hp, 0);
  assert.deepEqual(ts.sides.b.fallen, ['ember']);
  assert.equal(ts.sides.b.order[0], 'tide');
  ts.sides.a.roster.quartz.hp = 950;
  const s2 = applyRoundResult(ts, { winner: 'a', reason: 'time_up' });
  assert.equal(ts.sides.a.roster.quartz.hp, CONFIG.MAX_HP);
  assert.equal(s2.healed.amount, CONFIG.MAX_HP - 950, 'heal capped at max');
  return 'heal=' + TEAM_HEAL + ' capOk';
});

await runCheck('T4 平局（双 KO / 时间到同血）双方场上角色同时淘汰', () => {
  const ts = freshState();
  const s = applyRoundResult(ts, { winner: 'draw', reason: 'ko' });
  assert.equal(s.eliminated.length, 2);
  assert.equal(s.healed, null);
  assert.equal(ts.sides.a.order[0], 'volt');
  assert.equal(ts.sides.b.order[0], 'tide');
  assert.equal(ts.over, false);
  return 'bothEliminated';
});

await runCheck('T5 淘汰终局：一方 3 人全灭判负，双方同时清空判平', () => {
  const ts = freshState();
  for (let i = 0; i < 3; i += 1) applyRoundResult(ts, { winner: 'a', reason: 'ko' });
  assert.equal(ts.over, true);
  assert.equal(ts.winner, 'a');
  assert.equal(ts.reason, 'elimination');
  assert.equal(ts.rounds.length, 3);
  const tr = teamResult(ts);
  assert.deepEqual(tr.fallen.b, TEAM_B);
  assert.equal(tr.survivors.a, 3);
  const draw = freshState();
  for (let i = 0; i < 3; i += 1) applyRoundResult(draw, { winner: 'draw', reason: 'ko' });
  assert.equal(draw.over, true);
  assert.equal(draw.winner, 'draw');
  return 'maxRounds=' + TEAM_MAX_ROUNDS;
});

await runCheck('T6 换人只允许存活池的排列：增删、重复、阵亡角色一律拒绝', () => {
  const ts = freshState();
  applyRoundResult(ts, { winner: 'a', reason: 'ko' }); // b loses ember
  assert.ok(isValidOrder(ts, 'b', ['basalt', 'tide']));
  assert.ok(applyOrder(ts, 'b', ['basalt', 'tide']));
  assert.equal(teamRoundStart(ts).fighters.b, 'basalt');
  assert.ok(!isValidOrder(ts, 'b', ['tide']));
  assert.ok(!isValidOrder(ts, 'b', ['tide', 'tide']));
  assert.ok(!isValidOrder(ts, 'b', ['tide', 'ember']));
  assert.ok(!isValidOrder(ts, 'b', ['tide', 'quartz']));
  assert.ok(!applyOrder(ts, 'b', ['tide', 'ember']));
  assert.deepEqual(ts.sides.b.order, ['basalt', 'tide'], 'rejected order leaves state untouched');
  return 'permutationOnly';
});

await runCheck('T7 离线整场组队赛：逐回合重演一致，篡改必被检出，扁平帧带回合标签', () => {
  const ts = freshState();
  const envelope = createTeamReplay(ts.matchId, ts.seed, [], { a: TEAM_A, b: TEAM_B });
  const policies = { a: BUILTIN_AGENTS[0].policy, b: BUILTIN_AGENTS[1].policy };
  let guard = 0;
  while (!ts.over && guard < TEAM_MAX_ROUNDS) { playRound(ts, envelope, policies); guard += 1; }
  assert.ok(ts.over, 'match must end by elimination');
  assert.ok(envelope.rounds.length >= 3);
  const replay = replayTeamMatch(envelope);
  assert.ok(replay.ok, JSON.stringify(replay.mismatches));
  assert.equal(replay.winner, ts.winner);
  const tampered = structuredClone(envelope);
  tampered.rounds[0].start.start.a.hp -= 1;
  assert.ok(!replayTeamMatch(tampered).ok, 'tampered start must fail verification');
  const flat = flattenTeamReplay(envelope);
  const rendered = renderTeamReplay(envelope);
  assert.equal(flat.length, rendered.reduce((n, r) => n + r.ticks.length, 0));
  assert.ok(flat.every((t) => t.round >= 1 && t.round <= envelope.rounds.length));
  return 'rounds=' + envelope.rounds.length + ' winner=' + ts.winner + ' ticks=' + flat.length;
});

await runCheck('T8 回放信封识别：team 信封可解析，单局 JSONL 不误判', () => {
  const envelope = createTeamReplay('x', 1, [], { a: TEAM_A, b: TEAM_B });
  assert.equal(parseTeamReplay(JSON.stringify(envelope)).format, 'afl-team-replay/1');
  assert.equal(parseTeamReplay('{"tick":0}\n{"tick":1}\n'), null);
  return 'envelopeOk';
});

}
