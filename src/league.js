import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { BUILTIN_AGENTS, publicAgent } from './agents.js';
import { ACTIONS, CONFIG, MOVES, moveTotal } from './rules.js';
import { publicBoxData } from './combat.js';
import { OBSERVATION_JSON_SCHEMA } from './protocol.js';
import { serializeReplay } from './replay.js';
import { publicFighters, publicTeams, DEFAULT_FIGHTER, isValidFighter } from './fighters.js';
import { validateStrategy, strategyHash, strategyTemplate, simulateStrategy, describeDsl, DSL_VERSION } from './strategy-dsl.js';
import { normalizeTeam, TEAM_SIZE, TEAM_HEAL, TEAM_INTERMISSION_MS, TEAM_MAX_ROUNDS } from './team.js';
import { matchCost, costModel, REPLAY_RETENTION } from './costs.js';
import { stageFor, stageRef, stageModel } from './stages.js';
import { runTraining, compareStrategies, listDrills } from './training.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCALE = 173.7178;

// Official baselines are the league's own reference fighters: the four built-in
// rule policies and the hosted strategy demo. They exist to give every visitor
// a picture and every registrant an opponent. They are NOT competitors: they
// hold a fixed nominal rating, never appear on the ladder, and never take or
// give a ladder win.
export /** How often the replay store is measured against the retention limit. */
const RETENTION_CHECK_EVERY = 25;

const OFFICIAL_NOMINAL_RATING = 1500;
export const OFFICIAL_NOMINAL_RD = 350;

/** An agent owned by a registered player account: the only kind the ladder ranks. */
export function isLadderCompetitor(agent) {
  if (!agent) return false;
  if (agent.source === 'builtin' || agent.demo) return false;
  return Boolean(agent.playerId);
}

/** The league's own reference opponent. Fixed rating, exhibition only. */
export function isOfficialBaseline(agent) {
  return Boolean(agent) && !isLadderCompetitor(agent);
}

// Official baselines need a declared roster too: they run the always-on 3v3
// showcase room and stand in as sparring partners in the team queue. Their
// teams are shown as exhibition entries, never as ladder rows.
const BUILTIN_TEAMS = {
  brawler: ['ember', 'forge', 'basalt'],
  zoner: ['tide', 'gale', 'quartz'],
  turtle: ['basalt', 'quartz', 'noct'],
  random: ['volt', 'noct', 'gale'],
};

// Declared roster of the official hosted baseline, used by the 3v3 showcase room.
const BUILTIN_TEAMS_HOSTED = ['quartz', 'volt', 'ember'];

function nextSeason(season) {
  const n = Number(String(season || 'S1').replace(/^S/i, '')) || 1;
  return 'S' + (n + 1);
}

function cleanTeamName(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new Error('teamName must be a string');
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 32) throw new Error('teamName must be 2-32 characters');
  return name;
}

function g(phi) {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

function expected(mu, muj, phij) {
  return 1 / (1 + Math.exp(-g(phij) * (mu - muj)));
}

function updateVolatility(sigma, phi, v, delta) {
  const tau = 0.5;
  const a = Math.log(sigma * sigma);
  const phi2 = phi * phi;
  const d2 = delta * delta;
  const f = (x) => {
    const ex = Math.exp(x);
    const den = 2 * Math.pow(phi2 + v + ex, 2);
    return (ex * (d2 - phi2 - v - ex)) / den - (x - a) / (tau * tau);
  };
  let A = a;
  let B;
  if (d2 > phi2 + v) {
    B = Math.log(d2 - phi2 - v);
  } else {
    let k = 1;
    while (f(a - k * tau) < 0 && k < 100) k += 1;
    B = a - k * tau;
  }
  let fA = f(A);
  let fB = f(B);
  let iter = 0;
  while (Math.abs(B - A) > 1e-6 && iter < 100) {
    const C = A + ((A - B) * fA) / (fB - fA || 1e-12);
    const fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; } else { fA /= 2; }
    B = C;
    fB = fC;
    iter += 1;
  }
  return Math.exp(A / 2);
}

export function glicko2(player, opponent, score) {
  const mu = (player.rating - 1500) / SCALE;
  const phi = player.rd / SCALE;
  const muj = (opponent.rating - 1500) / SCALE;
  const phij = opponent.rd / SCALE;
  const e = expected(mu, muj, phij);
  const gj = g(phij);
  const v = 1 / Math.max(gj * gj * e * (1 - e), 1e-12);
  const delta = v * gj * (score - e);
  const sigmaP = updateVolatility(player.sigma || 0.06, phi, v, delta);
  const phiStar = Math.sqrt(phi * phi + sigmaP * sigmaP);
  const phiP = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muP = mu + phiP * phiP * gj * (score - e);
  return {
    rating: Math.round((SCALE * muP + 1500) * 10) / 10,
    rd: Math.min(350, Math.round(SCALE * phiP * 10) / 10),
    sigma: sigmaP,
  };
}

export class League {
  constructor({ dataDir } = {}) {
    this.dataDir = dataDir || (process.env.AFL_DATA_DIR ? path.resolve(process.env.AFL_DATA_DIR) : path.join(ROOT, 'data'));
    this.replayDir = path.join(this.dataDir, 'replays');
    fs.mkdirSync(this.replayDir, { recursive: true });
    this.agents = new Map();
    this.tokens = new Map();
    this.matches = [];
    // Replays written since boot / pruned by the retention pass - both published.
    this.replaysWritten = 0;
    this.replaysPruned = 0;
    this._replayStore = null;
    this.queue = [];
    this.locked = new Map(); // agentId -> matchId, strategy versions cannot change mid-match
    this.pairCursor = 0;
    this.season = 'S1';
    this.ladderStartedAt = null;
    this.load();
    if (this.agents.size === 0) this.seedBuiltins();
    this.enforceLadderIntegrity();
    let backfilled = false;
    for (const b of BUILTIN_AGENTS) {
      const a = this.agents.get(b.id);
      if (a && !a.team) { a.team = (BUILTIN_TEAMS[b.id] || ['quartz', 'volt', 'noct']).slice(); backfilled = true; }
    }
    if (backfilled) this.save();
  }

  load() {
    const file = path.join(this.dataDir, 'league.json');
    if (!fs.existsSync(file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.agents = new Map(raw.agents.map((a) => [a.id, a]));
      this.tokens = new Map(raw.agents.filter((a) => a.token).map((a) => [a.token, a.id]));
      this.matches = raw.matches || [];
      this.queue = raw.queue || [];
      this.pairCursor = raw.pairCursor || 0;
      this.season = raw.season || 'S1';
      this.ladderStartedAt = raw.ladderStartedAt || null;
    } catch { /* corrupted file: start clean */ }
  }

  /**
   * League files written before the players-only ladder rule carry two kinds of
   * unusable numbers: official baselines sitting on the ladder with thousands
   * of self-play matches, and player win counts that mix real opponents with
   * the official coach. Neither can be repaired from a 200-match log, so the
   * ladder restarts from zero and the old file is kept next to it.
   */
  enforceLadderIntegrity() {
    const contaminated = (this.matches || []).some((m) => (
      m.ranked !== false
      && m.ladder === undefined
      && (!isLadderCompetitor(this.agents.get(m.a && m.a.id)) || !isLadderCompetitor(this.agents.get(m.b && m.b.id)))
    )) || Array.from(this.agents.values()).some((a) => isOfficialBaseline(a) && (
      (a.matches || 0) > 0 || (a.wins || 0) > 0 || (a.history || []).length > 0
    ));
    if (!contaminated) return false;
    const file = path.join(this.dataDir, 'league.json');
    if (fs.existsSync(file)) {
      const backup = path.join(this.dataDir, 'league.pre-integrity.json');
      if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
    }
    for (const a of this.agents.values()) {
      Object.assign(a, {
        rating: OFFICIAL_NOMINAL_RATING, rd: OFFICIAL_NOMINAL_RD, sigma: 0.06,
        wins: 0, losses: 0, draws: 0, matches: 0, practiceMatches: 0,
        modelCalls: 0, timeouts: 0, avgDecisionMs: 0, history: [],
      });
    }
    this.matches = [];
    this.season = nextSeason(this.season);
    this.ladderStartedAt = new Date().toISOString();
    this.save();
    console.log('[afl] ladder integrity: pre-players-only records archived to ' + path.join(this.dataDir, 'league.pre-integrity.json') + '; season ' + this.season + ' starts from zero results');
    return true;
  }

  save() {
    const file = path.join(this.dataDir, 'league.json');
    const payload = {
      season: this.season,
      ladderStartedAt: this.ladderStartedAt,
      pairCursor: this.pairCursor,
      queue: this.queue,
      matches: this.matches.slice(-200),
      agents: Array.from(this.agents.values()),
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  }

  seedBuiltins() {
    for (const a of BUILTIN_AGENTS) {
      const record = {
        ...publicAgent(a),
        token: 'builtin-' + a.id,
        source: 'builtin',
        track: 'rule_only',
        defaultAction: 'block',
        rating: 1500,
        rd: 350,
        sigma: 0.06,
        wins: 0, losses: 0, draws: 0, matches: 0, practiceMatches: 0,
        modelCalls: 0, timeouts: 0, avgDecisionMs: 0,
        history: [],
        createdAt: new Date().toISOString(),
      };
      this.agents.set(a.id, record);
      this.tokens.set(record.token, a.id);
    }
    this.save();
  }

  /**
   * A built-in hosted-strategy baseline. It keeps the lobby honest: there is
   * always at least one ranked room running the MCP-only track, so visitors
   * can see concurrent rooms instead of an empty lobby. Idempotent across
   * restarts (fixed id + token, loaded from league.json).
   */
  ensureHostedDemo(strategyJson) {
    const id = 'demo_hosted';
    let agent = this.agents.get(id);
    if (!agent) {
      const s = validateStrategy(strategyJson);
      const hash = strategyHash(s);
      agent = {
        id,
        name: 'Hosted Baseline',
        label: '托管策略基线',
        kind: 'rule',
        track: 'rule_only',
        description: '官方托管策略演示：声明式 JSON 规则由服务端解释执行，无需常驻进程',
        fighterId: DEFAULT_FIGHTER,
        versionHash: hash.slice(0, 12),
        strategyHash: hash,
        strategyNote: s.name,
        token: 'builtin-demo-hosted',
        source: 'hosted',
        defaultAction: s.defaultAction,
        hostedStrategy: s,
        autoRequeue: false,
        demo: true,
        team: BUILTIN_TEAMS_HOSTED.slice(),
        teamName: '官方托管基队',
        rating: OFFICIAL_NOMINAL_RATING, rd: OFFICIAL_NOMINAL_RD, sigma: 0.06,
        wins: 0, losses: 0, draws: 0, matches: 0, practiceMatches: 0,
        modelCalls: 0, timeouts: 0, avgDecisionMs: 0,
        history: [],
        createdAt: new Date().toISOString(),
      };
      this.agents.set(id, agent);
      this.tokens.set(agent.token, id);
      this.save();
    }
    // Exhibition only: never requeued into the ranked ladder, never a competitor.
    agent.autoRequeue = false;
    agent.demo = true;
    if (!agent.team) agent.team = BUILTIN_TEAMS_HOSTED.slice();
    this.save();
    return agent;
  }

  registerAgent({ name, kind = 'rule', fighterId = DEFAULT_FIGHTER, source = 'external', team = null, teamName = null, playerId = null } = {}) {
    if (!name || typeof name !== 'string') throw new Error('name is required');
    if (!playerId) throw new Error('player login required: agents are created from a player account');
    const roster = team === null || team === undefined ? null : normalizeTeam(team);
    const id = 'usr_' + randomBytes(5).toString('hex');
    const token = 'ag_' + randomBytes(16).toString('hex');
    const versionHash = createHash('sha256').update(id + name).digest('hex').slice(0, 12);
    const record = {
      id,
      name: name.slice(0, 48),
      label: '我的 Agent',
      kind: ['rule', 'llm', 'hybrid'].includes(kind) ? kind : 'rule',
      track: kind === 'rule' ? 'rule_only' : 'open',
      description: source === 'hosted' ? '托管策略：由联赛服务端解释声明式规则' : '用户自带策略，通过 WebSocket 实时接入',
      fighterId: isValidFighter(fighterId) ? fighterId : DEFAULT_FIGHTER,
      team: roster,
      teamName: cleanTeamName(teamName),
      playerId: playerId || null,
      versionHash,
      token,
      source: source === 'hosted' ? 'hosted' : 'external',
      defaultAction: 'block',
      rating: 1500, rd: 350, sigma: 0.06,
      wins: 0, losses: 0, draws: 0, matches: 0, practiceMatches: 0,
      modelCalls: 0, timeouts: 0, avgDecisionMs: 0,
      history: [],
      createdAt: new Date().toISOString(),
    };
    this.agents.set(id, record);
    this.tokens.set(token, id);
    this.save();
    return { agentId: id, token, versionHash, note: 'Keep the token private. It authorizes every act message.' };
  }

  agentByToken(token) {
    const id = this.tokens.get(token);
    return id ? this.agents.get(id) : null;
  }

  agentById(agentId) {
    return this.agents.get(agentId) || null;
  }

  agentByPlayerId(playerId) {
    if (!playerId) return null;
    for (const agent of this.agents.values()) {
      if (agent.playerId === playerId) return agent;
    }
    return null;
  }

  /**
   * The one agent slot owned by a player account. Repeated calls return the
   * same identity and token, so an MCP service URL cannot silently create a
   * new agent every time the client reconnects.
   */
  ensurePlayerAgent({ playerId, name, source = 'hosted' } = {}) {
    if (!playerId) throw new Error('playerId is required');
    const existing = this.agentByPlayerId(playerId);
    if (existing) {
      let changed = false;
      const nextName = name ? String(name).slice(0, 48) : null;
      if (nextName && existing.name !== nextName) { existing.name = nextName; changed = true; }
      const nextSource = source === 'external' ? 'external' : 'hosted';
      if (existing.source !== nextSource) { existing.source = nextSource; changed = true; }
      if (changed) this.save();
      return {
        agentId: existing.id,
        token: existing.token,
        versionHash: existing.versionHash,
        team: existing.team || null,
        teamName: existing.teamName || null,
        source: existing.source,
        playerId,
        existing: true,
      };
    }
    const created = this.registerAgent({
      name,
      kind: 'rule',
      source: source === 'external' ? 'external' : 'hosted',
      playerId,
    });
    return {
      ...created,
      team: null,
      teamName: null,
      source: source === 'external' ? 'external' : 'hosted',
      playerId,
      existing: false,
    };
  }

  /** Declare or replace your 3-fighter roster. Required before join_queue(format='team'). */
  setTeam({ token, team, teamName } = {}) {
    const agent = this.agentByToken(token);
    if (!agent) throw new Error('invalid token');
    if (this.locked.has(agent.id)) {
      throw new Error('team is locked during match ' + this.locked.get(agent.id));
    }
    const nextName = cleanTeamName(teamName);
    if (nextName !== null) agent.teamName = nextName;
    agent.team = normalizeTeam(team);
    this.save();
    return {
      agentId: agent.id,
      team: agent.team.slice(),
      teamName: agent.teamName || null,
      note: 'Roster saved in entry order. Call join_queue with format="team" to enter ranked team matchmaking.',
    };
  }

  updateStrategy({ token, note = '', defaultAction, strategyHash } = {}) {
    const agent = this.agentByToken(token);
    if (!agent) throw new Error('invalid token');
    if (this.locked.has(agent.id)) {
      throw new Error('strategy is locked during match ' + this.locked.get(agent.id));
    }
    // strategyHash is the sha256 of YOUR local strategy files. The league never
    // receives your code; it only records this fingerprint against the replay.
    let hash = null;
    if (typeof strategyHash === 'string' && /^[a-f0-9]{8,64}$/i.test(strategyHash)) {
      hash = strategyHash.toLowerCase();
    } else if (strategyHash !== undefined && strategyHash !== null && strategyHash !== '') {
      throw new Error('strategyHash must be a hex sha256 (8-64 chars)');
    }
    const nextDefault = ACTIONS.includes(defaultAction) ? defaultAction : agent.defaultAction;
    const versionHash = createHash('sha256')
      .update(agent.id + '|' + (hash || '') + '|' + note + '|' + nextDefault)
      .digest('hex').slice(0, 12);
    agent.versionHash = versionHash;
    agent.strategyHash = hash;
    agent.strategyNote = String(note).slice(0, 200);
    agent.defaultAction = nextDefault;
    this.save();
    return {
      agentId: agent.id,
      versionHash,
      strategyHash: hash,
      defaultAction: nextDefault,
      note: 'Identical strategy files + note produce the same versionHash. Strategy changes are rejected while this agent is in a live match.',
    };
  }

  /** Hosted (MCP-only) strategy track: data in, server interprets it. */
  submitStrategy({ token, strategy, autoRequeue = true } = {}) {
    const agent = this.agentByToken(token);
    if (!agent) throw new Error('invalid token');
    if (this.locked.has(agent.id)) throw new Error('strategy is locked during match ' + this.locked.get(agent.id));
    const normalized = validateStrategy(strategy);
    const hash = strategyHash(normalized);
    const versionHash = hash.slice(0, 12);
    agent.hostedStrategy = normalized;
    agent.strategyHash = hash;
    agent.versionHash = versionHash;
    agent.strategyNote = normalized.name;
    agent.defaultAction = normalized.defaultAction;
    agent.source = 'hosted';
    agent.autoRequeue = Boolean(autoRequeue);
    this.save();
    return {
      agentId: agent.id,
      versionHash,
      strategyHash: hash,
      dsl: DSL_VERSION,
      name: normalized.name,
      rules: normalized.rules.length,
      defaultAction: normalized.defaultAction,
      source: 'hosted',
      autoRequeue: agent.autoRequeue,
      note: 'The league interprets this JSON locally. No code is executed and no WebSocket process is needed. Call join_queue to enter ranked matchmaking.',
    };
  }

  getStrategyTemplate() {
    return {
      dsl: DSL_VERSION,
      template: strategyTemplate(),
      syntax: describeDsl(),
      exampleFile: '/examples/hosted-agent/strategy.json',
      note: 'Edit template.rules, then call validate_strategy -> simulate_strategy -> submit_strategy.',
    };
  }

  validateStrategyTool({ strategy } = {}) {
    const normalized = validateStrategy(strategy);
    return { valid: true, dsl: DSL_VERSION, strategyHash: strategyHash(normalized), strategy: normalized };
  }

  simulateStrategyTool({ strategy, opponents, seeds } = {}) {
    // Real MCP clients sometimes send a scalar where the schema asks for an
    // array. Normalize instead of leaking "seeds.slice is not a function".
    const list = (value, cast, max) => {
      if (value === undefined || value === null) return null;
      const out = (Array.isArray(value) ? value : [value]).slice(0, max).map(cast).filter((x) => x !== null);
      return out.length ? out : null;
    };
    const opts = {};
    const opp = list(opponents, (x) => (typeof x === 'string' ? x : null), 4);
    const sd = list(seeds, (x) => (Number.isFinite(Number(x)) ? Number(x) : null), 5);
    if (opp) opts.opponents = opp;
    if (sd) opts.seeds = sd;
    return simulateStrategy(strategy, opts);
  }

  describeStrategyDsl() {
    return { dsl: DSL_VERSION, markdown: describeDsl() };
  }

  listFighters() {
    return publicFighters();
  }

  listTeams() {
    return publicTeams();
  }

  getMyMatches({ token, limit = 20 } = {}) {
    const agent = this.agentByToken(token);
    if (!agent) throw new Error('invalid token');
    const rows = this.matches.filter((m) => m.a.id === agent.id || m.b.id === agent.id).slice(-Math.min(Number(limit) || 20, 50)).reverse();
    return {
      agentId: agent.id,
      fighterId: agent.fighterId || DEFAULT_FIGHTER,
      source: agent.source,
      matches: rows.map((m) => {
        const side = m.a.id === agent.id ? 'a' : 'b';
        const other = side === 'a' ? m.b : m.a;
        const delta = side === 'a' ? m.ratingDeltaA : m.ratingDeltaB;
        return {
          matchId: m.matchId, roomId: m.roomId || null, mode: m.mode || 'ranked', ranked: m.ranked !== false,
          practice: Boolean(m.practice),
          // Why the record is what it is: 'sparring' and 'code' both have
          // ranked=false but mean different games, and a player reading their own
          // history cannot tell them apart without this field.
          pairing: m.pairing || null,
          // The arena, so a player reviewing their own history can tell which
          // stage a given match was fought on without re-downloading the replay.
          // Records written before stage tracking stay null: "we did not record
          // it" is the truth, and claiming the neutral arena would be a fact the
          // server never actually decided.
          stage: m.stage || null,
          format: m.format || 'single',
          side, opponent: other.name, opponentId: other.id,
          opponentOfficial: Boolean(m[side === 'a' ? 'b' : 'a'] && m[side === 'a' ? 'b' : 'a'].official),
          result: m.winner === 'draw' ? 'draw' : m.winner === side ? 'win' : 'loss',
          winner: m.winner, reason: m.reason,
          hp: side === 'a' ? m.hpA : m.hpB,
          ticks: m.ticks, ratingDelta: delta, endedAt: m.endedAt,
          fighters: m.fighters || null,
        };
      }),
    };
  }

  lockAgents(ids, matchId) {
    for (const id of ids) this.locked.set(id, matchId);
  }

  unlockAgents(ids) {
    for (const id of ids) this.locked.delete(id);
  }

  joinQueue({ token } = {}) {
    const agent = this.agentByToken(token);
    if (!agent) throw new Error('invalid token');
    if (!this.queue.includes(agent.id)) this.queue.push(agent.id);
    this.save();
    return { queued: true, position: this.queue.indexOf(agent.id) + 1, realtimePath: '/ws/agent?token=' + token };
  }

  leaveQueue(agentId) {
    this.queue = this.queue.filter((id) => id !== agentId);
  }

  pickNextPair() {
    // Exhibition rotation. It feeds the always-on demo rooms with official
    // baselines only; none of these results touch the ladder. The hosted
    // baseline is part of the rotation so the MCP-only track stays watchable.
    const hosted = this.agents.has('demo_hosted') ? 'demo_hosted' : null;
    const showcase = [
      ['brawler', 'zoner'], ['zoner', 'random'], ['brawler', 'random'],
      ['brawler', 'zoner'], ['turtle', 'random'], ['brawler', 'random'],
      ['zoner', 'random'], ['brawler', 'turtle'], ['brawler', 'zoner'],
      ['zoner', 'turtle'],
    ];
    if (hosted) {
      showcase.push([hosted, 'brawler'], [hosted, 'zoner'], [hosted, 'turtle'], [hosted, 'random']);
    }
    const pick = showcase[this.pairCursor % showcase.length];
    this.pairCursor += 1;
    let a = this.agents.get(pick[0]);
    let b = this.agents.get(pick[1]);
    if (!a || !b) {
      const pool = BUILTIN_AGENTS.map((x) => this.agents.get(x.id)).filter(Boolean);
      a = pool[0];
      b = pool[1] || pool[0];
    }
    return [a, b];
  }

  recordMatch({ matchId, agentA, agentB, result, replay, decisions, roomId = null, mode = 'ranked', ranked = true, fighters = null, format = 'single', team = null, pairing = null, stage = null, seed = null }) {
    // Ladder rule: a result touches the board only when two registered player
    // agents fought each other in a ranked room. Anything else - the demo
    // rotation, a scrim, or a match against an official baseline - is a real,
    // replayable game that buys no win, no rating and no board position.
    const compA = isLadderCompetitor(agentA);
    const compB = isLadderCompetitor(agentB);
    const roomRanked = ranked !== false;
    const ladder = roomRanked && compA && compB;
    const practice = roomRanked && !ladder;
    const counted = ladder;
    const scoreA = result.winner === 'a' ? 1 : result.winner === 'b' ? 0 : 0.5;
    const beforeA = { rating: agentA.rating, rd: agentA.rd, sigma: agentA.sigma };
    const beforeB = { rating: agentB.rating, rd: agentB.rd, sigma: agentB.sigma };
    let nextA = beforeA;
    let nextB = beforeB;
    if (counted) {
      nextA = glicko2(agentA, beforeB, scoreA);
      nextB = glicko2(agentB, beforeA, 1 - scoreA);
      Object.assign(agentA, nextA);
      Object.assign(agentB, nextB);
      agentA.matches += 1;
      agentB.matches += 1;
      if (result.winner === 'a') { agentA.wins += 1; agentB.losses += 1; }
      else if (result.winner === 'b') { agentB.wins += 1; agentA.losses += 1; }
      else { agentA.draws += 1; agentB.draws += 1; }
      const entry = { matchId, result: result.winner, reason: result.reason, rating: Math.round(agentA.rating) };
      agentA.history = [...(agentA.history || []), entry].slice(-40);
      agentB.history = [...(agentB.history || []), { ...entry, rating: Math.round(agentB.rating) }].slice(-40);
    } else {
      // Practice and exhibition games are counted separately so the board can
      // say where a game came from instead of hiding it.
      if (roomRanked) {
        if (compA) agentA.practiceMatches = (agentA.practiceMatches || 0) + 1;
        if (compB) agentB.practiceMatches = (agentB.practiceMatches || 0) + 1;
      }
      if (!compA) agentA.exhibitionMatches = (agentA.exhibitionMatches || 0) + 1;
      if (!compB) agentB.exhibitionMatches = (agentB.exhibitionMatches || 0) + 1;
    }

    // Cost accounting is unconditional: the compute happened whether or not the
    // result counts on the board. These are server-observed counters.
    const spend = (agent, stat) => {
      if (!stat) return;
      agent.modelCalls = (agent.modelCalls || 0) + (Number(stat.modelCalls) || 0);
      agent.timeouts = (agent.timeouts || 0) + (Number(stat.timeouts) || 0);
      agent.budgetExceeded = (agent.budgetExceeded || 0) + (Number(stat.budgetExceeded) || 0);
      if (agent.source === 'hosted') {
        agent.hostedTicksEvaluated = (agent.hostedTicksEvaluated || 0) + (Number(result.ticks) || 0);
      }
    };
    if (decisions) {
      spend(agentA, decisions.a);
      spend(agentB, decisions.b);
    }

    const side = (agent, fighterId, ratingBefore) => ({
      id: agent.id, name: agent.name, versionHash: agent.versionHash, kind: agent.kind,
      track: agent.track, source: agent.source, fighterId,
      ratingBefore,
      competitor: isLadderCompetitor(agent),
      official: isOfficialBaseline(agent),
    });

    const match = {
      matchId,
      season: this.season,
      startedAt: result.startedAt,
      endedAt: new Date().toISOString(),
      a: side(agentA, (fighters && fighters.a) || agentA.fighterId || DEFAULT_FIGHTER, Math.round(beforeA.rating)),
      b: side(agentB, (fighters && fighters.b) || agentB.fighterId || DEFAULT_FIGHTER, Math.round(beforeB.rating)),
      roomId,
      mode,
      pairing,
      // The arena this match was actually fought in, as declared by the room at
      // kickoff. Resolved through the registry so a stale or invented id cannot
      // reach a record and then fail to resolve in the client - and an
      // unresolvable id stays null ("not recorded") rather than being laundered
      // into a claim that the fight happened in the neutral arena.
      stage: stage && stageFor(stage) ? stageFor(stage).id : null,
      // The seed is part of what makes a match reproducible: stage selection
      // and every seed-driven layer read it. The replay file already carried
      // it; keeping it out of the record left two sources of truth for one
      // match, and the render endpoint (which reads the record) had none.
      seed: Number.isFinite(seed) ? seed >>> 0 : null,
      cost: matchCost({
        mode,
        ranked: counted,
        practice,
        sideA: { ...(decisions && decisions.a || {}), hosted: agentA.source === 'hosted', external: agentA.source === 'external' },
        sideB: { ...(decisions && decisions.b || {}), hosted: agentB.source === 'hosted', external: agentB.source === 'external' },
        ticks: result.ticks,
      }),
      format,
      team: team || null,
      ranked: counted,
      practice,
      fighters: fighters || { a: agentA.fighterId || DEFAULT_FIGHTER, b: agentB.fighterId || DEFAULT_FIGHTER },
      winner: result.winner,
      reason: result.reason,
      winnerName: result.winner === 'a' ? agentA.name : result.winner === 'b' ? agentB.name : 'draw',
      hpA: result.hpA,
      hpB: result.hpB,
      ticks: result.ticks,
      frame: result.frame,
      ratingDeltaA: counted ? Math.round((nextA.rating - beforeA.rating) * 10) / 10 : 0,
      ratingDeltaB: counted ? Math.round((nextB.rating - beforeB.rating) * 10) / 10 : 0,
      decisions: decisions || null,
    };
    this.matches.push(match);
    this.matches = this.matches.slice(-200);
    // Stamp the arena onto the replay object before it is written, so the file
    // is self-describing: serializeReplay only publishes fields it is given.
    if (replay) replay.stage = match.stage;
    const replayText = replay && replay.format === 'afl-team-replay/1'
      ? JSON.stringify(replay) + '\n'
      : serializeReplay(replay);
    fs.writeFileSync(path.join(this.replayDir, matchId + '.jsonl'), replayText, 'utf8');
    // Replays are the one cost item that grows on disk forever unless someone
    // prunes them. The published retention is enforced here, in batches, so the
    // claim in /api/costs is a fact and not an intention.
    this.replaysWritten += 1;
    if (this.replaysWritten % RETENTION_CHECK_EVERY === 0) this.pruneReplays();
    this.save();
    return match;
  }

  /**
   * The public ladder. Rows are registered player agents only: an official
   * baseline can never hold a board position, so nothing on this table is a
   * showcase number wearing a ranking. `track` filters within those rows.
   */
  getLeaderboard({ track } = {}) {
    const officials = Array.from(this.agents.values()).filter(isOfficialBaseline);
    const rows = Array.from(this.agents.values())
      .filter(isLadderCompetitor)
      .filter((a) => (track === 'open' || track === 'rule_only' ? a.track === track : true))
      .map((a) => ({
        rank: 0,
        id: a.id,
        name: a.name,
        label: a.label,
        kind: a.kind,
        track: a.track,
        source: a.source,
        versionHash: a.versionHash,
        fighterId: a.fighterId || DEFAULT_FIGHTER,
        team: a.team || null,
        teamName: a.teamName || null,
        rating: Math.round(a.rating),
        rd: Math.round(a.rd),
        matches: a.matches || 0,
        wins: a.wins || 0,
        losses: a.losses || 0,
        draws: a.draws || 0,
        practiceMatches: a.practiceMatches || 0,
        trainingRuns: a.trainingRuns || 0,
        winRate: a.matches ? Math.round((a.wins / a.matches) * 100) : null,
        cost: {
          modelCallsPerMatch: a.matches ? Math.round((a.modelCalls || 0) / a.matches) : 0,
          declaredModelCalls: a.modelCalls || 0,
          timeouts: a.timeouts || 0,
          budgetExceeded: a.budgetExceeded || 0,
          hostedTicksEvaluated: a.hostedTicksEvaluated || 0,
        },
      }))
      // Wins first: the ladder is "who won the most", rating only breaks ties.
      .sort((x, y) => y.wins - x.wins || y.rating - x.rating);
    rows.forEach((r, i) => { r.rank = i + 1; });
    return {
      season: this.season,
      ladderStartedAt: this.ladderStartedAt,
      rows,
      scope: 'registered-players',
      scopeNote: '榜单只统计已注册玩家 Agent 之间的排位战果：官方基线不在榜上，跟官方基线打的陪练局不计胜场不计分。',
      officials: officials.map((a) => ({
        id: a.id, name: a.name, source: a.source,
        rating: OFFICIAL_NOMINAL_RATING, rd: OFFICIAL_NOMINAL_RD,
        exhibitionMatches: a.exhibitionMatches || 0,
        // What the league spends to keep these watchable, never billed to anyone.
        cost: {
          hostedTicksEvaluated: a.hostedTicksEvaluated || 0,
          declaredModelCalls: a.modelCalls || 0,
        },
      })),
    };
  }

  getMatchResult(matchId) {
    return this.matches.find((m) => m.matchId === matchId) || null;
  }

  /**
   * Keep at most `REPLAY_RETENTION` replay files, deleting the oldest first.
   * Returns what was removed so the number can be published instead of guessed.
   */
  pruneReplays({ keep = REPLAY_RETENTION } = {}) {
    let entries;
    try {
      entries = fs.readdirSync(this.replayDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => {
          const full = path.join(this.replayDir, f);
          let mtimeMs = 0;
          try { mtimeMs = fs.statSync(full).mtimeMs; } catch { /* raced away */ }
          return { full, name: f, id: f.slice(0, -'.jsonl'.length), mtimeMs };
        });
    } catch { return { removed: 0, kept: 0, retention: keep, protected: 0 }; }
    // A match the league still presents must keep its replay, whatever the file
    // clock says. Without this guard, retention could delete the evidence behind
    // a live schedule row - a missing replay is exactly the fake data this
    // project exists to prevent.
    const referenced = new Set(this.matches.map((m) => m.matchId));
    const prunable = entries.filter((e) => !referenced.has(e.id));
    const protectedFiles = entries.length - prunable.length;
    const over = prunable.length - Math.max(0, keep);
    if (over <= 0) {
      return { removed: 0, kept: entries.length, retention: keep, protected: protectedFiles };
    }
    const oldest = prunable.sort((a, b) => a.mtimeMs - b.mtimeMs).slice(0, over);
    let removed = 0;
    for (const e of oldest) {
      try { fs.unlinkSync(e.full); removed += 1; } catch { /* next pass retries */ }
    }
    this.replaysPruned = (this.replaysPruned || 0) + removed;
    this._replayStore = null; // the count changed; re-measure on next look
    if (removed) {
      console.log(`[afl] replay retention: removed ${removed} oldest of ${entries.length} files (${protectedFiles} still referenced by the schedule), keeping ${keep}`);
    }
    return { removed, kept: entries.length - removed, retention: keep, protected: protectedFiles };
  }

  /**
   * What the replay store actually costs right now, measured, not estimated.
   * Measuring means stat-ing every file, so the number is cached: state polls
   * should not turn a 17k-file directory into per-request disk pressure.
   */
  replayStore({ maxAgeMs = 30_000 } = {}) {
    const now = Date.now();
    if (this._replayStore && now - this._replayStore.at < maxAgeMs) return this._replayStore.value;
    let files = 0;
    let bytes = 0;
    try {
      const list = fs.readdirSync(this.replayDir).filter((f) => f.endsWith('.jsonl'));
      files = list.length;
      for (const f of list) {
        try { bytes += fs.statSync(path.join(this.replayDir, f)).size; } catch { /* raced */ }
      }
    } catch { /* no store yet */ }
    const value = { files, bytes, retention: REPLAY_RETENTION, written: this.replaysWritten || 0, pruned: this.replaysPruned || 0 };
    this._replayStore = { at: now, value };
    return value;
  }

  getReplay(matchId) {
    const file = path.join(this.replayDir, String(matchId).replace(/[^a-zA-Z0-9_-]/g, '') + '.jsonl');
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf8');
  }

  getAgentStats(agentId) {
    const a = this.agents.get(agentId);
    if (!a) return null;
    return {
      id: a.id, name: a.name, rating: Math.round(a.rating), rd: Math.round(a.rd),
      matches: a.matches || 0, wins: a.wins || 0, losses: a.losses || 0, draws: a.draws || 0,
      practiceMatches: a.practiceMatches || 0,
      competitor: isLadderCompetitor(a), official: isOfficialBaseline(a),
      modelCalls: a.modelCalls, timeouts: a.timeouts,
      budgetExceeded: a.budgetExceeded || 0,
      hostedTicksEvaluated: a.hostedTicksEvaluated || 0,
      trainingRuns: a.trainingRuns || 0,
      versionHash: a.versionHash, strategyHash: a.strategyHash || null,
      strategyNote: a.strategyNote || '', defaultAction: a.defaultAction,
      source: a.source, fighterId: a.fighterId || DEFAULT_FIGHTER,
      team: a.team || null,
      hosted: Boolean(a.hostedStrategy),
      strategyName: a.hostedStrategy ? a.hostedStrategy.name : null,
      ruleCount: a.hostedStrategy ? a.hostedStrategy.rules.length : 0,
      autoRequeue: a.autoRequeue !== false,
      history: a.history || [],
    };
  }

  // ------------------------------------------------------------ 训练场 / 成本

  /** The published cost model: what is free, what the player pays, what we pay. */
  costModel() {
    return costModel();
  }

  /** Which arenas exist and how one is chosen - data, not prose. */
  stageModel() {
    return stageModel();
  }

  listDrills() {
    return listDrills();
  }

  /**
   * Run the training ground for one agent. Training never touches the ladder:
   * it writes a report file under data/training/ and returns it, and it does not
   * call recordMatch at all - so no wins, no rating, no board row, no queue slot.
   */
  runTrainingFor({ agent, strategy = null, drills, seeds, rounds, maxGames, fighterA } = {}) {
    const chosen = strategy || agent.hostedStrategy;
    if (!chosen) throw new Error('no strategy to train: submit one with submit_strategy, or pass strategy=...');
    const report = runTraining({ strategy: chosen, drills, seeds, rounds, maxGames, fighterA: fighterA || agent.fighterId });
    agent.trainingRuns = (agent.trainingRuns || 0) + 1;
    agent.trainingStrength = report.strengthIndex;
    this.saveTrainingRun(agent, report);
    return report;
  }

  /**
   * Same drills, same seeds, two versions. When strategyA is omitted the agent's
   * currently submitted version is the baseline, which is what "did my last edit
   * make it stronger" means in practice.
   */
  compareTraining({ agent, strategyB, strategyA = null, drills, seeds, rounds } = {}) {
    const a = strategyA || agent.hostedStrategy;
    if (!a || !strategyB) throw new Error('compare needs two strategies (and the agent must have one submitted)');
    return compareStrategies({ strategyA: a, strategyB, drills, seeds, rounds, fighterA: agent.fighterId });
  }

  trainingDir() {
    const dir = path.join(this.dataDir, 'training');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  saveTrainingRun(agent, report) {
    const file = path.join(this.trainingDir(), agent.id + '.json');
    let runs = [];
    try { runs = JSON.parse(fs.readFileSync(file, 'utf8')).runs || []; } catch { /* first run */ }
    runs.unshift({
      at: new Date().toISOString(),
      versionHash: report.versionHash,
      drills: report.drills,
      seeds: report.seeds,
      games: report.games,
      wins: report.wins,
      losses: report.losses,
      draws: report.draws,
      strengthIndex: report.strengthIndex,
      findings: report.findings.map((f) => ({ code: f.code, severity: f.severity, message: f.message })),
    });
    fs.writeFileSync(file, JSON.stringify({ agentId: agent.id, runs: runs.slice(0, 30) }, null, 2), 'utf8');
  }

  getTrainingHistory(agentId, { limit = 20 } = {}) {
    const file = path.join(this.trainingDir(), String(agentId).replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
    if (!fs.existsSync(file)) return { agentId, runs: [] };
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { agentId, runs: (raw.runs || []).slice(0, Math.min(Number(limit) || 20, 30)) };
  }

  getRules() {
    const moves = {};
    for (const [id, m] of Object.entries(MOVES)) {
      moves[id] = { ...m, totalFrames: moveTotal(id) };
    }
    const skills = ['special', 'ex', 'super'].map((id) => {
      const m = MOVES[id];
      return {
        id, label: m.label, meterCost: m.meterCost || 0,
        startup: m.startup, active: m.active, recovery: m.recovery,
        hitboxes: m.hitboxes.length, multiHit: Boolean(m.multiHit),
        cancelInto: m.cancelInto || [],
        note: id === 'super'
          ? 'Three separate active windows; each hitId can connect once. Costs one full 100-point bar.'
          : id === 'ex'
            ? 'Armored: absorbs one hit without hitstun. Costs 50 meter.'
            : 'Character signature move. Free, cancelable into super.',
      };
    });
    return {
      config: { ...CONFIG },
      actions: ACTIONS,
      moves,
      boxes: publicBoxData(),
      skills,
      team: {
        format: 'team',
        size: TEAM_SIZE,
        maxRounds: TEAM_MAX_ROUNDS,
        healOnRoundWin: TEAM_HEAL,
        intermissionMs: TEAM_INTERMISSION_MS,
        rules: [
          'Each side fields 3 distinct fighters in a chosen entry order.',
          'A round ends on KO or time up (higher hp wins). The round loser\'s fighter is eliminated; a drawn round eliminates both current fighters.',
          'The round winner\'s fighter recovers ' + TEAM_HEAL + ' hp (capped at ' + CONFIG.MAX_HP + ') and keeps its remaining hp and meter into the next round; benched fighters freeze.',
          'Between rounds each side may reorder its alive pool ONCE (head enters next); silence keeps the order. External agents reply team_order over WS, anyone can call set_team_order during the window.',
          'A side with no alive fighter loses the match; both empty at once is a draw.',
          'Ranked team: declare a roster with set_team (or register_agent team=...), then join_queue(format="team"). Matchmaking pairs same-track agents by nearest rating; results count on the wins-first leaderboard. Scrim/exhibition team rooms stay unranked.',
        ],
      },
      note: 'One decision tick = 6 render frames at 60fps. Hits are resolved by AABB overlap of skeleton-anchored hitboxes against skeleton-derived hurtboxes, NOT by a distance check. Standing block loses to low, crouch block loses to high/overhead, throws are unblockable. Cancel a landed move inside frameData.cancelInto. The kernel never waits: a late act falls back to defaultAction.',
    };
  }

  getObservationSchema() {
    return OBSERVATION_JSON_SCHEMA;
  }

  listAgents() {
    return Array.from(this.agents.values()).map((a) => ({
      id: a.id, name: a.name, label: a.label, kind: a.kind, track: a.track,
      source: a.source, versionHash: a.versionHash, description: a.description,
      fighterId: a.fighterId || DEFAULT_FIGHTER, team: a.team || null,
      teamName: a.teamName || null, hosted: Boolean(a.hostedStrategy),
      competitor: isLadderCompetitor(a), official: isOfficialBaseline(a),
    }));
  }

  recentMatches(limit = 20) {
    return this.matches.slice(-limit).reverse();
  }
}
