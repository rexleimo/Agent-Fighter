/** Replay retention, store measurement and agent statistics capability. */
import fs from 'node:fs';
import path from 'node:path';
import { REPLAY_RETENTION } from '../costs.js';
import { DEFAULT_FIGHTER } from '../fighters.js';
import {
  isLadderCompetitor, isOfficialBaseline, OFFICIAL_NOMINAL_RATING,
  OFFICIAL_NOMINAL_RD, RETENTION_CHECK_EVERY,
} from './identity.js';
import { listJsonl, fileSizeOrZero, statOrNull, deleteIfExists } from './storage.js';

/** Replay store + per-agent stats. Reads shared state via `this`. */
export function createReplaysCapability() {
  return {
    /**
     * Keep at most `REPLAY_RETENTION` replay files, deleting the oldest first.
     * Returns what was removed so the number can be published instead of guessed.
     */
    pruneReplays({ keep = REPLAY_RETENTION } = {}) {
      const listed = listJsonl(this.replayDir);
      if (!listed.ok) return { removed: 0, kept: 0, retention: keep, protected: 0 };
      const entries = listed.entries;
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
        // A raced-away file is simply skipped; the next pass retries it.
        if (deleteIfExists(e.full)) removed += 1;
      }
      this.replaysPruned = (this.replaysPruned || 0) + removed;
      this._replayStore = null; // the count changed; re-measure on next look
      if (removed) {
        console.log(`[afl] replay retention: removed ${removed} oldest of ${entries.length} files (${protectedFiles} still referenced by the schedule), keeping ${keep}`);
      }
      return { removed, kept: entries.length - removed, retention: keep, protected: protectedFiles };
    },

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
      // A missing store (or a file that raced away while being measured) simply
      // does not contribute to the totals, as before.
      const listed = listJsonl(this.replayDir);
      const list = listed.ok ? listed.entries : [];
      files = list.length;
      for (const e of list) bytes += fileSizeOrZero(e.full);
      const value = { files, bytes, retention: REPLAY_RETENTION, written: this.replaysWritten || 0, pruned: this.replaysPruned || 0 };
      this._replayStore = { at: now, value };
      return value;
    },

    getReplay(matchId) {
      const file = path.join(this.replayDir, String(matchId).replace(/[^a-zA-Z0-9_-]/g, '') + '.jsonl');
      if (!fs.existsSync(file)) return null;
      return fs.readFileSync(file, 'utf8');
    },

    getAgentStats(agentId) {
      const a = this.agents.get(agentId);
      if (!a) return null;
      return {
        id: a.id, name: a.name, rating: Math.round(a.rating), rd: Math.round(a.rd),
        matches: a.matches || 0, wins: a.wins || 0, losses: a.losses || 0, draws: a.draws || 0,
        stalls: a.stalls || 0,
        practiceMatches: a.practiceMatches || 0,
        competitor: isLadderCompetitor(a), official: isOfficialBaseline(a),
        modelCalls: a.modelCalls, timeouts: a.timeouts,
        budgetExceeded: a.budgetExceeded || 0,
        fallback: a.fallback || 0,
        rejected: a.rejected || { stale_tick: 0, model_budget_exceeded: 0, action_locked: 0 },
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
    },
  };
}

// Backward-compatible export name for any direct importer of this internal module.
export const LeagueReplays = createReplaysCapability;
