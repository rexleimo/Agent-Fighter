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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCALE = 173.7178;

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
    this.queue = [];
    this.locked = new Map(); // agentId -> matchId, strategy versions cannot change mid-match
    this.pairCursor = 0;
    this.season = 'S1';
    this.load();
    if (this.agents.size === 0) this.seedBuiltins();
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
    } catch { /* corrupted file: start clean */ }
  }

  save() {
    const file = path.join(this.dataDir, 'league.json');
    const payload = {
      season: this.season,
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
        wins: 0, losses: 0, draws: 0, matches: 0,
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
        autoRequeue: true,
        demo: true,
        rating: 1500, rd: 350, sigma: 0.06,
        wins: 0, losses: 0, draws: 0, matches: 0,
        modelCalls: 0, timeouts: 0, avgDecisionMs: 0,
        history: [],
        createdAt: new Date().toISOString(),
      };
      this.agents.set(id, agent);
      this.tokens.set(agent.token, id);
      this.save();
    }
    agent.autoRequeue = true;
    return agent;
  }

  registerAgent({ name, kind = 'rule', fighterId = DEFAULT_FIGHTER, source = 'external', team = null } = {}) {
    if (!name || typeof name !== 'string') throw new Error('name is required');
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
      versionHash,
      token,
      source: source === 'hosted' ? 'hosted' : 'external',
      defaultAction: 'block',
      rating: 1500, rd: 350, sigma: 0.06,
      wins: 0, losses: 0, draws: 0, matches: 0,
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
          side, opponent: other.name, opponentId: other.id,
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
    // Matchmaking for external/hosted agents belongs to RoomManager. This
    // rotation only feeds the always-on demo room with built-in agents.
    const showcase = [
      ['brawler', 'zoner'], ['zoner', 'random'], ['brawler', 'random'],
      ['brawler', 'zoner'], ['turtle', 'random'], ['brawler', 'random'],
      ['zoner', 'random'], ['brawler', 'turtle'], ['brawler', 'zoner'],
      ['zoner', 'turtle'],
    ];
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

  recordMatch({ matchId, agentA, agentB, result, replay, decisions, roomId = null, mode = 'ranked', ranked = true, fighters = null, format = 'single', team = null }) {
    const counted = ranked !== false;
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
      if (decisions) {
        agentA.modelCalls += decisions.a.modelCalls || 0;
        agentB.modelCalls += decisions.b.modelCalls || 0;
        agentA.timeouts += decisions.a.timeouts || 0;
        agentB.timeouts += decisions.b.timeouts || 0;
      }
      const entry = { matchId, result: result.winner, reason: result.reason, rating: Math.round(agentA.rating) };
      agentA.history = [...(agentA.history || []), entry].slice(-40);
      agentB.history = [...(agentB.history || []), { ...entry, rating: Math.round(agentB.rating) }].slice(-40);
    }

    const match = {
      matchId,
      season: this.season,
      startedAt: result.startedAt,
      endedAt: new Date().toISOString(),
      a: { id: agentA.id, name: agentA.name, versionHash: agentA.versionHash, kind: agentA.kind, track: agentA.track, source: agentA.source, fighterId: (fighters && fighters.a) || agentA.fighterId || DEFAULT_FIGHTER, ratingBefore: Math.round(beforeA.rating) },
      b: { id: agentB.id, name: agentB.name, versionHash: agentB.versionHash, kind: agentB.kind, track: agentB.track, source: agentB.source, fighterId: (fighters && fighters.b) || agentB.fighterId || DEFAULT_FIGHTER, ratingBefore: Math.round(beforeB.rating) },
      roomId,
      mode,
      format,
      team: team || null,
      ranked: counted,
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
    const replayText = replay && replay.format === 'afl-team-replay/1'
      ? JSON.stringify(replay) + '\n'
      : serializeReplay(replay);
    fs.writeFileSync(path.join(this.replayDir, matchId + '.jsonl'), replayText, 'utf8');
    this.save();
    return match;
  }

  getLeaderboard({ track } = {}) {
    const rows = Array.from(this.agents.values())
      .filter((a) => (track === 'rule_only' ? a.track === 'rule_only' : true))
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
        rating: Math.round(a.rating),
        rd: Math.round(a.rd),
        matches: a.matches,
        wins: a.wins,
        losses: a.losses,
        draws: a.draws,
        winRate: a.matches ? Math.round((a.wins / a.matches) * 100) : 0,
        modelCallsPerMatch: a.matches ? Math.round(a.modelCalls / a.matches) : 0,
        timeouts: a.timeouts,
      }))
      .sort((x, y) => y.rating - x.rating || y.wins - x.wins);
    rows.forEach((r, i) => { r.rank = i + 1; });
    return { season: this.season, rows };
  }

  getMatchResult(matchId) {
    return this.matches.find((m) => m.matchId === matchId) || null;
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
      matches: a.matches, wins: a.wins, losses: a.losses, draws: a.draws,
      modelCalls: a.modelCalls, timeouts: a.timeouts,
      versionHash: a.versionHash, strategyHash: a.strategyHash || null,
      strategyNote: a.strategyNote || '', defaultAction: a.defaultAction,
      source: a.source, fighterId: a.fighterId || DEFAULT_FIGHTER,
      hosted: Boolean(a.hostedStrategy),
      strategyName: a.hostedStrategy ? a.hostedStrategy.name : null,
      ruleCount: a.hostedStrategy ? a.hostedStrategy.rules.length : 0,
      autoRequeue: a.autoRequeue !== false,
      history: a.history || [],
    };
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
          'A side with no alive fighter loses the match; both empty at once is a draw. Team matches are unranked.',
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
      fighterId: a.fighterId || DEFAULT_FIGHTER, hosted: Boolean(a.hostedStrategy),
    }));
  }

  recentMatches(limit = 20) {
    return this.matches.slice(-limit).reverse();
  }
}
