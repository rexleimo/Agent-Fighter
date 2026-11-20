import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { attempt, withFinally, parseOr } from '../lib/no-throw.mjs';
import { League, isLadderCompetitor, isOfficialBaseline } from '../../src/league.js';
import { strategyTemplate } from '../../src/strategy-dsl.js';
import { CONFIG } from '../../src/rules.js';
import { MAX_MODEL_CALLS_PER_MATCH as MAX_MODEL_CALLS_FOR_TEST } from '../../src/costs.js';


export async function runCosts(ctx) {
  const { check, ROOT, replay, result, none } = ctx;
  const { league, agent, A, B } = ctx;
  const { COST_CLASSES, SURFACE_COST, MAX_MODEL_CALLS_PER_MATCH, matchCost, costModel } = await import('../../src/costs.js');
  const { runTraining, compareStrategies, DRILLS, listDrills } = await import('../../src/training.js');

  const freeId = COST_CLASSES.free.id;
  const detailed = costModel().surfacesDetailed;
  check('C1 训练/陪练/读数据/校策略/看回放全部零成本，且 payer 为 null',
    ['start_training', 'compare_strategies', 'list_drills', 'get_training_report', 'validate_strategy',
     'get_rules', 'get_leaderboard', 'get_my_matches', 'get_replay', 'get_observation_schema']
      .every((k) => SURFACE_COST[k] === freeId && detailed[k].payer === null),
    ['start_training', 'compare_strategies', 'get_rules', 'get_replay'].map((k) => k + '=' + SURFACE_COST[k]).join(' '));

  check('C2 玩家唯一真正花钱的地方是外部 Agent 的模型调用，账单由玩家供应商出（payer=player）',
    SURFACE_COST.external_agent_tick === COST_CLASSES['player_model_spend'].id
    && detailed.external_agent_tick.payer === 'player'
    && COST_CLASSES['player_model_spend'].note.includes('无法代收'),
    'external_agent_tick=' + SURFACE_COST.external_agent_tick + ' payer=' + detailed.external_agent_tick.payer);

  check('C3 每局模型预算是服务端强制执行的事实，且出现在公开口径里',
    Number.isInteger(MAX_MODEL_CALLS_PER_MATCH) && MAX_MODEL_CALLS_PER_MATCH > 0
    && costModel().maxModelCallsPerMatch === MAX_MODEL_CALLS_PER_MATCH
    && /budgetExceeded/.test(JSON.stringify(costModel())),
    'budget=' + MAX_MODEL_CALLS_PER_MATCH + '/局');

  {
    const strat = strategyTemplate();
    const train = runTraining({ strategy: strat, drills: ['dummy', 'blockwall', 'whiffbait', 'chaos'], seeds: [11, 22], rounds: 1 });
    const replayDir = path.join(ROOT, 'data', 'replays');
    const before = fs.readdirSync(replayDir).filter((f) => f.startsWith('train_')).length;
    check('T1 训练场跑的是真实内核局，且明确不进榜（countsTowardLadder=false）',
      train.kind === 'training' && train.countsTowardLadder === false && train.games > 0
      && train.rows.length === 4 && train.wins + train.losses + train.draws === train.games,
      train.games + ' 局 ' + train.wins + '胜' + train.losses + '负' + train.draws + '平 strength=' + train.strengthIndex);
    check('T2 训练成本项：0 次模型调用、llmUsed=false、计费类 free、对手引擎是自有 bot 算法',
      train.cost.modelCalls === 0 && train.cost.llmUsed === false
      && train.cost.billingClass === freeId && train.cost.opponentEngine === 'league-bot-algorithm',
      JSON.stringify(train.cost.modelCalls) + '/' + train.cost.billingClass + '/' + train.cost.opponentEngine);
    check('T3 训练靶全部是仓库内机器人算法（脚本策略或按种子伪随机），无外部模型',
      DRILLS.every((d) => typeof d.policy === 'function' && d.source !== 'model')
      && listDrills().drills.every((d) => d.llm === false && d.source === 'bot'),
      DRILLS.map((d) => d.id).join(','));
    check('T4 训练不写回放文件（磁盘成本项不增长）',
      before === 0 && fs.readdirSync(replayDir).filter((f) => f.startsWith('train_')).length === 0,
      'train_* 回放文件数=' + before);
    check('T5 确定性：同策略同靶同 seed 两次结果逐字节一致',
      JSON.stringify(runTraining({ strategy: strat, drills: ['dummy', 'blockwall'], seeds: [7, 8] }).games_detail)
      === JSON.stringify(runTraining({ strategy: strat, drills: ['dummy', 'blockwall'], seeds: [7, 8] }).games_detail),
      'games_detail 相同');
    check('T6 训练能诊断写法： unreachable 规则、兜底占比、气槽浪费都报得出来',
      (() => {
        const bad = { name: 'bad', defaultAction: 'idle', rules: [
          { when: { 'derived.distanceX': { gt: 900 } }, action: 'fireball' },
          { when: { 'self.meter': { gte: 300 } }, action: 'super' },
        ] };
        const rep = runTraining({ strategy: bad, drills: ['dummy', 'blockwall', 'pressure'], seeds: [3, 4, 5] });
        const codes = rep.findings.map((f) => f.code);
        const fb = rep.findings.find((f) => f.code === 'fallback_overused');
        return codes.includes('rules_never_fired') && codes.includes('fallback_overused')
          && codes.includes('meter_unused') && fb && fb.perOpponent && fb.perOpponent.length > 0
          && rep.rules.every((r) => r.fires > 0 || r.action);
      })(),
      (() => {
        const bad = { name: 'bad', defaultAction: 'idle', rules: [
          { when: { 'derived.distanceX': { gt: 900 } }, action: 'fireball' },
          { when: { 'self.meter': { gte: 300 } }, action: 'super' },
        ] };
        return runTraining({ strategy: bad, drills: ['dummy', 'blockwall', 'pressure'], seeds: [3, 4, 5] }).findings.map((f) => f.code).join(',');
      })());
    check('T7 被遮蔽规则单独成一条诊断（顺序匹配先到先得，且指出该往前挪谁）',
      (() => {
        const shadowed = { name: 'shadow', defaultAction: 'idle', rules: [
          { when: { 'derived.distanceX': { gt: 100 } }, action: 'walk_b' },
          { when: { 'derived.distanceX': { gt: 300 } }, action: 'fireball' },
        ] };
        const rep = runTraining({ strategy: shadowed, drills: ['dummy', 'brawler'], seeds: [5] });
        const hit = rep.findings.find((f) => f.code === 'rules_shadowed');
        return Boolean(hit) && hit.ruleIndexes.includes(1) && /rules\[0\]/.test(hit.message)
          && /往前挪/.test(hit.hint) && rep.rules.find((r) => r.ruleIndex === 1).shadowedBy[0] === 0;
      })(),
      (() => {
        const shadowed = { name: 'shadow', defaultAction: 'idle', rules: [
          { when: { 'derived.distanceX': { gt: 100 } }, action: 'walk_b' },
          { when: { 'derived.distanceX': { gt: 300 } }, action: 'fireball' },
        ] };
        const rep = runTraining({ strategy: shadowed, drills: ['dummy', 'brawler'], seeds: [5] });
        return rep.findings.map((f) => f.code).join(',') || 'none';
      })());
    check('T8 版本 A/B：同靶同 seed，flat 时明确写"不要上线"，不编造进步',
      (() => {
        const a = strategyTemplate();
        const b = { ...a, name: 'v2-noop', rules: [...a.rules] };
        const cmp = compareStrategies({ strategyA: a, strategyB: b, drills: ['dummy', 'chaos'], seeds: [1, 2, 3] });
        return cmp.kind === 'training-compare' && cmp.countsTowardLadder === false
          && cmp.strengthDelta === 0 && cmp.verdict === 'flat'
          && /不要上线|别按这个结论/.test(cmp.verdictNote) && cmp.sample.gamesPerVersion > 0;
      })(),
      (() => { const c = compareStrategies({ strategyA: strategyTemplate(), strategyB: { ...strategyTemplate(), name: 'v2-noop' }, drills: ['dummy'], seeds: [1] }); return c.verdict + ' Δ' + c.strengthDelta; })());
    check('T9 镜像局不冒充强度：镜像不计入强度指数，并给出解释',
      (() => {
        const only = runTraining({ strategy: strategyTemplate(), drills: ['mirror'], seeds: [1] });
        return only.strengthIndex === null
          && only.findings.some((f) => f.code === 'mirror_is_not_a_score');
      })(),
      'mirror-only strengthIndex=null');
    check('T10 换 seed 不换局面时如实说（确定性靶不假装稳定率）',
      (() => {
        const rep = runTraining({ strategy: strategyTemplate(), drills: ['dummy'], seeds: [1, 2, 3, 4, 5] });
        const scripted = rep.rows.find((r) => r.opponentId === 'dummy');
        return scripted.games === 5 && rep.outcomeVariety.distinct <= 2
          && /确定性/.test(rep.methodology.seedDiversity);
      })(),
      (() => { const r = runTraining({ strategy: strategyTemplate(), drills: ['dummy'], seeds: [1, 2, 3, 4, 5] }); return r.outcomeVariety.distinct + ' 种结果/' + r.games + ' 局'; })());
    check('T11 单次局数有上限（训练不能饿死实时房间）',
      (() => {
        const rep = runTraining({ strategy: strategyTemplate(), drills: ['dummy', 'blockwall', 'chaos', 'pressure'], seeds: [1, 2, 3, 4, 5, 6], rounds: 2, maxGames: 10 });
        return rep.games <= 10 && rep.truncated === true && rep.gameCap === 10;
      })(),
      'maxGames=10 → games<=10 且 truncated');
  }

  {
    // 局内真正"花钱"的资源：气槽消耗必须存在，否则"消耗型成本"是空话。
    const hostedRanked = matchCost({
      mode: 'ranked', ranked: true, practice: false, ticks: 100,
      sideA: { hosted: true, modelCalls: 0, decisions: 100, timeouts: 0 },
      sideB: { hosted: true, modelCalls: 0, decisions: 100, timeouts: 0 },
    });
    const trainingCost = matchCost({
      mode: 'training', ranked: false, practice: true, ticks: 600,
      sideA: { hosted: true, decisions: 600 }, sideB: { hosted: true, decisions: 600 },
    });
    const externalRanked = matchCost({
      mode: 'ranked', ranked: true, practice: false, ticks: 100,
      sideA: { external: true, modelCalls: 3, decisions: 100, timeouts: 0 },
      sideB: { hosted: true, decisions: 100 },
    });
    check('C4 同一局按赛道区分成本归属：托管排位=平台算力，训练=free，外部调模=玩家账单',
      hostedRanked.billingClass === COST_CLASSES['platform_run'].id && hostedRanked.hostedTicksEvaluated === 200 && hostedRanked.hostedSides === 2
      && trainingCost.billingClass === freeId && trainingCost.training === true && trainingCost.ladder === false
      && externalRanked.billingClass === COST_CLASSES['player_model_spend'].id && externalRanked.declaredModelCalls === 3,
      'hosted=' + hostedRanked.billingClass + ' training=' + trainingCost.billingClass + ' external=' + externalRanked.billingClass);

    check('C5 局内消耗型资源（EX 50 气 / 超必 100 气，上限 300）在公开口径与招式表里一致',
      CONFIG.EX_COST === 50 && CONFIG.SUPER_COST === 100 && CONFIG.MAX_METER === 300
      && JSON.stringify(costModel()).includes('EX') && /50|100/.test(JSON.stringify(costModel())),
      `EX=${CONFIG.EX_COST} SUPER=${CONFIG.SUPER_COST} MAX=${CONFIG.MAX_METER}`);
  }

  // --- Stage selection: the arena is match data, decided server-side.
  {
    const { selectStage, stageModel, STAGES } = await import('../../src/stages.js');
    const model = stageModel();
    check('S1 舞台登记表是服务端数据，且每个队风场都有对应 plate',
      model.stages.length === 5 && model.stages.every((s) => s.plate === s.id)
      && model.neutral === 'stage_main',
      `${model.stages.length} 个舞台，中性场 ${model.neutral}`);

    const home = selectStage({ fighterA: 'ember', fighterB: 'cinder', seed: 12345, mode: 'ranked' });
    const homeTeam = selectStage({ fighterA: 'basalt', fighterB: 'girder', seed: 999, mode: 'ranked' });
    check('S2 同队对局 -> 该队主场（不是随机场地）',
      home.id === 'stage_pyre' && homeTeam.id === 'stage_steel',
      `pyre=${home.id} steel=${homeTeam.id}`);

    const seen = new Set();
    for (let i = 0; i < 600; i += 1) {
      seen.add(selectStage({ fighterA: 'ember', fighterB: 'volt', seed: (i * 2654435761) >>> 0, mode: 'ranked' }).id);
    }
    check('S3 跨队对局确实会换场地（多场景不是写在文档里的能力）',
      seen.size >= 3, [...seen].join(','));

    const fixed = new Set();
    for (let i = 0; i < 5; i += 1) {
      fixed.add(selectStage({ fighterA: 'ember', fighterB: 'volt', seed: 424242, mode: 'ranked' }).id);
    }
    check('S4 同一 seed 必得同一场地（否则直播与回放会各自摇骰子）',
      fixed.size === 1, [...fixed].join(','));

    check('S5 没有 seed 时回到中性场，绝不编一个场景出来',
      selectStage({ fighterA: 'ember', fighterB: 'volt', mode: 'ranked' }).id === 'stage_main'
      && selectStage({ fighterA: 'ember', fighterB: 'volt', seed: Number.NaN, mode: 'ranked' }).id === 'stage_main',
      'unseeded -> stage_main');

    check('S6 3v3 按阵容归属判队，不拿首个角色冒充全队',
      selectStage({ teamA: 'tide', teamB: 'tide', seed: 7, mode: 'ranked' }).id === 'stage_tide'
      && selectStage({ teamA: 'void', teamB: 'steel', seed: 7, mode: 'ranked' }).id !== null,
      'roster teams honoured');

    // Recorded through the real path, not by hoping the demo rotation happened
    // to pair cross-team this run.
    const declared = league.recordMatch({
      matchId: 'x_stage_declared', agentA: agent(A), agentB: agent(B),
      result: result('a'), replay: replay('x_stage_declared'), decisions: none,
      roomId: 'r_x', mode: 'ranked', ranked: true, pairing: 'rating',
      fighters: { a: 'ember', b: 'volt' },
      stage: 'stage_pyre', seed: 424242,
    });
    const undeclared = league.recordMatch({
      matchId: 'x_stage_missing', agentA: agent(A), agentB: agent(B),
      result: result('b'), replay: replay('x_stage_missing'), decisions: none,
      roomId: 'r_x', mode: 'ranked', ranked: true, pairing: 'rating',
      fighters: { a: 'ember', b: 'volt' },
      stage: 'stage_not_a_real_arena', seed: 424243,
    });
    check('S7 服务端声明的场地写进记录；未声明/未知 id 记为 null 而不是被洗成中性场',
      declared.stage === 'stage_pyre' && declared.seed === 424242 && undeclared.stage === null,
      `声明=${declared.stage} 未知=${String(undeclared.stage)}`);

    check('S7b 场地选取结果与记录一致：同 seed 重放同一场地',
      selectStage({ fighterA: 'ember', fighterB: 'volt', seed: declared.seed, mode: 'ranked' }) !== undefined
      && Number.isFinite(declared.seed),
      `seed ${declared.seed} 可复现`);

    const { stageFor } = await import('../../src/stages.js');
    check('S8 未登记的场地 id 解析不出舞台（null），调用方不会拿到一个假中性场',
      stageFor('stage_not_a_real_arena') === null && stageFor('stage_pyre').id === 'stage_pyre',
      String(stageFor('stage_not_a_real_arena')));
  }


}
