/** Cost/stage/drill surfaces, training runs and rules publication. */
import fs from 'node:fs';
import path from 'node:path';
import { ACTIONS, CONFIG, MOVES, moveTotal, defensiveRules } from '../rules.js';
import { publicBoxData } from '../combat.js';
import { OBSERVATION_JSON_SCHEMA } from '../protocol.js';
import { DEFAULT_FIGHTER } from '../fighters.js';
import { costModel } from '../costs.js';
import { stageModel } from '../stages.js';
import {
  TEAM_SIZE, TEAM_HEAL, TEAM_INTERMISSION_MS, TEAM_MAX_ROUNDS,
} from '../team.js';
import { runTraining, compareStrategies, listDrills } from '../training.js';
import { isLadderCompetitor, isOfficialBaseline } from './identity.js';
import { readTrainingRuns } from './storage.js';
import { LeagueReplays } from './class-replays.js';

export class LeagueTraining extends LeagueReplays {
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
    // No file yet (or an unreadable one): start an empty history, as before.
    const runs = readTrainingRuns(file);
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
      // The defensive layer published as data: 站防 / 蹲防 / 招架 / 闪避, what
      // each covers, what breaks it, and what the read is worth.
      defensive: defensiveRules(),
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
      note: 'One decision tick = 6 render frames at 60fps. Hits are resolved by AABB overlap of skeleton-anchored hitboxes against skeleton-derived hurtboxes, NOT by a distance check. Standing block loses to low, crouch block loses to high/overhead, throws are unblockable. The active layer on top of that: parry (招架) negates any blockable height and a projectile for 25 meter but is 16 punishable frames of nothing when it whiffs; dodge (闪避) is 10 invulnerable frames plus a 50-unit backstep for 15 meter, on a 30-frame cooldown, and a throw eats it. Cancel a landed move inside frameData.cancelInto. Neither defensive action can be canceled into, and an evaded or parried attack counts as a whiff for the attacker. The kernel never waits: a late act falls back to defaultAction.',
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

  /**
   * Player-facing replay feed. The public watch loop runs an always-on demo
   * room that records fully replayable builtin-vs-builtin exhibitions; those
   * belong on the archive, not in a list that reads as "the user's matches".
   * A match is a player match when at least one side was a registered player
   * agent (recordMatch stamps `competitor` from isLadderCompetitor).
   */
  recentPlayerMatches(limit = 20) {
    const playerMatches = this.matches.filter((m) => m.a?.competitor === true || m.b?.competitor === true);
    return playerMatches.slice(-limit).reverse();
  }
}
