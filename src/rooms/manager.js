/** Matchmaking loop, broadcasts, replay cache and connection callbacks capability. */
import { isLadderCompetitor } from '../league.js';
import { renderReplay } from '../engine.js';
import { parseReplay } from '../replay.js';
import { parseTeamReplay, flattenTeamReplay } from '../team.js';
import { createLobbyCapability } from './manager-base.js';

/** Matchmaking + broadcast/connection surface. Reads shared manager state via `this`. */
export function createMatchmakingCapability() {
  return {
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
    },

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
    },

    rankedArena(format = 'single') {
      return this.idleRoom('ranked', format) || this.createRoom({ mode: 'ranked', ranked: true, pairing: 'rating', format });
    },

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
    },

    tick() {
      this.ticks += 1;
      this.matchmake();
      if (this.ticks % 2 === 0) this.broadcastRooms();
      if (this.ticks % 120 === 0) this.cleanup();
    },

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
          // WSConnection.sendFrame already guards dead sockets internally.
          conn.sendRaw(text);
        }
      }
    },

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
    },

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
    },

    onAct(conn, msg) {
      const agent = this.league.agentByToken(conn.meta.token);
      if (!agent) return;
      const room = this.rooms.get(this.agentRoom.get(agent.id));
      if (room) room.onAct(conn, msg);
    },

    onAgentDisconnect(conn) {
      const agent = this.league.agentByToken(conn.meta.token);
      if (!agent) return;
      if (this.agentConns.get(agent.id) === conn) this.agentConns.delete(agent.id);
      if (agent.source !== 'hosted') this.waiting = this.waiting.filter((w) => w.agentId !== agent.id);
    },

    getRenderedReplay(matchId) {
      if (this.renderCache.has(matchId)) return this.renderCache.get(matchId);
      for (const room of this.rooms.values()) {
        if (room.current && room.current.matchId === matchId && room.renderedReplay) return room.renderedReplay;
      }
      const text = this.league.getReplay(matchId);
      if (text === null) return null;
      // parseTeamReplay is total (it returns null on malformed input), so no
      // error boundary is needed here.
      const teamEnvelope = parseTeamReplay(text);
      const rendered = teamEnvelope ? flattenTeamReplay(teamEnvelope) : renderReplay(parseReplay(text, matchId));
      this.renderCache.set(matchId, rendered);
      return rendered;
    },

    meta() { return this.defaultRoom().meta(); },

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
    },

    state() {
      return { rooms: this.listRooms(), ...this.presence() };
    },

    shutdown() {
      clearInterval(this.timer);
      for (const room of this.rooms.values()) clearTimeout(room.current?.timer);
    },
  };
}

/**
 * Public RoomManager: composes the lobby and matchmaking capabilities onto one
 * instance at construction. No inheritance chain; every method is the real
 * implementation owned by its capability.
 */
export class RoomManager {
  constructor(league) {
    Object.assign(this, createLobbyCapability(), createMatchmakingCapability());
    this.init(league);
  }
}
