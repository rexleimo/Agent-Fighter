/** Training run orchestration and same-seed A/B comparison. */
import { validateStrategy, strategyHash } from '../strategy-dsl.js';
import { COST_CLASSES } from '../costs.js';
import { resolveOpponents, MAX_TRAINING_GAMES, PUNISH_WINDOW_TICKS } from './drills.js';
import { playOne } from './play.js';
import { aggregate, mergeRules, mergeActions, outcomeVariety, strengthIndex, trainingAdvice } from './report.js';

/**
 * Run the training ground.
 *
 * @param {object} input.strategy   the player's hosted DSL strategy (validated)
 * @param {string[]} [input.drills] drill / baseline ids, `mirror` to fight yourself
 * @param {number[]} [input.seeds]  seed set; default 5 seeds per opponent
 * @param {number} [input.rounds]   rounds per opponent per seed (default 1)
 * @param {string} [input.fighterA] fighter for the player's side (default their own)
 */
export function runTraining(input = {}) {
  const strategy = validateStrategy(input.strategy);
  const opponents = resolveOpponents(input.drills);
  const seeds = (Array.isArray(input.seeds) && input.seeds.length ? input.seeds : [101, 202, 303, 404, 505]).slice(0, 20).map((n) => Number(n) || 1);
  const rounds = Math.max(1, Math.min(Number(input.rounds) || 1, 5));
  const cap = Math.max(1, Math.min(Number(input.maxGames) || MAX_TRAINING_GAMES, MAX_TRAINING_GAMES));
  let truncated = false;
  const fighterA = input.fighterA || strategy.fighterId || 'quartz';
  const games = [];
  outer: for (const opponent of opponents) {
    for (const seed of seeds) {
      for (let r = 0; r < rounds; r += 1) {
        if (games.length >= cap) { truncated = true; break outer; }
        games.push(playOne(strategy, opponent, { seed, fighterA, fighterB: input.fighterB || 'quartz', matchId: `train_${opponent.id}_${seed}_${r}` }));
      }
    }
  }
  const rows = aggregate(games);
  const rules = mergeRules(games);
  const actions = mergeActions(games);
  const report = {
    kind: 'training',
    countsTowardLadder: false,
    versionHash: strategyHash(input.strategy).slice(0, 12),
    strategyName: strategy.name,
    fighterId: fighterA,
    drills: opponents.map((o) => o.id),
    seeds,
    games: games.length,
    gameCap: cap,
    truncated,
    outcomeVariety: outcomeVariety(games),
    strengthIndexNote: '镜像局不计入强度指数：同一份策略互相打结果由先后手决定，不反映强弱',
    wins: rows.reduce((n, r) => n + r.wins, 0),
    losses: rows.reduce((n, r) => n + r.losses, 0),
    draws: rows.reduce((n, r) => n + r.draws, 0),
    strengthIndex: strengthIndex(rows),
    rows,
    rules,
    actions,
    cost: {
      billingClass: COST_CLASSES.free.id,
      llmUsed: false,
      modelCalls: 0,
      opponentEngine: 'league-bot-algorithm',
      note: '练习对手由联赛自己的机器人算法逐拍实时计算，不走 LLM：零成本。',
    },
    methodology: {
      punishWindowTicks: PUNISH_WINDOW_TICKS,
      seedDiversity: '对确定性靶（脚本策略）换 seed 不会换结果：只有 chaos / random 这类按种子出招的靶才会产生分布。想看方差就混进混沌靶。',
      whiff: '一次出手在该拍之后的事件流里没有 hit/block 记录即计为空挥',
      shadowedRule: '同一拍上有两条以上规则成立时，decide 只取最前的一条，其余记为被遮蔽',
      strengthIndex: '按靶位难度加权的结果率（0-1），只是训练指标，不是榜单评分',
      determinism: '同 strategy + 同 drills + 同 seeds 的结果逐拍一致（确定性内核）',
    },
    games_detail: games.map((g) => ({ opponent: g.opponent, seed: g.seed, result: g.result, reason: g.reason, hpA: g.hpA, hpB: g.hpB, ticks: g.ticks, decisions: g.decisionTicks, fallbackTicks: g.fallbackTicks, meterSpent: g.meterSpent, superUsed: g.superUsed })),
  };
  report.findings = trainingAdvice({ games, rules, actions, rows, strategy, seeds, capReached: truncated ? cap : 0 });
  return report;
}

/**
 * Same drills, same seeds, two strategy versions. This is the only honest way
 * to answer "did my change make it stronger" - everything else in the report is
 * descriptive, this is comparative, and the seed set is held fixed on purpose.
 */
export function compareStrategies({ strategyA, strategyB, drills, seeds, rounds, fighterA } = {}) {
  const a = runTraining({ strategy: strategyA, drills, seeds, rounds, fighterA });
  const b = runTraining({ strategy: strategyB, drills, seeds, rounds, fighterA });
  const perOpponent = a.rows.map((rowA) => {
    const rowB = b.rows.find((r) => r.opponent === rowA.opponent);
    return {
      opponent: rowA.opponent,
      name: rowA.name,
      aWinRate: rowA.winRate,
      bWinRate: rowB ? rowB.winRate : 0,
      delta: (rowB ? rowB.winRate : 0) - rowA.winRate,
      aAvgHpLeft: rowA.avgHpLeft,
      bAvgHpLeft: rowB ? rowB.avgHpLeft : 0,
      games: rowA.games,
    };
  });
  // Only mirror rows can differ without a strategy change (an identical mirror
  // is deterministic); report which seeds actually changed so nobody reads noise
  // as signal.
  const changedSeeds = [];
  for (const ga of a.games_detail) {
    const gb = b.games_detail.find((x) => x.opponent === ga.opponent && x.seed === ga.seed);
    if (gb && ga.result !== gb.result) changedSeeds.push(`${ga.opponent}#${ga.seed}: ${ga.result}→${gb.result}`);
  }
  const mirrorOnly = a.rows.every((r) => r.opponentId === 'mirror');
  const aIndex = mirrorOnly ? null : a.strengthIndex;
  const bIndex = mirrorOnly ? null : b.strengthIndex;
  const deltaStrength = (aIndex === null || bIndex === null) ? null : Math.round((bIndex - aIndex) * 100) / 100;
  const verdict = deltaStrength === null ? 'inconclusive' : deltaStrength > 0.02 ? 'stronger' : deltaStrength < -0.02 ? 'weaker' : 'flat';
  return {
    kind: 'training-compare',
    countsTowardLadder: false,
    seeds: a.seeds,
    drills: a.drills,
    games: a.games + b.games,
    versionA: { hash: a.versionHash, wins: a.wins, strengthIndex: aIndex, findings: a.findings.map((f) => f.code) },
    versionB: { hash: b.versionHash, wins: b.wins, strengthIndex: bIndex, findings: b.findings.map((f) => f.code) },
    perOpponent,
    strengthDelta: deltaStrength,
    verdict,
    sample: { gamesPerVersion: a.games, opponents: a.drills.length, seeds: a.seeds.length },
    // New seeds that produce a different result is the honest overfitting metric:
    // a change that only wins on the seeds you tuned against is not an improvement.
    changedSeeds,
    findingSeeds: a.findings.map((f) => f.code).filter((code) => !b.findings.some((x) => x.code === code)),
    introducedSeeds: b.findings.map((f) => f.code).filter((code) => !a.findings.some((x) => x.code === code)),
    verdictNote: verdict === 'inconclusive'
      ? '本次只打了镜像靶：镜像不提供强弱结论。换真实靶（至少 dummy + 一个会还手的）再比。'
      : verdict === 'stronger'
      ? '新版本在同一批靶、同一批 seed 下结果率更高：这是一次可复现的进步，不是运气。'
      : verdict === 'weaker'
        ? '新版本在同批靶与同批 seed 下变差了：回滚或只保留其中涨的那部分规则。'
        : '两个版本没有可分辨的差距（阈值 0.02）：加大 seed 数再判，别按这个结论改代码。',
    caveat: `样本 ${a.games} 局/版本 × ${a.drills.length} 个靶 × ${a.seeds.length} 个 seed；seed 集固定，所以差值只反映策略改动本身。训练指标不进榜、不等于对手池的真实强度；判定 flat 就不要上线。`,
    cost: a.cost,
  };
}
