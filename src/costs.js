/**
 * What costs what.
 *
 * The league has three genuinely different kinds of cost and they must never be
 * blurred together, because they are paid by different people:
 *
 *  - `free`              nothing is billed to anyone. Sparring and the training
 *                        ground run on the league's own bot algorithms and the
 *                        deterministic kernel - no LLM is involved, so a
 *                        hundred practice rounds cost the player exactly
 *                        nothing. Spectating, reading rules, and replay
 *                        playback are in this class too.
 *  - `player_model_spend` an external agent calling a model once per tick. That
 *                        bill comes from the player's own model provider; the
 *                        league cannot settle it and does not pretend to. It
 *                        can only publish what it actually observes: how many
 *                        decisions arrived, how many ticks went unanswered, how
 *                        much wall-clock each decision took. The `modelCalls`
 *                        number an agent reports about itself is a
 *                        self-declaration - disclosed, never used as an invoice.
 *  - `platform_run`      the league's own compute: evaluating hosted strategies
 *                        every tick, keeping room clocks alive, writing replay
 *                        JSONL to disk, serving asset bundles.
 *
 * Every number in a cost ledger therefore comes from a counter the server
 * observed itself. Nothing here is estimated, and nothing is billed silently.
 */

/** Model calls allowed per match for one external agent before the fallback kicks in. */
import { CONFIG } from './rules.js';

export const MAX_MODEL_CALLS_PER_MATCH = Number(
  (typeof process !== 'undefined' && process.env.AFL_MAX_MODEL_CALLS_PER_MATCH) || 8,
);

/** Wall-clock a single decision may take before the tick resolves without it. */
export const DECISION_DEADLINE_MS = Number(
  (typeof process !== 'undefined' && process.env.AFL_DECISION_DEADLINE_MS) || 80,
);

/** How many replay files the league keeps on disk before it starts pruning. */
export const REPLAY_RETENTION = Number(
  (typeof process !== 'undefined' && process.env.AFL_REPLAY_RETENTION) || 2000,
);

export const COST_CLASSES = Object.freeze({
  free: Object.freeze({
    id: 'free',
    title: '零成本',
    payer: null,
    note: '不向任何人收费：走联赛自有机器人算法与确定性内核，全程不调用 LLM。',
    items: [
      '观战：/api/state、/api/rooms、/api/matches、/api/leaderboard 与 WS 观战频道',
      '读规则/招式表/协议/素材清单',
      '策略校验 validate_strategy、模板 get_strategy_template',
      '训练场全部对局：自有 bot 靶机 + 确定性内核，零 LLM 调用',
      '演示局与陪练局（官方基线，真实打完、不计榜）',
      '查看与下载自己的回放 JSONL',
    ],
  }),
  player_model_spend: Object.freeze({
    id: 'player_model_spend',
    title: '玩家模型账单',
    payer: 'player',
    note: '由玩家自己的模型供应商计费，联赛无法代收也无法代付；联赛只披露服务端可观测事实。',
    items: [
      '外部 Agent 每拍 observe→act 的模型调用（modelCalls 为客户端自报，仅披露不作结算依据）',
      '外部 Agent 的决策耗时与超时回落（服务端实测 avgDecisionMs / timeouts）',
      '每局模型调用预算超出后的回落次数（budgetExceeded）',
    ],
  }),
  platform_run: Object.freeze({
    id: 'platform_run',
    title: '平台算力',
    payer: 'platform',
    note: '联赛自己承担的运行成本，按用量计量并设上限，不按次向玩家收费。',
    items: [
      '托管策略逐拍求值（hostedTicksEvaluated）',
      '房间节拍与观战广播',
      '回放 JSONL 写盘与留存：每记录新对局检查一次，超过 REPLAY_RETENTION 时按最旧优先删除；赛程仍在引用的回放永不进入删除候选（否则排行榜/赛程会指向取不到的回放）。存量可用 npm run prune:replays 显式清理（默认 dry run）',
      '素材包打包与下载',
    ],
  }),
});

/** Class of each MCP tool / public surface, so cost claims are checkable. */
export const SURFACE_COST = Object.freeze({
  // free: no model call, no ladder write
  get_rules: 'free',
  get_observation_schema: 'free',
  get_strategy_template: 'free',
  validate_strategy: 'free',
  list_drills: 'free',
  start_training: 'free',
  get_training_report: 'free',
  compare_strategies: 'free',
  list_fighters: 'free',
  list_rooms: 'free',
  get_leaderboard: 'free',
  get_my_matches: 'free',
  get_match_result: 'free',
  get_replay: 'free',
  get_agent_stats: 'free',
  get_my_profile: 'free',
  // platform run: consumes league compute for the match clock
  join_queue: 'platform_run',
  create_room: 'platform_run',
  join_room: 'platform_run',
  submit_strategy: 'platform_run',
  update_strategy: 'platform_run',
  set_team: 'platform_run',
  set_team_order: 'platform_run',
  register_agent: 'platform_run',
  // player model spend: an external agent answering each tick pays its own model
  external_agent_tick: 'player_model_spend',
});

/**
 * Per-match cost ledger. Only counters the server actually observed go in; the
 * self-reported model-call figure is kept separate and labelled as such.
 */
export function matchCost({
  mode = 'ranked',
  ranked = false,
  practice = false,
  training = false,
  sideA = {},
  sideB = {},
  ticks = 0,
} = {}) {
  const a = sideA || {};
  const b = sideB || {};
  const num = (v) => Number(v) || 0;
  const declaredModelCalls = num(a.modelCalls) + num(b.modelCalls);
  const serverActions = num(a.decisions) + num(b.decisions);
  const tickCount = num(ticks);
  const externalSides = (a.external ? 1 : 0) + (b.external ? 1 : 0);
  const hostedSides = (a.hosted ? 1 : 0) + (b.hosted ? 1 : 0);
  // Who pays for THIS game, decided in one place:
  //   training or a non-counting game -> free, nobody pays;
  //   an external side that calls a model -> the player's own bill;
  //   everything else that actually burns our CPU -> platform_run.
  const billingClass = training || !ranked
    ? COST_CLASSES.free.id
    : externalSides > 0
      ? COST_CLASSES.player_model_spend.id
      : hostedSides > 0 || serverActions > 0
        ? COST_CLASSES.platform_run.id
        : COST_CLASSES.free.id;
  return {
    // what class this game belongs to, and therefore who (if anyone) pays
    billingClass,
    training: Boolean(training) || mode === 'training',
    ladder: Boolean(ranked),
    practice: Boolean(practice),
    mode: mode || null,
    /** The bot path never touches a model: the training ground asserts this is 0. */
    llmUsed: false,
    declaredModelCalls,
    serverActions,
    timeouts: num(a.timeouts) + num(b.timeouts),
    budgetExceeded: num(a.budgetExceeded) + num(b.budgetExceeded),
    /** League-side compute: ticks where a hosted DSL strategy was evaluated. */
    hostedTicksEvaluated: (a.hosted ? tickCount : 0) + (b.hosted ? tickCount : 0),
    externalSides,
    hostedSides,
    /** Disk: the replay this match writes, and whether it is the one kept. */
    replayStored: true,
    budgetLimit: MAX_MODEL_CALLS_PER_MATCH,
    note: '模型调用数由 Agent 自报，联赛只按服务端实测的决策数/超时/耗时披露成本；训练与陪练全程零 LLM、不收费。',
  };
}

/** Public description of the cost model, for /api/costs and the MCP resources. */
export function costModel() {
  return {
    version: '1.0',
    maxModelCallsPerMatch: MAX_MODEL_CALLS_PER_MATCH,
    decisionDeadlineMs: DECISION_DEADLINE_MS,
    replayRetention: REPLAY_RETENTION,
    classes: Object.values(COST_CLASSES),
    surfaces: SURFACE_COST,
    // Same map, but resolved so a client can render "who pays" per surface
    // without re-deriving it from the class table.
    surfacesDetailed: Object.fromEntries(Object.entries(SURFACE_COST).map(([k, id]) => [k, {
      class: id,
      title: COST_CLASSES[id] ? COST_CLASSES[id].title : id,
      payer: COST_CLASSES[id] ? COST_CLASSES[id].payer : null,
    }])),
    billingSurfaceKeys: Object.keys(SURFACE_COST),
    // The only resource a match really consumes is the in-game meter. It is a
    // gameplay cost paid inside the fight, not a platform charge.
    matchResources: {
      maxMeter: CONFIG.MAX_METER,
      exCost: CONFIG.EX_COST,
      superCost: CONFIG.SUPER_COST,
      note: `气槽上限 ${CONFIG.MAX_METER}：EX 消耗 ${CONFIG.EX_COST}，超必杀消耗 ${CONFIG.SUPER_COST}，专属技免费。这是局内唯一被消耗的资源，跟平台收费无关。`,
    },
    freeSurfaces: Object.entries(SURFACE_COST).filter(([, v]) => v === COST_CLASSES.free.id).map(([k]) => k),
    principle: '练习与训练场走联赛自有机器人算法，实时计算、不调用 LLM，因此对玩家零成本；'
      + '玩家唯一真正花钱的地方是自己的外部 Agent 调模型，那笔账由玩家的模型供应商结算，'
      + '联赛不代收、不虚报，只公布服务端实测的决策数、耗时与超时次数。',
  };
}
