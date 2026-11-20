/** Agent identity, roster/strategy submission and public read surfaces capability. */
import { randomBytes, createHash } from 'node:crypto';
import { ACTIONS, CONFIG } from '../rules.js';
import {
  publicFighters, publicTeams, DEFAULT_FIGHTER, isValidFighter,
} from '../fighters.js';
import {
  validateStrategy, lintStrategy, strategyHash, strategyTemplate, strategyTemplates,
  simulateStrategy, describeDsl, DSL_VERSION,
} from '../strategy-dsl.js';
import { normalizeTeam } from '../team.js';
import { cleanTeamName } from './identity.js';

/** Agent identity + submission. Operates on the shared league state via `this`. */
export function createAgentsCapability() {
  return {
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
        defaultAction: CONFIG.DEFAULT_ACTION,
        rating: 1500, rd: 350, sigma: 0.06,
        wins: 0, losses: 0, draws: 0, stalls: 0, matches: 0, practiceMatches: 0,
        modelCalls: 0, timeouts: 0, avgDecisionMs: 0,
        history: [],
        createdAt: new Date().toISOString(),
      };
      this.agents.set(id, record);
      this.tokens.set(token, id);
      this.save();
      return { agentId: id, token, versionHash, note: 'Keep the token private. It authorizes every act message.' };
    },

    agentByToken(token) {
      const id = this.tokens.get(token);
      return id ? this.agents.get(id) : null;
    },

    agentById(agentId) {
      return this.agents.get(agentId) || null;
    },

    agentByPlayerId(playerId) {
      if (!playerId) return null;
      for (const agent of this.agents.values()) {
        if (agent.playerId === playerId) return agent;
      }
      return null;
    },

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
    },

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
    },

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
    },

    /** Hosted (MCP-only) strategy track: data in, server interprets it. */
    submitStrategy({ token, strategy, autoRequeue = true } = {}) {
      const agent = this.agentByToken(token);
      if (!agent) throw new Error('invalid token');
      if (this.locked.has(agent.id)) throw new Error('strategy is locked during match ' + this.locked.get(agent.id));
      const normalized = validateStrategy(strategy);
      const lint = lintStrategy(normalized, agent.fighterId);
      // A locked action is a hard error: the fighter physically cannot use it.
      if (lint.errors.length) {
        throw new Error('strategy uses actions locked for this fighter: ' + lint.errors.map((e) => e.message).join('; '));
      }
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
        warnings: lint.warnings,
        source: 'hosted',
        autoRequeue: agent.autoRequeue,
        note: 'The league interprets this JSON locally. No code is executed and no WebSocket process is needed. Call join_queue to enter ranked matchmaking.',
      };
    },

    getStrategyTemplate() {
      return {
        dsl: DSL_VERSION,
        template: strategyTemplate(),
        templates: strategyTemplates(),
        syntax: describeDsl(),
        exampleFile: '/examples/hosted-agent/strategy.json',
        note: 'Edit template.rules, then call validate_strategy -> simulate_strategy -> submit_strategy.',
      };
    },

    validateStrategyTool({ strategy } = {}) {
      const normalized = validateStrategy(strategy);
      const lint = lintStrategy(normalized);
      return { valid: true, dsl: DSL_VERSION, strategyHash: strategyHash(normalized), strategy: normalized, warnings: lint.warnings, errors: lint.errors };
    },

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
    },

    describeStrategyDsl() {
      return { dsl: DSL_VERSION, markdown: describeDsl() };
    },

    listFighters() {
      return publicFighters();
    },

    listTeams() {
      return publicTeams();
    },
  };
}

// Backward-compatible export name for any direct importer of this internal module.
export const LeagueAgents = createAgentsCapability;
