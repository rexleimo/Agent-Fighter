import { CONFIG, ACTIONS, MOVES } from './rules.js';
import { isLadderCompetitor } from './league.js';
import { createMatch, safePolicy, renderState, renderReplay } from './engine.js';
import { getBuiltinAgent } from './agents.js';
import { getFighter, DEFAULT_FIGHTER, fighterBrief } from './fighters.js';
import { parseReplay } from './replay.js';
import { decide } from './strategy-dsl.js';
import { MAX_MODEL_CALLS_PER_MATCH } from './costs.js';
import {
  createTeamState, teamRoundStart, applyRoundResult, applyOrder, isValidOrder,
  teamView, teamResult, createTeamReplay, appendTeamRound, flattenTeamReplay,
  parseTeamReplay, normalizeTeam, TEAM_INTERMISSION_MS,
} from './team.js';

/** Per-side decision counters. `budgetExceeded` counts ticks whose action was
 *  dropped because the agent declared more model calls than the match budget. */
/**
 * A side decides over the wire when the league cannot compute it locally:
 * built-ins are league code, and a hosted agent with a submitted strategy is
 * interpreted inside the room. Everything else receives `observe` and replies
 * with `act` — those are the only ticks that can cost a player a model call,
 * and therefore the only ticks the per-match budget applies to.
 */
function isRemoteSide(agent) {
  if (!agent) return false;
  if (agent.source === 'builtin') return false;
  return !(agent.source === 'hosted' && agent.hostedStrategy);
}

function newDecisionCounters() {
  return {
    a: { modelCalls: 0, timeouts: 0, decisions: 0, totalMs: 0, budgetExceeded: 0 },
    b: { modelCalls: 0, timeouts: 0, decisions: 0, totalMs: 0, budgetExceeded: 0 },
  };
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

function labelOf(action) { return ACTION_LABEL[action] || MOVES[action]?.label || action; }

function explain(side, obs, action, agent) {
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

let roomCounter = 0;

/**
 * One independent match container. Multiple Rooms run concurrently, each with
 * its own lockstep clock, its own spectators and its own replay. The league
 * kernel stays authoritative and deterministic inside every room.
 */
export class Room {
  constructor({ id, mode, code = null, league, manager, ranked = true, pairing = 'rating', format = 'single', teams = null }) {
    this.id = id;
    this.mode = mode;                 // demo | ranked | scrim
    this.code = code;
    this.ranked = ranked;             // scrim/demo results do not touch ELO
    this.pairing = pairing;           // showcase | rating | code | sparring (the only values the matchmaker produces)
    this.format = format;             // single | team (3v3 elimination)
    this.teams = teams;               // { a: [3 ids], b: [3 ids] } for team format
    this.league = league;
    this.manager = manager;
    this.spectators = new Set();
    this.aAgent = null;
    this.bAgent = null;
    this.fighters = { a: DEFAULT_FIGHTER, b: DEFAULT_FIGHTER };
    this.current = null;
    this.intermission = null;
    this.status = 'waiting';
    this.counter = 0;
    this.lastFrame = null;
    this.renderedReplay = null;
    this.createdAt = new Date().toISOString();
    this.endedAt = null;
  }

  get agentConns() { return this.manager.agentConns; }

  broadcast(msg) {
    const text = JSON.stringify({ ...msg, roomId: this.id });
    for (const conn of this.spectators) {
      try { conn.sendRaw(text); } catch { /* gone */ }
    }
  }

  publicSide(side) {
    const c = this.current;
    if (!c) return null;
    const agent = c[side];
    return {
      side,
      id: agent.id,
      name: agent.name,
      label: agent.label,
      kind: agent.kind,
      track: agent.track,
      source: agent.source,
      description: agent.description,
      versionHash: agent.versionHash,
      rating: Math.round(agent.rating),
      fighter: fighterBrief(this.fighters[side]),
      connected: agent.source !== 'external' || this.agentConns.has(agent.id),
    };
  }

  meta() {
    const c = this.current;
    if (!c) {
      return { roomId: this.id, mode: this.mode, format: this.format, code: this.code, status: this.status, ranked: this.ranked, pairing: this.pairing, a: null, b: null, lastFrame: null, matchId: null, tick: 0, team: null, intermission: null };
    }
    return {
      roomId: this.id,
      matchId: c.matchId,
      seed: c.seed,
      mode: this.mode,
      format: this.format,
      code: this.code,
      status: this.status,
      ranked: this.ranked,
      pairing: this.pairing,
      tick: c.match ? c.match.tick : 0,
      startedAt: c.startedAt,
      a: this.publicSide('a'),
      b: this.publicSide('b'),
      fighters: { a: fighterBrief(this.fighters.a), b: fighterBrief(this.fighters.b) },
      team: c.team ? teamView(c.team) : null,
      intermission: this.intermission ? {
        round: this.intermission.round,
        remainingMs: Math.max(0, this.intermission.deadlineAt - Date.now()),
        locked: { a: Boolean(this.intermission.orders.a), b: Boolean(this.intermission.orders.b) },
      } : null,
      lastFrame: this.lastFrame,
      tickMs: CONFIG.TICK_MS,
      framesPerTick: CONFIG.FRAMES_PER_TICK,
      totalTicks: CONFIG.MATCH_TICKS,
      spectators: this.spectators.size,
    };
  }

  start(a = null, b = null) {
    this.aAgent = a;
    this.bAgent = b;
    this.nextMatch();
  }

  nextMatch() {
    let a = this.aAgent;
    let b = this.bAgent;
    if (this.mode === 'demo') {
      [a, b] = this.league.pickNextPair();
      this.aAgent = a;
      this.bAgent = b;
      const roster = ['ember', 'tide', 'basalt', 'gale', 'volt', 'noct', 'quartz', 'forge'];
      const f = roster[this.counter % roster.length];
      this.fighters = { a: f, b: f };
    } else if (this.mode === 'ranked') {
      // Ranked mirrors one fighter on both sides: the ladder measures strategy,
      // never character tiers. Quartz is the neutral baseline.
      this.fighters = { a: DEFAULT_FIGHTER, b: DEFAULT_FIGHTER };
    } else {
      this.fighters = { a: a.fighterId || DEFAULT_FIGHTER, b: b.fighterId || DEFAULT_FIGHTER };
    }
    this.counter += 1;
    const matchId = this.id + '_' + Date.now().toString(36) + '_' + this.counter;
    const seed = (Date.now() ^ Math.imul(this.counter * 2654435761, 40503)) >>> 0;
    if (this.format === 'team') {
      this.beginTeamMatch(a, b, matchId, seed);
      return;
    }
    const match = createMatch({ seed, matchId, agents: [a, b], fighters: this.fighters });
    this.current = {
      matchId, seed, match, a, b,
      pending: { a: null, b: null },
      obs: null,
      decisions: newDecisionCounters(),
      startedAt: new Date().toISOString(),
      nextTickAt: Date.now() + CONFIG.TICK_MS,
      timer: null,
      finished: false,
    };
    this.status = 'running';
    this.endedAt = null;
    this.renderedReplay = null;
    this.lastFrame = renderState(match.state);
    this.league.lockAgents([a.id, b.id], matchId);
    this.broadcast({ type: 'match_start', match: this.meta(), leaderboard: this.league.getLeaderboard() });
    for (const side of ['a', 'b']) {
      const agent = this.current[side];
      const conn = this.agentConns.get(agent.id);
      if (conn) {
        conn.send({
          type: 'match_start',
          matchId, seed, side, roomId: this.id, mode: this.mode,
          opponent: this.current[side === 'a' ? 'b' : 'a'].name,
          fighter: fighterBrief(this.fighters[side]),
          versionHash: agent.versionHash,
          tickMs: CONFIG.TICK_MS,
          defaultAction: agent.defaultAction,
          realtimePath: '/ws/agent',
        });
      }
    }
    this.scheduleTick();
  }

  /**
   * Team elimination: the room owns the multi-round lifecycle, the kernel
   * still fights one deterministic round at a time. Round results fold into
   * the pure team state (src/team.js); between rounds an intermission window
   * collects each side's single order change.
   */
  beginTeamMatch(a, b, matchId, seed) {
    const roster = ['quartz', 'volt', 'noct', 'forge', 'ember', 'tide', 'basalt', 'gale'];
    const off = (this.counter * 3) % roster.length;
    const pick = (n) => [0, 1, 2].map((i) => roster[(off + n + i) % roster.length]);
    const sideTeam = (side, agent, n) => (this.teams && this.teams[side]) || (agent && agent.team) || pick(n);
    this.teams = { a: normalizeTeam(sideTeam('a', a, 0)), b: normalizeTeam(sideTeam('b', b, 3)) };
    const team = createTeamState({ matchId, seed, teams: this.teams });
    this.current = {
      matchId, seed, a, b, team,
      teamReplay: createTeamReplay(matchId, seed, [a, b], this.teams),
      match: null,
      pending: { a: null, b: null },
      obs: null,
      decisions: newDecisionCounters(),
      startedAt: new Date().toISOString(),
      nextTickAt: Date.now() + CONFIG.TICK_MS,
      timer: null,
      finished: false,
      roundStart: null,
      totalTicks: 0,
      totalFrames: 0,
    };
    this.status = 'running';
    this.endedAt = null;
    this.renderedReplay = null;
    this.league.lockAgents([a.id, b.id], matchId);
    this.broadcast({ type: 'match_start', match: this.meta(), leaderboard: this.league.getLeaderboard() });
    for (const side of ['a', 'b']) {
      const agent = this.current[side];
      const conn = this.agentConns.get(agent.id);
      if (conn) {
        conn.send({
          type: 'match_start', matchId, seed, side, roomId: this.id, mode: this.mode,
          format: 'team', team: teamView(team),
          opponent: this.current[side === 'a' ? 'b' : 'a'].name,
          versionHash: agent.versionHash,
          tickMs: CONFIG.TICK_MS,
          defaultAction: agent.defaultAction,
          realtimePath: '/ws/agent',
        });
      }
    }
    this.startTeamRound();
  }

  startTeamRound() {
    const c = this.current;
    const { fighters, start } = teamRoundStart(c.team);
    this.fighters = fighters;
    c.match = createMatch({
      seed: (c.seed ^ Math.imul(c.team.round, 2654435761)) >>> 0,
      matchId: c.matchId, agents: [c.a, c.b], fighters, start,
    });
    c.roundStart = { fighters, start };
    c.pending = { a: null, b: null };
    c.obs = null;
    c.nextTickAt = Date.now() + CONFIG.TICK_MS;
    this.status = 'running';
    this.lastFrame = renderState(c.match.state);
    this.broadcast({ type: 'round_start', match: this.meta(), team: teamView(c.team), round: c.team.round, start });
    this.scheduleTick();
  }

  roundOver(result) {
    const c = this.current;
    clearTimeout(c.timer);
    const verdict = { winner: result.winner, reason: result.reason };
    const summary = applyRoundResult(c.team, verdict);
    appendTeamRound(c.teamReplay, {
      round: summary.round,
      start: c.roundStart,
      // Filled by closeIntermission: the order change chosen AFTER this round.
      orders: { a: null, b: null },
      result: verdict,
      summary,
      replay: c.match.replay,
    });
    this.broadcast({ type: 'round_end', matchId: c.matchId, round: summary.round, summary, team: teamView(c.team), result: verdict });
    if (c.team.over) {
      this.finishTeam();
      return;
    }
    this.openIntermission();
  }

  openIntermission() {
    const c = this.current;
    this.status = 'intermission';
    this.intermission = {
      round: c.team.round,
      deadlineAt: Date.now() + TEAM_INTERMISSION_MS,
      orders: { a: null, b: null },
      timer: null,
    };
    this.broadcast({ type: 'intermission', matchId: c.matchId, round: c.team.round, team: teamView(c.team), deadlineMs: TEAM_INTERMISSION_MS });
    for (const side of ['a', 'b']) {
      const agent = c[side];
      const conn = this.agentConns.get(agent.id);
      // Same predicate as the observe path: whoever is driven tick by tick over
      // the wire is whoever must be told the intermission window opened. Using
      // source === 'external' here instead meant a registered player who pilots
      // over WS - hosted, but no strategy submitted yet - got every observe and
      // no reorder window at all.
      if (conn && isRemoteSide(agent)) {
        conn.send({
          type: 'intermission', matchId: c.matchId, round: c.team.round, side,
          deadlineMs: TEAM_INTERMISSION_MS, team: teamView(c.team),
          yourOrder: c.team.sides[side].order.slice(),
        });
      }
    }
    this.intermission.timer = setTimeout(() => this.closeIntermission(), TEAM_INTERMISSION_MS);
  }

  submitOrder(side, ids) {
    const c = this.current;
    if (!c || !c.team || !this.intermission || c.finished) return { ok: false, reason: 'not_in_intermission' };
    if (this.intermission.orders[side]) return { ok: false, reason: 'order_already_locked' };
    if (!isValidOrder(c.team, side, ids)) return { ok: false, reason: 'invalid_order', expected: c.team.sides[side].order.slice() };
    this.intermission.orders[side] = ids.slice();
    this.broadcast({ type: 'order_locked', matchId: c.matchId, side, order: ids.slice() });
    if (this.intermission.orders.a && this.intermission.orders.b) this.closeIntermission();
    return { ok: true, order: ids.slice() };
  }

  closeIntermission() {
    const c = this.current;
    const im = this.intermission;
    if (!c || !im || c.finished) return;
    clearTimeout(im.timer);
    for (const side of ['a', 'b']) {
      if (im.orders[side]) applyOrder(c.team, side, im.orders[side]);
    }
    const last = c.teamReplay.rounds[c.teamReplay.rounds.length - 1];
    if (last) last.orders = { a: im.orders.a, b: im.orders.b };
    this.intermission = null;
    this.startTeamRound();
  }

  finishTeam() {
    const c = this.current;
    const tr = teamResult(c.team);
    const hpOf = (side) => {
      const id = c.team.sides[side].order[0];
      return id ? c.team.sides[side].roster[id].hp : 0;
    };
    this.finish({
      matchId: c.matchId,
      winner: tr.winner,
      reason: tr.reason,
      hpA: hpOf('a'),
      hpB: hpOf('b'),
      ticks: c.totalTicks,
      frame: c.totalFrames,
      team: tr,
    }, { replay: c.teamReplay, rendered: flattenTeamReplay(c.teamReplay), format: 'team' });
  }

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

/**
 * Lobby + matchmaking. Answers "who is connected to whom":
 *  - demo   : built-in rotation, always on, default spectator channel
 *  - ranked : same track, nearest rating; after 3s without a human opponent
 *             a built-in sparring partner with the closest rating is assigned
 *  - scrim  : explicit room code, unranked, for tuning and rematches
 */
function assertCompetitor(agent) {
  if (!agent) throw new Error('agent is required');
  if (agent.playerId) return;
  if (agent.source === 'builtin' || agent.id === 'demo_hosted') {
    throw new Error('official baselines do not enter matchmaking: they are sparring partners and showcase fighters only');
  }
  throw new Error('player login required: anonymous agents cannot enter matches');
}

export class RoomManager {
  constructor(league) {
    this.league = league;
    this.rooms = new Map();
    this.agentConns = new Map();   // agentId -> WS connection
    this.agentRoom = new Map();    // agentId -> roomId
    this.waiting = [];             // { agentId, mode, code, conn, joinedAt, track, rating }
    this.renderCache = new Map();
    this.ticks = 0;
    this.demo = this.createRoom({ mode: 'demo', id: 'r_demo', ranked: false, pairing: 'showcase' });
    this.demo.start(null, null);
    this.teamDemo = this.createRoom({ mode: 'demo', id: 'r_team_demo', ranked: false, pairing: 'showcase', format: 'team' });
    this.teamDemo.start(null, null);
    this.timer = setInterval(() => this.tick(), 500);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  createRoom({ mode = 'ranked', code = null, id = null, ranked = mode === 'ranked', pairing = 'rating', format = 'single', teams = null }) {
    roomCounter += 1;
    const roomId = id || ('r_' + Date.now().toString(36) + '_' + roomCounter);
    const room = new Room({ id: roomId, mode, code, league: this.league, manager: this, ranked, pairing, format, teams });
    this.rooms.set(roomId, room);
    return room;
  }

  listRooms() {
    return Array.from(this.rooms.values()).map((r) => ({
      roomId: r.id,
      mode: r.mode,
      format: r.format,
      code: r.code,
      status: r.status,
      ranked: r.ranked,
      pairing: r.pairing,
      matchId: r.current ? r.current.matchId : null,
      tick: r.current && r.current.match ? r.current.match.tick : 0,
      round: r.current && r.current.team ? r.current.team.round : 1,
      team: r.current && r.current.team ? teamView(r.current.team) : null,
      a: r.aAgent ? { id: r.aAgent.id, name: r.aAgent.name, fighter: fighterBrief(r.fighters.a), source: r.aAgent.source, connected: r.aAgent.source !== 'external' || this.agentConns.has(r.aAgent.id) } : null,
      b: r.bAgent ? { id: r.bAgent.id, name: r.bAgent.name, fighter: fighterBrief(r.fighters.b), source: r.bAgent.source, connected: r.bAgent.source !== 'external' || this.agentConns.has(r.bAgent.id) } : null,
      fighters: { a: fighterBrief(r.fighters.a), b: fighterBrief(r.fighters.b) },
      spectators: r.spectators.size,
      createdAt: r.createdAt,
      endedAt: r.endedAt,
      watchUrl: '/?view=live&room=' + encodeURIComponent(r.id),
    }));
  }

  snapshot(room) {
    return {
      type: 'hello',
      server: { name: 'Agent Fighting League', season: this.league.season, tickMs: CONFIG.TICK_MS },
      match: room.meta(),
      roomId: room.id,
      rooms: this.listRooms(),
      presence: this.presence(),
      leaderboard: this.league.getLeaderboard(),
      recentMatches: this.league.recentMatches(12),
      agents: this.league.listAgents(),
      fighters: this.league.listFighters(),
    };
  }

  spectate(conn, roomId) {
    const room = this.rooms.get(roomId) || this.defaultRoom();
    room.spectators.add(conn);
    conn.meta.roomId = room.id;
    conn.send(this.snapshot(room));
    conn.onClose = () => room.spectators.delete(conn);
    return room;
  }

  // With no explicit room, spectators land on a REAL ranked match (team first)
  // whenever one is running; the built-in demo is only the empty-lobby fallback.
  defaultRoom() {
    const running = Array.from(this.rooms.values())
      .filter((r) => r.mode === 'ranked' && r.status === 'running' && r.current)
      .sort((x, y) => ((y.format === 'team') - (x.format === 'team'))
        || (new Date(y.current.startedAt) - new Date(x.current.startedAt)));
    return running[0] || this.demo;
  }

  joinAgent(conn, agent, { mode = 'ranked', code = null, format = 'single' } = {}) {
    this.agentConns.set(agent.id, conn);
    conn.meta.roomId = null;
    conn.send({
      type: 'connected', agentId: agent.id, name: agent.name,
      versionHash: agent.versionHash, tickMs: CONFIG.TICK_MS,
      defaultAction: agent.defaultAction,
      mode,
      // Truthful, and keyed off the same predicate the tick loop uses: a hosted
      // agent only stops needing realtime once a strategy is actually on file.
      message: isRemoteSide(agent)
        ? 'Queued. You will receive observe messages each tick; reply with act before deadlineMs.'
        : 'Hosted strategy on file: the league runs your strategy server-side, so no realtime connection is needed. Your team_order / set_team_order calls still work here.',
    });
    conn.onMessage = (msg) => {
      if (msg.type === 'act' || msg.type === 'team_order') this.onAct(conn, msg);
    };
    conn.onClose = () => this.onAgentDisconnect(conn);
    // MCP create_room / join_room may already have seated this agent in a room.
    // A bare WebSocket connect must resume that room for ANY agent, including a
    // hosted one: onAct() drops every act and team_order whose conn has no
    // roomId, so gating this on source === 'hosted' meant a registered player
    // (hosted by default) who pilots over WS received observes but had all of
    // their replies silently discarded - the match ran on timeouts alone.
    const assigned = this.rooms.get(this.agentRoom.get(agent.id));
    if (assigned && ['waiting', 'running', 'intermission'].includes(assigned.status)) {
      conn.meta.roomId = assigned.id;
      const seated = this.waiting.find((w) => w.agentId === agent.id);
      if (seated) seated.conn = conn;
      return;
    }
    if (isRemoteSide(agent)) {
      // A prior MCP join_queue may already have queued this agent (e.g. with a
      // scrim code). Keep that entry and just attach the live connection.
      const existing = this.waiting.find((w) => w.agentId === agent.id);
      if (existing) existing.conn = conn;
      else {
        try {
          this.enqueue({ agent, conn, mode, code, format });
        } catch (err) {
          conn.send({ type: 'error', code: 'queue_rejected', message: err.message });
          conn.close();
        }
      }
    }
  }

  enqueue({ agent, conn = null, mode = 'ranked', code = null, auto = false, format = 'single' }) {
    assertCompetitor(agent);
    if (mode === 'ranked' && format === 'team' && !agent.team) {
      throw new Error('team format requires a roster: declare 3 fighters via set_team (or register_agent team=...) first');
    }
    this.waiting = this.waiting.filter((w) => w.agentId !== agent.id);
    const entry = {
      agentId: agent.id, mode, code, conn, auto, format,
      joinedAt: Date.now(),
      track: agent.track || 'open',
      rating: agent.rating || 1500,
      source: agent.source,
    };
    if (mode === 'scrim') {
      const room = code ? Array.from(this.rooms.values()).find((r) => r.mode === 'scrim' && r.code === code && r.status === 'waiting') : null;
      if (room && room.aAgent && room.aAgent.id !== agent.id) {
        this.startRoom(room, room.aAgent, agent, { pairing: 'code' });
        return { joined: true, roomId: room.id, code };
      }
      const created = this.createRoom({ mode: 'scrim', code: code || this.newCode(), ranked: false, pairing: 'code' });
      created.aAgent = agent;
      created.status = 'waiting';
      this.agentRoom.set(agent.id, created.id);
      if (conn) conn.meta.roomId = created.id;
      entry.code = created.code;
      this.waiting.push(entry);
      return { joined: true, roomId: created.id, code: created.code, waitingForOpponent: true };
    }
    this.waiting.push(entry);
    return { joined: true, mode: 'ranked', position: this.waiting.filter((w) => w.mode === 'ranked').length };
  }

  newCode() {
    return 'AFL-' + Math.random().toString(36).slice(2, 7).toUpperCase();
  }

  createScrim(agent, { format = 'single', team = null } = {}) {
    assertCompetitor(agent);
    const teams = format === 'team' ? { a: normalizeTeam(team || agent.team), b: null } : null;
    const room = this.createRoom({ mode: 'scrim', code: this.newCode(), ranked: false, pairing: 'code', format, teams });
    room.aAgent = agent;
    room.status = 'waiting';
    this.agentRoom.set(agent.id, room.id);
    this.waiting = this.waiting.filter((w) => w.agentId !== agent.id);
    this.waiting.push({ agentId: agent.id, mode: 'scrim', code: room.code, conn: null, joinedAt: Date.now(), track: agent.track, rating: agent.rating, source: agent.source });
    return room;
  }

  joinScrim(agent, code, { team = null, conn = null } = {}) {
    assertCompetitor(agent);
    const room = Array.from(this.rooms.values()).find((r) => r.mode === 'scrim' && r.code === code && r.status === 'waiting');
    if (!room) throw new Error('room not found or already started: ' + code);
    if (!room.aAgent || room.aAgent.id === agent.id) throw new Error('cannot join your own room');
    if (room.format === 'team') {
      room.teams = { a: room.teams.a, b: normalizeTeam(team || agent.team) };
    }
    this.startRoom(room, room.aAgent, agent, { pairing: 'code' });
    return room;
  }

  startRoom(room, a, b, { pairing = 'rating' } = {}) {
    room.pairing = pairing;
    room.aAgent = a;
    room.bAgent = b;
    this.agentRoom.set(a.id, room.id);
    this.agentRoom.set(b.id, room.id);
    for (const agent of [a, b]) {
      const conn = this.agentConns.get(agent.id);
      if (conn) conn.meta.roomId = room.id;
    }
    this.waiting = this.waiting.filter((w) => w.agentId !== a.id && w.agentId !== b.id);
    room.start(a, b);
    return room;
  }

  nearestSparring(agent) {
    // Official baselines all hold the same fixed nominal rating, so "nearest
    // rating" cannot discriminate between them. Rotate instead: every
    // registrant meets a different official style instead of the same one.
    const pool = Array.from(this.league.agents.values()).filter((x) => x.source === 'builtin');
    if (!pool.length) return null;
    const byRating = pool.sort((x, y) => Math.abs(x.rating - agent.rating) - Math.abs(y.rating - agent.rating));
    const tied = byRating.filter((x) => Math.abs(x.rating - agent.rating) <= Math.abs(byRating[0].rating - agent.rating));
    this.sparCursor = ((this.sparCursor || 0) + 1) % Math.max(1, tied.length);
    return tied[this.sparCursor] || tied[0];
  }

  /**
   * A finished room is an idle arena, not garbage. Matchmaking reuses it
   * instead of creating a new one, so the room table stays bounded by how
   * many matches run at the same time instead of by how many pairings ever
   * happened. A room nobody watches is preferred; a watched one is still
   * reused, because the room is the watch target and the next match in it
   * is announced with match_start.
   */
  idleRoom(mode, format = 'single') {
    let watched = null;
    for (const room of this.rooms.values()) {
      if (room.mode !== mode || room.format !== format || room.status !== 'finished') continue;
      if (room.spectators.size === 0) return room;
      watched = watched || room;
    }
    return watched;
  }

  rankedArena(format = 'single') {
    return this.idleRoom('ranked', format) || this.createRoom({ mode: 'ranked', ranked: true, pairing: 'rating', format });
  }

  matchmake() {
    const now = Date.now();
    const ranked = this.waiting.filter((w) => w.mode === 'ranked');
    const used = new Set();
    const byTrack = new Map();
    for (const w of ranked) {
      const key = w.track + '|' + (w.format || 'single');
      if (!byTrack.has(key)) byTrack.set(key, []);
      byTrack.get(key).push(w);
    }
    for (const group of byTrack.values()) {
      group.sort((a, b) => a.joinedAt - b.joinedAt);
      for (const w of group) {
        if (used.has(w.agentId)) continue;
        const agent = this.league.agents.get(w.agentId);
        if (!agent || !isLadderCompetitor(agent)) {
          // An official baseline in the ranked queue would re-create the old
          // showcase self-play loop: thousands of ladder rows nobody plays.
          used.add(w.agentId);
          this.waiting = this.waiting.filter((x) => x.agentId !== w.agentId);
          continue;
        }
        const format = w.format || 'single';
        // Team ladder waits longer for a real opponent before taking a sparring
        // partner: a registered player should meet another registrant first.
        const sparAfterMs = format === 'team' ? 8000 : 3000;
        const mate = group.find((o) => o.agentId !== w.agentId && !used.has(o.agentId)
          && (Math.abs(o.rating - w.rating) <= 400 || now - Math.min(w.joinedAt, o.joinedAt) > 3000));
        if (mate) {
          const other = this.league.agents.get(mate.agentId);
          used.add(w.agentId); used.add(mate.agentId);
          if (other && isLadderCompetitor(other)) this.startRoom(this.rankedArena(format), agent, other, { pairing: 'rating' });
        } else if (now - w.joinedAt > sparAfterMs) {
          used.add(w.agentId);
          const spar = this.nearestSparring(agent);
          if (spar) this.startRoom(this.rankedArena(format), agent, spar, { pairing: 'sparring' });
        }
      }
    }
    if (used.size) this.waiting = this.waiting.filter((w) => !used.has(w.agentId));

    // Scrim rooms: no human opponent after 45s -> give the host a sparring partner.
    for (const w of this.waiting.filter((x) => x.mode === 'scrim')) {
      const room = Array.from(this.rooms.values()).find((r) => r.mode === 'scrim' && r.code === w.code && r.status === 'waiting');
      if (!room || now - w.joinedAt < 45000) continue;
      const host = this.league.agents.get(w.agentId);
      const spar = host ? this.nearestSparring(host) : null;
      if (host && spar) this.startRoom(room, host, spar, { pairing: 'sparring' });
      else this.waiting = this.waiting.filter((x) => x !== w);
    }
  }

  tick() {
    this.ticks += 1;
    this.matchmake();
    if (this.ticks % 2 === 0) this.broadcastRooms();
    if (this.ticks % 120 === 0) this.cleanup();
  }

  broadcastRooms() {
    const text = JSON.stringify({
      type: 'rooms',
      rooms: this.listRooms(),
      presence: this.presence(),
      leaderboard: this.league.getLeaderboard(),
      recentMatches: this.league.recentMatches(12),
    });
    for (const room of this.rooms.values()) {
      for (const conn of room.spectators) {
        try { conn.sendRaw(text); } catch { /* gone */ }
      }
    }
  }

  cleanup() {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const room of this.rooms.values()) {
      if (room === this.demo || room === this.teamDemo || room.status !== 'finished' || !room.endedAt) continue;
      if (new Date(room.endedAt).getTime() < cutoff && room.spectators.size === 0) {
        if (room.renderedReplay) this.renderCache.set(room.current.matchId, room.renderedReplay);
        this.rooms.delete(room.id);
      }
    }
    this.waiting = this.waiting.filter((w) => Date.now() - w.joinedAt < 5 * 60 * 1000);
  }

  onRoomFinished(room, match) {
    if (room.renderedReplay) {
      this.renderCache.set(match.matchId, room.renderedReplay);
      if (this.renderCache.size > 30) this.renderCache.delete(this.renderCache.keys().next().value);
    }
    const c = room.current;
    for (const side of ['a', 'b']) {
      const agent = c[side];
      this.agentRoom.delete(agent.id);
      const conn = this.agentConns.get(agent.id);
      if (conn) conn.meta.roomId = null;
      if (agent.source === 'hosted' && agent.autoRequeue !== false && isLadderCompetitor(agent)) {
        setTimeout(() => this.enqueue({ agent, mode: 'ranked', format: room.format, auto: true }), 3000);
      }
    }
    this.broadcastRooms();
  }

  onAct(conn, msg) {
    const agent = this.league.agentByToken(conn.meta.token);
    if (!agent) return;
    const room = this.rooms.get(this.agentRoom.get(agent.id));
    if (room) room.onAct(conn, msg);
  }

  onAgentDisconnect(conn) {
    const agent = this.league.agentByToken(conn.meta.token);
    if (!agent) return;
    if (this.agentConns.get(agent.id) === conn) this.agentConns.delete(agent.id);
    if (agent.source !== 'hosted') this.waiting = this.waiting.filter((w) => w.agentId !== agent.id);
  }

  getRenderedReplay(matchId) {
    if (this.renderCache.has(matchId)) return this.renderCache.get(matchId);
    for (const room of this.rooms.values()) {
      if (room.current && room.current.matchId === matchId && room.renderedReplay) return room.renderedReplay;
    }
    const text = this.league.getReplay(matchId);
    if (text === null) return null;
    let teamEnvelope = null;
    try { teamEnvelope = parseTeamReplay(text); } catch { /* single-round JSONL */ }
    const rendered = teamEnvelope ? flattenTeamReplay(teamEnvelope) : renderReplay(parseReplay(text, matchId));
    this.renderCache.set(matchId, rendered);
    return rendered;
  }

  meta() { return this.defaultRoom().meta(); }

  // Who is ACTUALLY connected to the league right now. Exposed in every
  // spectator hello / rooms broadcast so the UI can never imply that a
  // built-in showcase match has real players behind it.
  presence() {
    const all = Array.from(this.rooms.values());
    return {
      onlineAgents: this.agentConns.size,
      waiting: this.waiting.length,
      spectators: all.reduce((n, r) => n + r.spectators.size, 0),
      totalRooms: all.length,
      finishedRooms: all.filter((r) => r.status === 'finished').length,
      queue: this.waiting.map((w) => {
        const a = this.league.agents.get(w.agentId);
        return {
          agentId: w.agentId,
          name: a ? a.name : w.agentId,
          team: a && a.team ? a.team.slice() : null,
          mode: w.mode,
          format: w.format || 'single',
          source: w.source,
          rating: a ? Math.round(a.rating) : w.rating,
          waitingMs: Date.now() - w.joinedAt,
        };
      }),
    };
  }

  state() {
    return { rooms: this.listRooms(), ...this.presence() };
  }

  shutdown() {
    clearInterval(this.timer);
    for (const room of this.rooms.values()) clearTimeout(room.current?.timer);
  }
}
