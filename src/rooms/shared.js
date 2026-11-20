/** Shared room helpers: side predicates, decision counters and labels. */
import { CONFIG, ACTIONS, MOVES } from '../rules.js';

/** Per-side decision counters. `budgetExceeded` counts ticks whose action was
 *  dropped because the agent declared more model calls than the match budget. */
/**
 * A side decides over the wire when the league cannot compute it locally:
 * built-ins are league code, and a hosted agent with a submitted strategy is
 * interpreted inside the room. Everything else receives `observe` and replies
 * with `act` — those are the only ticks that can cost a player a model call,
 * and therefore the only ticks the per-match budget applies to.
 */
export function isRemoteSide(agent) {
  if (!agent) return false;
  if (agent.source === 'builtin') return false;
  return !(agent.source === 'hosted' && agent.hostedStrategy);
}

export function newDecisionCounters() {
  const side = () => ({
    modelCalls: 0, timeouts: 0, decisions: 0, totalMs: 0, budgetExceeded: 0,
    // rules 2.2: why a tick did not produce a deliberate action.
    fallback: 0,
    rejected: { stale_tick: 0, model_budget_exceeded: 0, action_locked: 0 },
  });
  return { a: side(), b: side() };
}

const ACTION_LABEL = {
  idle: '待机', walk_f: '前走', walk_b: '后撤', jump: '跳跃', crouch: '下蹲',
  block: '防御', throw: '投技',
  lp: '轻拳', mp: '中拳', hp: '重拳', lk: '轻脚', mk: '中脚', hk: '重脚',
  dp: '升龙', fireball: '波动',
};
const THREAT_LABEL = {
  jump_in: '对手跳入', projectile: '波动迫近', poke: '对手出招', close: '贴身', neutral: '中距离',
};

export function labelOf(action) { return ACTION_LABEL[action] || MOVES[action]?.label || action; }

export function explain(side, obs, action, agent) {
  return {
    tick: obs.tick,
    side,
    agent: agent.name,
    agentId: agent.id,
    action,
    actionLabel: labelOf(action),
    threat: obs.derived.threat,
    threatLabel: THREAT_LABEL[obs.derived.threat] || obs.derived.threat,
    distanceX: obs.derived.distanceX,
    frameAdvantage: obs.derived.frameAdvantage,
    text: `${agent.name} 判断「${THREAT_LABEL[obs.derived.threat] || '中距离'}」，距离 ${obs.derived.distanceX} → ${labelOf(action)}`,
  };
}

export let roomCounter = 0;

/** Explicit Result style: return the Error instead of throwing it. */
export function competitorError(agent) {
  if (!agent) return new Error('agent is required');
  if (agent.playerId) return null;
  if (agent.source === 'builtin' || agent.id === 'demo_hosted') {
    return new Error('official baselines do not enter matchmaking: they are sparring partners and showcase fighters only');
  }
  return new Error('player login required: anonymous agents cannot enter matches');
}

export function assertCompetitor(agent) {
  const error = competitorError(agent);
  if (error) throw error;
}

export function teamRosterError(agent, mode, format) {
  if (mode === 'ranked' && format === 'team' && !agent.team) {
    return new Error('team format requires a roster: declare 3 fighters via set_team (or register_agent team=...) first');
  }
  return null;
}

export function nextRoomId() {
  roomCounter += 1;
  return roomCounter;
}
