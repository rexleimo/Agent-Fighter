/** Drill roster and opponent resolution: the league's own zero-LLM bots. */
import { ACTIONS, isAttack } from '../rules.js';
import { getBuiltinAgent, BUILTIN_AGENTS } from '../agents.js';
import { COST_CLASSES } from '../costs.js';

// What counts as an ATTACK for the whiff report is the move table's own
// classification, not a hand-written exclusion list: the day the table gained a
// defensive family, `dodge` would otherwise have been reported as a whiffed
// strike (and `block` / `crouch` were only ever excluded by name).
export const ATTACK_ACTIONS = new Set(ACTIONS.filter(isAttack));
/** How many ticks after a whiff still counts as "the opponent countered this mistake". */
export const PUNISH_WINDOW_TICKS = 8;
export const METER_MOVES = new Set(['special', 'ex', 'super']);
/**
 * A training run is synchronous and shares the event loop with the live room
 * clocks, so it is bounded: roughly a second of kernel work per call. Raise it
 * with maxGames up to the hard ceiling, or split into several runs.
 */
export const MAX_TRAINING_GAMES = Number((typeof process !== 'undefined' && process.env.AFL_MAX_TRAINING_GAMES) || 60);

// ---------------------------------------------------------------- bot 靶机库

function dummy() {
  // 木人桩：不还手、不走位，只站着挨打。用来把连段打完、把取消阶梯练熟。
  return 'idle';
}

function blockwall(o) {
  // 铁壁靶：永远防御，被压制也不反击，只有倒地起身后走一步。用来练破防、投技、压起身。
  if (o.self.hitstun > 0 || o.self.blockstun > 0) return 'block';
  if (o.self.actionable && o.self.wakeup) return 'walk_b';
  return 'block';
}

function pressure(o) {
  // 压制靶：一路压上来出招，但节奏固定、不看距离，会留下确定的空挥破绽。用来练防守与确反。
  const s = o.self;
  const d = o.derived;
  if (s.hitstun > 0 || s.blockstun > 0) return 'block';
  if (d.distanceX > 150) return 'walk_f';
  const cycle = o.tick % 4;
  if (cycle === 0) return 'lp';
  if (cycle === 1) return 'mp';
  if (cycle === 2) return 'lk';
  return 'hp';
}

function whiffbait(o) {
  // 破绽诱敌：故意在你面前空挥长收招招式。你不进场确反，就抓不到教学点。
  const d = o.derived;
  if (o.self.hitstun > 0 || o.self.blockstun > 0) return 'block';
  if (d.distanceX > 210) return 'walk_f';
  if (d.distanceX < 96) return 'walk_b';
  return o.tick % 6 === 0 ? 'hk' : 'idle';
}

function antiair(o) {
  // 对空靶：专 punish 跳入。想练 jump-in 压制，先过这一关。
  const d = o.derived;
  if (o.self.hitstun > 0 || o.self.blockstun > 0) return 'block';
  if (d.threat === 'jump_in' && d.inRange.dp) return 'dp';
  if (d.distanceX > 170) return 'walk_f';
  if (d.inRange.mp) return 'mp';
  return 'block';
}

function punisher(o) {
  // 确反靶：只在你收招硬直里打你，其余时间站桩。用来暴露"空挥习惯"。
  const d = o.derived;
  if (o.self.hitstun > 0 || o.self.blockstun > 0) return 'block';
  if (d.frameAdvantage < 0 && d.inRange.hp) return 'hp';
  if (d.opponentAttacking) return 'block';
  return 'idle';
}

function chaos(o) {
  // 混沌靶：按种子伪随机出招，练不稳定局面下的兜底规则。
  const pool = ['walk_f', 'walk_b', 'block', 'lp', 'mp', 'hp', 'lk', 'mk', 'hk', 'fireball', 'dp', 'jump', 'throw', 'crouch', 'dash', 'special', 'ex', 'super'];
  const h = (Math.imul(o.seed >>> 0, 2654435761) ^ Math.imul(o.tick + 1, 40503) ^ 0x9e3779b9) >>> 0;
  return pool[h % pool.length];
}

/**
 * The drill roster. Each entry says what it is for, so a player who does not
 * know what to practise yet can pick by goal instead of guessing.
 */
export const DRILLS = Object.freeze([
  { id: 'dummy', name: '木人桩', goal: '把连段打完：命中取消 → 下一段 → 专属技/超必收尾', skill: 'offense', policy: dummy, defaultAction: 'idle' },
  { id: 'blockwall', name: '铁壁靶', goal: '破防：投技拆防、压起身、气槽管理', skill: 'offense', policy: blockwall, defaultAction: 'block' },
  { id: 'whiffbait', name: '破绽诱敌', goal: '确反：对手空挥后的长收招帧就是你的进攻窗口', skill: 'punish', policy: whiffbait, defaultAction: 'idle' },
  { id: 'pressure', name: '压制靶', goal: '防守与格挡：固定节奏压进来，练挡与拆', skill: 'defense', policy: pressure, defaultAction: 'block' },
  { id: 'antiair', name: '对空靶', goal: '跳入风险：升龙 punish，练距离控制而不是无脑跳', skill: 'defense', policy: antiair, defaultAction: 'block' },
  { id: 'punisher', name: '确反靶', goal: '戒掉空挥：只在你收招硬直里打你', skill: 'discipline', policy: punisher, defaultAction: 'idle' },
  { id: 'chaos', name: '混沌靶', goal: '兜底规则：随机局面下你的 defaultAction 撑不撑得住', skill: 'robustness', policy: chaos, defaultAction: 'block' },
]);

export function listDrills() {
  return {
    drills: DRILLS.map((d) => ({ id: d.id, name: d.name, goal: d.goal, skill: d.skill, source: 'bot', llm: false })),
    mirror: { id: 'mirror', name: '镜像你自己', goal: '照镜子：同策略镜像由先后手决定，不计入强度指数', source: 'self', llm: false },
    baselines: BUILTIN_AGENTS.map((a) => ({ id: a.id, name: a.name, goal: a.description, skill: 'baseline', source: 'builtin', llm: false })),
    note: '训练对手全部是联赛自己的机器人算法（脚本策略 + 伪随机 bot），实时逐拍计算，不调用 LLM：练习零成本。',
    freeClass: COST_CLASSES.free.title,
    ladderImpact: 'none',
  };
}

export function resolveOpponents(ids) {
  const list = (ids && ids.length ? ids : ['dummy', 'blockwall', 'chaos']).slice(0, 8);
  const out = [];
  for (const id of list) {
    const drill = DRILLS.find((d) => d.id === id);
    if (drill) { out.push({ id: drill.id, name: drill.name, goal: drill.goal, policy: drill.policy, defaultAction: drill.defaultAction, kind: 'drill' }); continue; }
    const builtin = getBuiltinAgent(id);
    if (builtin) { out.push({ id: builtin.id, name: builtin.name, policy: builtin.policy, defaultAction: builtin.defaultAction || 'block', kind: 'baseline' }); continue; }
    if (id === 'mirror') { out.push({ id: 'mirror', name: '镜像你自己', goal: '照镜子：同策略镜像由先后手决定，不计入强度指数', policy: null, defaultAction: 'block', kind: 'mirror' }); }
  }
  if (!out.length) throw new Error('no such drill: ' + list.join(', '));
  return out;
}
