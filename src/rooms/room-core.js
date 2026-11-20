/** Room lifecycle, setup, team rounds and intermission capability. */
import { CONFIG } from '../rules.js';
import { createMatch, renderState } from '../engine.js';
import { DEFAULT_FIGHTER, fighterBrief } from '../fighters.js';
import { selectStage, rosterTeam } from '../stages.js';
import {
  createTeamState, teamRoundStart, applyRoundResult, applyOrder, isValidOrder,
  teamView, teamResult, createTeamReplay, appendTeamRound, flattenTeamReplay,
  normalizeTeam, TEAM_INTERMISSION_MS,
} from '../team.js';
import { isRemoteSide, newDecisionCounters } from './shared.js';

/** Room lifecycle + team-round state machine. Operates on shared room state via `this`. */
export function createRoomCoreCapability() {
  return {
    init({ id, mode, code = null, league, manager, ranked = true, pairing = 'rating', format = 'single', teams = null }) {
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
    },

    broadcast(msg) {
      const text = JSON.stringify({ ...msg, roomId: this.id });
      for (const conn of this.spectators) {
        // WSConnection.sendRaw -> sendFrame guards dead sockets internally.
        conn.sendRaw(text);
      }
    },

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
    },

    meta() {
      const c = this.current;
      if (!c) {
        return { roomId: this.id, mode: this.mode, format: this.format, code: this.code, status: this.status, ranked: this.ranked, pairing: this.pairing, a: null, b: null, lastFrame: null, matchId: null, tick: 0, team: null, intermission: null };
      }
      return {
        roomId: this.id,
        matchId: c.matchId,
        seed: c.seed,
        // The arena id, published in the same shape as the match record and the
        // replay header. A spectator joining mid-game sees what the server chose
        // at kickoff; the client resolves the rest through /api/stages. Keeping
        // one shape across all three surfaces is what makes live==replay checkable.
        stage: c.stage ? c.stage.id : null,
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
    },

    start(a = null, b = null) {
      this.aAgent = a;
      this.bAgent = b;
      this.nextMatch();
    },

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
      // The arena is decided here, once, from data the replay already carries
      // (seed + fighters). The client never picks it, so live and replay cannot
      // disagree about which stage this match was fought on.
      const stage = selectStage({
        fighterA: this.fighters.a, fighterB: this.fighters.b, seed, mode: this.mode,
      });
      this.current = {
        matchId, seed, match, a, b, stage,
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
    },

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
      // A 3v3 belongs to a team, so the home stage comes from the rosters, not
      // from whichever fighter happens to be listed first.
      const stage = selectStage({
        teamA: rosterTeam(this.teams.a), teamB: rosterTeam(this.teams.b), seed, mode: this.mode,
      });
      this.current = {
        matchId, seed, a, b, team, stage,
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
    },

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
    },

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
    },

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
    },

    submitOrder(side, ids) {
      const c = this.current;
      if (!c || !c.team || !this.intermission || c.finished) return { ok: false, reason: 'not_in_intermission' };
      if (this.intermission.orders[side]) return { ok: false, reason: 'order_already_locked' };
      if (!isValidOrder(c.team, side, ids)) return { ok: false, reason: 'invalid_order', expected: c.team.sides[side].order.slice() };
      this.intermission.orders[side] = ids.slice();
      this.broadcast({ type: 'order_locked', matchId: c.matchId, side, order: ids.slice() });
      if (this.intermission.orders.a && this.intermission.orders.b) this.closeIntermission();
      return { ok: true, order: ids.slice() };
    },

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
    },

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
    },
  };
}

// Backward-compatible export name for any direct importer of this internal module.
export const RoomCore = createRoomCoreCapability;
