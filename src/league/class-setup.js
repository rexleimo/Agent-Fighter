/** League bootstrap capability: shared state, persistence and builtin seeding. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_AGENTS, publicAgent } from '../agents.js';
import { validateStrategy, strategyHash } from '../strategy-dsl.js';
import { DEFAULT_FIGHTER } from '../fighters.js';
import {
  OFFICIAL_NOMINAL_RATING, OFFICIAL_NOMINAL_RD, BUILTIN_TEAMS,
  BUILTIN_TEAMS_HOSTED, nextSeason, isLadderCompetitor, isOfficialBaseline,
} from './identity.js';
import { readLeagueState } from './storage.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Bootstrap + persistence capability. `init` runs once at construction and
 * fills the shared state object that every other league capability reads and
 * writes. All methods operate on `this`, so cross-capability calls keep their
 * original shape without an inheritance chain or forwarding wrappers.
 */
export function createSetupCapability() {
  return {
    init({ dataDir } = {}) {
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
        if (!a) {
          // A builtin added after this league.json was first written (e.g. the
          // exhibition duelists): materialise its record so demo rooms can use it.
          const record = {
            ...publicAgent(b),
            token: 'builtin-' + b.id,
            source: 'builtin',
            track: 'rule_only',
            defaultAction: b.defaultAction || 'block',
            rating: 1500, rd: 350, sigma: 0.06,
            wins: 0, losses: 0, draws: 0, matches: 0, practiceMatches: 0,
            modelCalls: 0, timeouts: 0, avgDecisionMs: 0,
            history: [], createdAt: new Date().toISOString(),
          };
          this.agents.set(b.id, record);
          this.tokens.set(record.token, b.id);
          backfilled = true;
          continue;
        }
        if (!a.team) { a.team = (BUILTIN_TEAMS[b.id] || ['quartz', 'volt', 'noct']).slice(); backfilled = true; }
      }
      if (backfilled) this.save();
    },

    load() {
      const file = path.join(this.dataDir, 'league.json');
      // A missing or corrupted file leaves the freshly constructed empty state
      // in place, exactly as the old catch did.
      const loaded = readLeagueState(file);
      if (!loaded.ok) return;
      const raw = loaded.value;
      this.agents = new Map(raw.agents.map((a) => [a.id, a]));
      this.tokens = new Map(raw.agents.filter((a) => a.token).map((a) => [a.token, a.id]));
      this.matches = raw.matches || [];
      this.queue = raw.queue || [];
      this.pairCursor = raw.pairCursor || 0;
      this.season = raw.season || 'S1';
      this.ladderStartedAt = raw.ladderStartedAt || null;
    },

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
    },

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
    },

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
    },

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
    },
  };
}

// Backward-compatible export name for any direct importer of this internal module.
export const LeagueSetup = createSetupCapability;
