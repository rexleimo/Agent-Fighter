/** Lobby capability: room registry, agent connections and matchmaking entry points. */
import { CONFIG } from '../rules.js';
import { DEFAULT_FIGHTER, fighterBrief } from '../fighters.js';
import { teamView, normalizeTeam } from '../team.js';
import { Room } from './room.js';
import {
  assertCompetitor, competitorError, teamRosterError, isRemoteSide, nextRoomId,
} from './shared.js';

/** Lobby state + room registry. Operates on the shared manager state via `this`. */
export function createLobbyCapability() {
  return {
    init(league) {
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
    },

    createRoom({ mode = 'ranked', code = null, id = null, ranked = mode === 'ranked', pairing = 'rating', format = 'single', teams = null }) {
      const next = nextRoomId();
      const roomId = id || ('r_' + Date.now().toString(36) + '_' + next);
      const room = new Room({ id: roomId, mode, code, league: this.league, manager: this, ranked, pairing, format, teams });
      this.rooms.set(roomId, room);
      return room;
    },

    listRooms() {
      return Array.from(this.rooms.values()).map((r) => ({
        roomId: r.id,
        mode: r.mode,
        format: r.format,
        code: r.code,
        status: r.status,
        ranked: r.ranked,
        pairing: r.pairing,
        // Same field, same shape, on every surface that names a match: record,
        // replay header, room meta and room list. A partial publish is how a
        // client ends up guessing the arena in one view and reading it in another.
        stage: r.current ? (r.current.stage ? r.current.stage.id : null) : null,
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
    },

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
    },

    spectate(conn, roomId) {
      const room = this.rooms.get(roomId) || this.defaultRoom();
      room.spectators.add(conn);
      conn.meta.roomId = room.id;
      conn.send(this.snapshot(room));
      conn.onClose = () => room.spectators.delete(conn);
      return room;
    },

    // With no explicit room, spectators land on a REAL ranked match (team first)
    // whenever one is running; the empty-lobby fallback is the TEAM showcase, so
    // the first thing a visitor sees is the headline 3v3 elimination, not 1v1.
    // The single demo stays reachable from the lobby as r_demo.
    defaultRoom() {
      this.defaultShownAt = this.defaultShownAt || new Map();
      const running = Array.from(this.rooms.values())
        .filter((r) => r.mode === 'ranked' && r.status === 'running' && r.current);
      if (!running.length) return this.teamDemo;
      // Rotate by the last time a room was chosen as the default, so a second
      // concurrent match actually gets spectators instead of always showing
      // the newest one. Team format still wins ties.
      running.sort((x, y) => (this.defaultShownAt.get(x.id) || 0) - (this.defaultShownAt.get(y.id) || 0)
        || ((y.format === 'team') - (x.format === 'team'))
        || (new Date(y.current.startedAt) - new Date(x.current.startedAt)));
      const picked = running[0];
      this.defaultShownAt.set(picked.id, Date.now());
      return picked;
    },

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
          // Same two guards as enqueue(), expressed as an explicit Result so a
          // rejected WS queue reports the same error frame without try/catch.
          const error = competitorError(agent) || teamRosterError(agent, mode, format);
          if (error) {
            conn.send({ type: 'error', code: 'queue_rejected', message: error.message });
            conn.close();
          } else this.enqueue({ agent, conn, mode, code, format });
        }
      }
    },

    enqueue({ agent, conn = null, mode = 'ranked', code = null, auto = false, format = 'single' }) {
      assertCompetitor(agent);
      const rosterError = teamRosterError(agent, mode, format);
      if (rosterError) throw rosterError;
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
    },

    newCode() {
      return 'AFL-' + Math.random().toString(36).slice(2, 7).toUpperCase();
    },

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
    },

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
    },

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
    },
  };
}

// Backward-compatible export name for any direct importer of this internal module.
export const RoomManagerBase = createLobbyCapability;
