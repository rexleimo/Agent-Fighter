/** Aggregation, rule/action merging and the human-readable findings. */
import { CONFIG } from '../config.js';
import { ATTACK_ACTIONS } from './drills.js';

// ---------------------------------------------------------------- 报告

/** Aggregate raw games into the per-opponent view the player reads. */
export function aggregate(games) {
  const byOpponent = new Map();
  for (const g of games) {
    const row = byOpponent.get(g.opponent) || {
      opponent: g.opponent, opponentId: g.opponent, opponentKind: g.opponentKind,
      name: g.opponentName, goal: g.goal || null,
      games: 0, wins: 0, losses: 0, draws: 0, hpLeft: 0, ticks: 0,
      decisions: 0, fallbackTicks: 0, meterSpent: 0, superUsed: 0,
    };
    row.games += 1;
    if (g.result === 'win') row.wins += 1; else if (g.result === 'loss') row.losses += 1; else row.draws += 1;
    row.hpLeft += g.hpA;
    row.ticks += g.ticks;
    row.decisions += g.decisionTicks;
    row.fallbackTicks += g.fallbackTicks;
    row.meterSpent += g.meterSpent;
    row.superUsed += g.superUsed;
    byOpponent.set(g.opponent, row);
  }
  return Array.from(byOpponent.values()).map((r) => ({
    ...r,
    winRate: Math.round((r.wins / (r.games || 1)) * 100),
    avgHpLeft: Math.round(r.hpLeft / (r.games || 1)),
    avgTicks: Math.round(r.ticks / (r.games || 1)),
    fallbackShare: Math.round((r.fallbackTicks / (r.ticks || 1)) * 1000) / 10,
  }));
}

/** Merge the per-game rule/action tables into strategy-level findings. */
export function mergeRules(games) {
  const map = new Map();
  for (const g of games) {
    for (const f of g.ruleFires) {
      const row = map.get(f.ruleIndex) || { ruleIndex: f.ruleIndex, action: f.action, note: f.note, fires: 0, hits: 0, whiffs: 0, punished: 0, shadowedBy: [], distanceP50: null, distanceMax: 0 };
      row.fires += f.fires;
      row.hits += f.hits || 0;
      row.whiffs += f.whiffs || 0;
      row.punished += f.punished || 0;
      if (f.distanceP50 != null) row.distanceP50 = Math.max(row.distanceP50 == null ? 0 : row.distanceP50, f.distanceP50);
      if (f.distanceMax) row.distanceMax = Math.max(row.distanceMax, f.distanceMax);
      if (f.shadowedBy && f.shadowedBy.length) row.shadowedBy = Array.from(new Set([...row.shadowedBy, ...f.shadowedBy]));
      map.set(f.ruleIndex, row);
    }
  }
  return Array.from(map.values())
    .filter((r) => r.ruleIndex >= 0)
    .map((r) => ({ ...r, hitRate: Math.round((r.hits / (r.hits + r.whiffs || 1)) * 100) }))
    .sort((a, b) => a.ruleIndex - b.ruleIndex);
}

export function mergeActions(games) {
  const map = new Map();
  for (const g of games) {
    for (const a of g.actionOutcomes) {
      const row = map.get(a.move) || { move: a.move, attempts: 0, hits: 0, blocks: 0, whiffs: 0, punished: 0, avgDistance: 0 };
      row.attempts += a.attempts;
      row.hits += a.hits;
      row.blocks += a.blocks;
      row.whiffs += a.whiffs;
      row.punished += a.punished;
      row.avgDistance = Math.max(row.avgDistance, a.avgDistance);
      map.set(a.move, row);
    }
  }
  return Array.from(map.values())
    .map((r) => ({ ...r, whiffRate: Math.round((r.whiffs / (r.attempts || 1)) * 100) }))
    .sort((a, b) => b.attempts - a.attempts);
}

/**
 * The "该怎么写" half of the training ground. Each finding is produced from
 * measured counters only, and says which rule to move and why.
 */
export function trainingAdvice({ games, rules, actions, rows, strategy, seeds, capReached }) {
  const out = [];
  const push = (code, severity, message, hint, extra) => out.push({ code, severity, message, hint, ...extra });

  const totalTicks = games.reduce((n, g) => n + g.ticks, 0);
  const fallbackTicks = games.reduce((n, g) => n + g.fallbackTicks, 0);
  const fallbackShare = totalTicks ? (fallbackTicks / totalTicks) * 100 : 0;

  // Per opponent, because "your long poke always whiffs" against a stationary
  // dummy is not the same finding as the same ratio inside a real press.
  const grouped = new Map();
  for (const g of games) {
    if (!grouped.has(g.opponent)) grouped.set(g.opponent, { opponent: g.opponent, kind: g.opponentKind, games: 0, ticks: 0, fallbackTicks: 0 });
    const b = grouped.get(g.opponent);
    b.games += 1; b.ticks += g.ticks; b.fallbackTicks += g.fallbackTicks;
  }
  const rowsByOpponent = new Map(rows.map((r) => [r.opponent, r]));

  const declared = strategy.rules.length;
  // A rule can appear in the trace with fires=0 (it was evaluated but always
  // lost the race to an earlier rule) — that is shadowed, not fired.
  const fired = new Map(rules.filter((r) => r.fires > 0).map((r) => [r.ruleIndex, r]));
  const neverFired = [];
  for (let i = 0; i < declared; i += 1) {
    if (fired.has(i)) continue;
    const r = strategy.rules[i];
    const blocked = rules.find((x) => x.ruleIndex === i && x.shadowedBy && x.shadowedBy.length);
    neverFired.push({ ruleIndex: i, action: r.action, note: r.note || null, shadowedBy: (blocked && blocked.shadowedBy) || [] });
  }
  if (neverFired.length) {
    const shadowed = neverFired.filter((n) => n.shadowedBy.length);
    const unreachable = neverFired.filter((n) => !n.shadowedBy.length);
    const list = (arr) => arr.map((n) => `rules[${n.ruleIndex}](${n.note || n.action})`).join('、');
    if (unreachable.length) {
      push('rules_never_fired', 'high',
        `${unreachable.length}/${declared} 条规则在整个训练集里一次都没触发：${list(unreachable)}。`,
        '逐条看 when 里的字段：字段名拼错、阈值超出取值域、或这个局面在你的靶单里根本没出现。规则表不是装饰品，没触发的规则等于没写。',
        { ruleIndexes: unreachable.map((n) => n.ruleIndex), rules: unreachable });
    }
    if (shadowed.length) {
      push('rules_shadowed', 'medium',
        `${shadowed.length} 条规则被更靠前的同类规则遮蔽，永远轮不到：` + shadowed.map((n) => `rules[${n.ruleIndex}] 被 ${n.shadowedBy.map((i) => 'rules[' + i + ']').join('、')} 挡住`).join('；') + '。',
        'rules 是先到先得的顺序匹配：把更具体的那条往前挪，或给被挡的那条加一个更窄的 when。',
        { ruleIndexes: shadowed.map((n) => n.ruleIndex), rules: shadowed });
    }
  }

  if (fallbackShare > 40) {
    const perOpponent = [...grouped.values()].filter((b) => b.ticks > 0 && b.fallbackTicks / b.ticks > 0.4)
      .map((b) => `${b.opponent} ${Math.round((b.fallbackTicks / b.ticks) * 100)}%`);
    push('fallback_overused', 'high',
      `${Math.round(fallbackShare)}% 的拍数没有命中任何规则，走了 defaultAction${perOpponent.length ? '（' + perOpponent.join('、') + '）' : ''}。`,
      '规则太窄或太散：给最常见的中距/近距局面补一条兜底规则，而不是继续加特例。',
      { fallbackShare: Math.round(fallbackShare), perOpponent });
  }

  const worstWhiff = actions.filter((a) => ATTACK_ACTIONS.has(a.move) && a.attempts >= 5).sort((a, b) => b.whiffRate - a.whiffRate)[0];
  if (worstWhiff && worstWhiff.whiffRate >= 40) {
    push('whiff_heavy', 'medium',
      `${worstWhiff.move} 出手 ${worstWhiff.attempts} 次，${worstWhiff.whiffRate}% 空挥，平均出招距离 ${worstWhiff.avgDistance}，被确反 ${worstWhiff.punished} 次。`,
      `把这条规则的 ${worstWhiff.move} 距离门槛收到实测命中距离以内（用观察里的 derived.inRange.${worstWhiff.move}，而不是自己估的 distanceX）。`,
      { move: worstWhiff.move });
  }

  const neverSuper = games.length >= 3 && games.every((g) => g.superUsed === 0);
  if (neverSuper) {
    const finalMeter = Math.round(games.reduce((n, g) => n + g.meterFinal, 0) / games.length);
    push('meter_unused', 'low',
      `${games.length} 局训练一次超必杀都没打出去，终局气槽平均 ${finalMeter} / ${CONFIG.MAX_METER}。`,
      `满气不收尾等于白攒：补一条 canSuper + 距离条件的高伤规则。超必杀耗 ${CONFIG.SUPER_COST} 气、EX 耗 ${CONFIG.EX_COST} 气，这是局内唯一真正“花钱”的资源。`,
      { finalMeter });
  }

  const variety = outcomeVariety(games);
  if (games.length >= 4 && !variety.diversified) {
    push('seeds_not_diversifying', 'info',
      `${games.length} 局训练只得到 ${variety.distinct} 种结果：这些靶是确定性脚本，换 seed 不会换局面。`,
      '要评估稳定性就把 chaos / random 混进靶单，它们的出招按种子变化；否则你测的是同一个局面。');
  }

  const vsDummy = rowsByOpponent.get('dummy');
  if (vsDummy && vsDummy.winRate < 100) {
    push('combo_incomplete', 'high',
      `连打不还手的木人桩胜率只有 ${vsDummy.winRate}%（${vsDummy.wins}/${vsDummy.games}）。`,
      '先别管战术：问题在连段本身。用 frameData.hitLanded + cancelInto 做命中取消，把 lp→mp→hp→special 接满。',
      { opponent: 'dummy' });
  }

  for (const r of rows) {
    if (r.opponentId === 'mirror') {
      push('mirror_is_not_a_score', 'info',
        `镜像局 ${r.wins}胜${r.losses}负${r.draws}平：同一份策略互相打，结果是确定的，胜负由先后手决定，不由强弱决定。`,
        '看镜像要看双方指标是否对称（谁先掉血、谁空挥多、谁更依赖兜底），不要看这个胜率；它也不计入强度指数。',
        { opponent: 'mirror' });
    }
    if (r.opponentKind === 'drill' && r.winRate === 0 && r.losses >= r.games) {
      push('cannot_press_drill', 'medium',
        `${r.name || r.opponent}（${r.goal || '靶'}）你 ${r.games} 局全输，一分没拿。`,
        '这个靶专门惩罚一类习惯（龟缩、乱跳、无脑挥长手）：先看这局的 actionBreakdown 和 frameEvents，确认自己是在什么距离、什么帧窗口送的。',
        { opponent: r.opponent });
    }
  }

  if (capReached) {
    push('cap_reached', 'info', `靶单/seed/rounds 组合被单次局数上限截断（${capReached} 局封顶）。`, '想跑满就分批换 seed，或把 maxGames 调高（上限 200）。');
  }
  if (games.length && games.length < 10) {
    push('small_sample', 'info', `样本只有 ${games.length} 局（seed ${seeds.length} 个）。`, '加 seed 是免费的，不要拿 3 局的胜负当结论。');
  }

  if (!out.length) {
    push('clean', 'info', '没有发现结构性问题：规则都会触发、兜底占比正常、空挥可控。', '下一步换更强的靶（压制靶 / 官方基线）或跑版本 A/B 看能不能再涨。');
  }
  return out;
}

/** How many distinct (opponent, result, ticks) triples a run produced. */
export function outcomeVariety(games) {
  const keys = new Set(games.map((g) => `${g.opponent}:${g.result}:${g.ticks}`));
  return { distinct: keys.size, games: games.length, diversified: keys.size > 1 };
}

/** 结论口径：训练指标不是榜单评分，只是同靶同 seed 下的强弱变化。 */
export function strengthIndex(rows) {
  const weights = { dummy: 1, blockwall: 1.2, whiffbait: 1.4, punisher: 1.6, pressure: 1.8, antiair: 2.0, chaos: 1.5, brawler: 2.4, zoner: 2.4, turtle: 2.2, random: 1.8 };
  let num = 0; let den = 0;
  for (const r of rows) {
    // An identical mirror is decided by first-move advantage, not strength.
    if (r.opponentId === 'mirror') continue;
    const w = weights[r.opponent] || weights[r.opponentId] || 1;
    num += (r.wins + r.draws * 0.5) / (r.games || 1) * w * (r.games || 1);
    den += w * (r.games || 1);
  }
  return den ? Math.round((num / den) * 100) / 100 : null;
}
