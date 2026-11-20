/** Room tick loop: observe, act, resolve, broadcast and finish. */
import { CONFIG, ACTIONS } from '../rules.js';
import { getBuiltinAgent } from '../agents.js';
import { decide } from '../strategy-dsl.js';
import { MAX_MODEL_CALLS_PER_MATCH } from '../costs.js';
import { safePolicy, renderReplay } from '../engine.js';
import { teamView } from '../team.js';
import { explain, isRemoteSide } from './shared.js';
import { RoomCore } from './room-core.js';

export class Room extends RoomCore {
  scheduleTick() {
    const c = this.current;
    if (!c || c.finished) return;
    c.timer = setTimeout(() => this.openTick(), Math.max(0, c.nextTickAt - Date.now()));
  }

  openTick() {
    const c = this.current;
    if (!c || c.finished || c.match.over) return;
    const tick = c.match.tick;
    const extra = c.team ? { team: teamView(c.team), intermission: false } : null;
    const obs = c.match.observations(CONFIG.TICK_MS, extra);
    c.obs = { a: obs.a, b: obs.b, openedAt: Date.now(), tick };
    c.pending = { a: null, b: null };
    for (const side of ['a', 'b']) {
      const agent = c[side];
      if (agent.source === 'builtin') {
        const builtin = getBuiltinAgent(agent.id);
        c.pending[side] = safePolicy(builtin ? builtin.policy : () => 'block', obs[side], agent.defaultAction);
      } else if (agent.source === 'hosted' && agent.hostedStrategy) {
        // Interpreted locally: zero network round-trip, never times out.
        c.pending[side] = safePolicy((o) => decide(agent.hostedStrategy, o).action, obs[side], agent.defaultAction);
      } else {
        // Anything the league cannot compute locally (external, or hosted with no
        // strategy submitted yet) decides over the wire.
        const conn = this.agentConns.get(agent.id);
        if (conn) conn.send({ type: 'observe', matchId: c.matchId, tick, deadlineMs: CONFIG.TICK_MS, observation: obs[side] });
        else c.pending[side] = agent.defaultAction || CONFIG.DEFAULT_ACTION;
      }
    }
    c.nextTickAt = Date.now() + CONFIG.TICK_MS;
    c.timer = setTimeout(() => this.resolveTick(), CONFIG.TICK_MS);
  }

  onAct(conn, msg) {
    const c = this.current;
    const agent = this.league.agentByToken(conn.meta.token);
    if (!c || c.finished || !agent || conn.meta.roomId !== this.id) return;
    const side = c.a.id === agent.id ? 'a' : c.b.id === agent.id ? 'b' : null;
    if (!side) return;
    if (msg.type === 'team_order') {
      const out = this.submitOrder(side, msg.order);
      conn.send({ type: out.ok ? 'order_locked' : 'order_rejected', matchId: c.matchId, side, ...out });
      return;
    }
    if (!c.obs) return;
    if (msg.matchId !== c.matchId || msg.tick !== c.obs.tick) {
      conn.send({ type: 'act_rejected', reason: 'stale_tick', expectedTick: c.obs.tick, gotTick: msg.tick });
      return;
    }
    const stat = c.decisions[side];
    // The per-match model budget is enforced here, not just advertised: an
    // external agent that declares more calls than the budget has its action
    // replaced by its own fallback for this tick. Declared calls are still
    // recorded - the player spent them whether or not the league used them.
    const declared = Number(msg.modelCalls) || 0;
    const overBudget = isRemoteSide(agent) && declared > 0 && (stat.modelCalls + declared) > MAX_MODEL_CALLS_PER_MATCH;
    stat.modelCalls += declared;
    if (overBudget) {
      stat.budgetExceeded += 1;
      c.pending[side] = agent.defaultAction || CONFIG.DEFAULT_ACTION;
      conn.send({ type: 'act_rejected', reason: 'model_budget_exceeded', matchId: c.matchId, side, budget: MAX_MODEL_CALLS_PER_MATCH, used: stat.modelCalls });
      return;
    }
    const action = ACTIONS.includes(msg.action) ? msg.action : agent.defaultAction;
    c.pending[side] = action;
    stat.decisions += 1;
    stat.totalMs += Date.now() - c.obs.openedAt;
  }

  resolveTick() {
    const c = this.current;
    if (!c || c.finished || !c.obs) return;
    let actionA = c.pending.a;
    let actionB = c.pending.b;
    if (actionA === null) { c.decisions.a.timeouts += 1; actionA = c.a.defaultAction || CONFIG.DEFAULT_ACTION; }
    if (actionB === null) { c.decisions.b.timeouts += 1; actionB = c.b.defaultAction || CONFIG.DEFAULT_ACTION; }

    const decisions = { a: explain('a', c.obs.a, actionA, c.a), b: explain('b', c.obs.b, actionB, c.b) };
    for (const side of ['a', 'b']) {
      const agent = c[side];
      if (agent.source === 'hosted' && agent.hostedStrategy) {
        const d = decide(agent.hostedStrategy, c.obs[side]);
        decisions[side].ruleIndex = d.ruleIndex;
        decisions[side].strategyNote = d.note;
        decisions[side].text += d.ruleIndex >= 0 ? ` · 规则#${d.ruleIndex}${d.note ? ' ' + d.note : ''}` : ' · 兜底';
      }
    }
    const out = c.match.advance(actionA, actionB, {
      a: { latencyMs: c.decisions.a.decisions ? Math.round(c.decisions.a.totalMs / c.decisions.a.decisions) : 0 },
      b: { latencyMs: c.decisions.b.decisions ? Math.round(c.decisions.b.totalMs / c.decisions.b.decisions) : 0 },
    });
    this.lastFrame = out.frames[out.frames.length - 1] || this.lastFrame;
    c.totalTicks = (c.totalTicks || 0) + 1;
    c.totalFrames = (c.totalFrames || 0) + out.frames.length;
    const statA = c.decisions.a;
    const statB = c.decisions.b;
    this.broadcast({
      type: 'tick',
      matchId: c.matchId,
      tick: c.match.tick - 1,
      frames: out.frames,
      events: out.events,
      actions: { a: actionA, b: actionB },
      decisions,
      hud: this.lastFrame,
      budget: {
        a: { avgMs: statA.decisions ? Math.round(statA.totalMs / statA.decisions) : 0, timeouts: statA.timeouts, modelCalls: statA.modelCalls },
        b: { avgMs: statB.decisions ? Math.round(statB.totalMs / statB.decisions) : 0, timeouts: statB.timeouts, modelCalls: statB.modelCalls },
      },
      over: out.over,
      result: out.result,
    });
    if (out.over) {
      if (c.team) this.roundOver(out.result);
      else this.finish(out.result);
    } else this.scheduleTick();
  }

  finish(result, { replay = null, rendered = null, format = 'single' } = {}) {
    const c = this.current;
    if (!c || c.finished) return;
    c.finished = true;
    clearTimeout(c.timer);
    if (this.intermission) clearTimeout(this.intermission.timer);
    this.intermission = null;
    const fullResult = { ...result, startedAt: c.startedAt };
    const match = this.league.recordMatch({
      matchId: c.matchId,
      agentA: c.a,
      agentB: c.b,
      result: fullResult,
      replay: replay || c.match.replay,
      format,
      team: result.team || null,
      decisions: {
        a: { ...c.decisions.a, avgDecisionMs: c.decisions.a.decisions ? Math.round(c.decisions.a.totalMs / c.decisions.a.decisions) : 0 },
        b: { ...c.decisions.b, avgDecisionMs: c.decisions.b.decisions ? Math.round(c.decisions.b.totalMs / c.decisions.b.decisions) : 0 },
      },
      roomId: this.id,
      mode: this.mode,
      ranked: this.ranked,
      pairing: this.pairing,
      fighters: this.fighters,
      stage: c.stage ? c.stage.id : null,
      seed: c.seed,
    });
    this.renderedReplay = rendered || renderReplay(replay || c.match.replay);
    this.league.unlockAgents([c.a.id, c.b.id]);
    this.status = 'finished';
    this.endedAt = new Date().toISOString();
    for (const side of ['a', 'b']) {
      const conn = this.agentConns.get(c[side].id);
      if (conn) conn.send({ type: 'match_end', matchId: c.matchId, result: fullResult, ratingDelta: this.ranked ? (side === 'a' ? match.ratingDeltaA : match.ratingDeltaB) : 0, ranked: this.ranked });
    }
    this.broadcast({
      type: 'match_end',
      matchId: c.matchId,
      result: match,
      leaderboard: this.league.getLeaderboard(),
      recentMatches: this.league.recentMatches(12),
    });
    this.manager.onRoomFinished(this, match);
    if (this.mode === 'demo') setTimeout(() => this.nextMatch(), 3000);
  }
}
