import { CONFIG, ACTIONS, MOVES } from './rules.js';
import { createMatch, safePolicy, renderState, renderReplay } from './engine.js';
import { getBuiltinAgent } from './agents.js';
import { getFighter, DEFAULT_FIGHTER, fighterBrief } from './fighters.js';
import { parseReplay } from './replay.js';
import { decide } from './strategy-dsl.js';

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
  constructor({ id, mode, code = null, league, manager, ranked = true, pairing = 'rating' }) {
    this.id = id;
    this.mode = mode;                 // demo | ranked | scrim
    this.code = code;
    this.ranked = ranked;             // scrim/demo results do not touch ELO
    this.pairing = pairing;           // showcase | rating | code | sparring
    this.league = league;
    this.manager = manager;
    this.spectators = new Set();
    this.aAgent = null;
    this.bAgent = null;
    this.fighters = { a: DEFAULT_FIGHTER, b: DEFAULT_FIGHTER };
    this.current = null;
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
      return { roomId: this.id, mode: this.mode, code: this.code, status: this.status, ranked: this.ranked, pairing: this.pairing, a: null, b: null, lastFrame: null, matchId: null, tick: 0 };
    }
    return {
      roomId: this.id,
      matchId: c.matchId,
      seed: c.seed,
      mode: this.mode,
      code: this.code,
      status: this.status,
      ranked: this.ranked,
      pairing: this.pairing,
      tick: c.match.tick,
      startedAt: c.startedAt,
      a: this.publicSide('a'),
      b: this.publicSide('b'),
      fighters: { a: fighterBrief(this.fighters.a), b: fighterBrief(this.fighters.b) },
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
    const match = createMatch({ seed, matchId, agents: [a, b], fighters: this.fighters });
    this.current = {
      matchId, seed, match, a, b,
      pending: { a: null, b: null },
      obs: null,
      decisions: {
        a: { modelCalls: 0, timeouts: 0, decisions: 0, totalMs: 0 },
        b: { modelCalls: 0, timeouts: 0, decisions: 0, totalMs: 0 },
      },
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

  scheduleTick() {
    const c = this.current;
    if (!c || c.finished) return;
    c.timer = setTimeout(() => this.openTick(), Math.max(0, c.nextTickAt - Date.now()));
  }

  openTick() {
    const c = this.current;
    if (!c || c.finished || c.match.over) return;
    const tick = c.match.tick;
    const obs = c.match.observations(CONFIG.TICK_MS);
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
        const conn = this.agentConns.get(agent.id);
        if (conn) conn.send({ type: 'observe', matchId: c.matchId, tick, deadlineMs: CONFIG.TICK_MS, observation: obs[side] });
      }
    }
    c.nextTickAt = Date.now() + CONFIG.TICK_MS;
    c.timer = setTimeout(() => this.resolveTick(), CONFIG.TICK_MS);
  }

  onAct(conn, msg) {
    const c = this.current;
    const agent = this.league.agentByToken(conn.meta.token);
    if (!c || c.finished || !agent || !c.obs || conn.meta.roomId !== this.id) return;
    const side = c.a.id === agent.id ? 'a' : c.b.id === agent.id ? 'b' : null;
    if (!side) return;
    if (msg.matchId !== c.matchId || msg.tick !== c.obs.tick) {
      conn.send({ type: 'act_rejected', reason: 'stale_tick', expectedTick: c.obs.tick, gotTick: msg.tick });
      return;
    }
    const action = ACTIONS.includes(msg.action) ? msg.action : agent.defaultAction;
    c.pending[side] = action;
    const stat = c.decisions[side];
    stat.decisions += 1;
    stat.totalMs += Date.now() - c.obs.openedAt;
    stat.modelCalls += Number(msg.modelCalls || 0);
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
    if (out.over) this.finish(out.result);
    else this.scheduleTick();
  }

  finish(result) {
    const c = this.current;
    if (!c || c.finished) return;
    c.finished = true;
    clearTimeout(c.timer);
    const fullResult = { ...result, startedAt: c.startedAt };
    const match = this.league.recordMatch({
      matchId: c.matchId,
      agentA: c.a,
      agentB: c.b,
      result: fullResult,
      replay: c.match.replay,
      decisions: {
        a: { modelCalls: c.decisions.a.modelCalls, timeouts: c.decisions.a.timeouts, avgDecisionMs: c.decisions.a.decisions ? Math.round(c.decisions.a.totalMs / c.decisions.a.decisions) : 0 },
        b: { modelCalls: c.decisions.b.modelCalls, timeouts: c.decisions.b.timeouts, avgDecisionMs: c.decisions.b.decisions ? Math.round(c.decisions.b.totalMs / c.decisions.b.decisions) : 0 },
      },
      roomId: this.id,
      mode: this.mode,
      ranked: this.ranked,
      fighters: this.fighters,
    });
    this.renderedReplay = renderReplay(c.match.replay);
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
    this.timer = setInterval(() => this.tick(), 500);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  createRoom({ mode = 'ranked', code = null, id = null, ranked = mode === 'ranked', pairing = 'rating' }) {
    roomCounter += 1;
    const roomId = id || ('r_' + Date.now().toString(36) + '_' + roomCounter);
    const room = new Room({ id: roomId, mode, code, league: this.league, manager: this, ranked, pairing });
    this.rooms.set(roomId, room);
    return room;
  }

  listRooms() {
    return Array.from(this.rooms.values()).map((r) => ({
      roomId: r.id,
      mode: r.mode,
      code: r.code,
      status: r.status,
      ranked: r.ranked,
      pairing: r.pairing,
      matchId: r.current ? r.current.matchId : null,
      tick: r.current ? r.current.match.tick : 0,
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
    const room = this.rooms.get(roomId) || this.demo;
    room.spectators.add(conn);
    conn.meta.roomId = room.id;
    conn.send(this.snapshot(room));
    conn.onClose = () => room.spectators.delete(conn);
    return room;
  }

  joinAgent(conn, agent, { mode = 'ranked', code = null } = {}) {
    this.agentConns.set(agent.id, conn);
    conn.meta.roomId = null;
    conn.send({
      type: 'connected', agentId: agent.id, name: agent.name,
      versionHash: agent.versionHash, tickMs: CONFIG.TICK_MS,
      defaultAction: agent.defaultAction,
      mode,
      message: agent.source === 'hosted'
        ? 'Hosted strategy detected: the league will run your strategy server-side. No realtime connection needed.'
        : 'Queued. You will receive observe messages each tick; reply with act before deadlineMs.',
    });
    conn.onMessage = (msg) => { if (msg.type === 'act') this.onAct(conn, msg); };
    conn.onClose = () => this.onAgentDisconnect(conn);
    if (agent.source !== 'hosted') {
      // A prior MCP join_queue may already have queued this agent (e.g. with a
      // scrim code). Keep that entry and just attach the live connection.
      const existing = this.waiting.find((w) => w.agentId === agent.id);
      if (existing) existing.conn = conn;
      else this.enqueue({ agent, conn, mode, code });
    }
  }

  enqueue({ agent, conn = null, mode = 'ranked', code = null, auto = false }) {
    this.waiting = this.waiting.filter((w) => w.agentId !== agent.id);
    const entry = {
      agentId: agent.id, mode, code, conn, auto,
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

  createScrim(agent) {
    const room = this.createRoom({ mode: 'scrim', code: this.newCode(), ranked: false, pairing: 'code' });
    room.aAgent = agent;
    room.status = 'waiting';
    this.agentRoom.set(agent.id, room.id);
    this.waiting = this.waiting.filter((w) => w.agentId !== agent.id);
    this.waiting.push({ agentId: agent.id, mode: 'scrim', code: room.code, conn: null, joinedAt: Date.now(), track: agent.track, rating: agent.rating, source: agent.source });
    return room;
  }

  joinScrim(agent, code, conn = null) {
    const room = Array.from(this.rooms.values()).find((r) => r.mode === 'scrim' && r.code === code && r.status === 'waiting');
    if (!room) throw new Error('room not found or already started: ' + code);
    if (!room.aAgent || room.aAgent.id === agent.id) throw new Error('cannot join your own room');
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
    const pool = Array.from(this.league.agents.values()).filter((x) => x.source === 'builtin');
    if (!pool.length) return null;
    return pool.sort((x, y) => Math.abs(x.rating - agent.rating) - Math.abs(y.rating - agent.rating))[0];
  }

  matchmake() {
    const now = Date.now();
    const ranked = this.waiting.filter((w) => w.mode === 'ranked');
    const used = new Set();
    const byTrack = new Map();
    for (const w of ranked) {
      if (!byTrack.has(w.track)) byTrack.set(w.track, []);
      byTrack.get(w.track).push(w);
    }
    for (const group of byTrack.values()) {
      group.sort((a, b) => a.joinedAt - b.joinedAt);
      for (const w of group) {
        if (used.has(w.agentId)) continue;
        const agent = this.league.agents.get(w.agentId);
        if (!agent) { used.add(w.agentId); continue; }
        const mate = group.find((o) => o.agentId !== w.agentId && !used.has(o.agentId)
          && (Math.abs(o.rating - w.rating) <= 400 || now - Math.min(w.joinedAt, o.joinedAt) > 3000));
        if (mate) {
          const other = this.league.agents.get(mate.agentId);
          used.add(w.agentId); used.add(mate.agentId);
          if (other) this.startRoom(this.createRoom({ mode: 'ranked', ranked: true, pairing: 'rating' }), agent, other);
        } else if (now - w.joinedAt > 3000) {
          used.add(w.agentId);
          const spar = this.nearestSparring(agent);
          if (spar) this.startRoom(this.createRoom({ mode: 'ranked', ranked: true, pairing: 'sparring' }), agent, spar);
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
      if (room === this.demo || room.status !== 'finished' || !room.endedAt) continue;
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
      if (agent.source === 'hosted' && agent.autoRequeue !== false) {
        setTimeout(() => this.enqueue({ agent, mode: 'ranked', auto: true }), 3000);
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
    const rendered = renderReplay(parseReplay(text, matchId));
    this.renderCache.set(matchId, rendered);
    return rendered;
  }

  meta() { return this.demo.meta(); }

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
      queue: this.waiting.map((w) => ({
        agentId: w.agentId,
        mode: w.mode,
        source: w.source,
        waitingMs: Date.now() - w.joinedAt,
      })),
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
