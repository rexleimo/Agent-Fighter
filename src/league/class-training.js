/** Cost/stage/drill surfaces, training runs and rules publication capability. */
import fs from 'node:fs';
import path from 'node:path';
import { ACTIONS, CONFIG, MOVES, moveTotal, defensiveRules, antiStallRules, moveFor, mechanicsOf } from '../rules.js';
import { ARCHETYPES, FIGHTER_KITS, FIGHTER_KIT_IDS, lockedActions, actionAvailable } from '../kits/index.js';
import { publicBoxData, predictsHit } from '../combat.js';
import { OBSERVATION_JSON_SCHEMA } from '../protocol.js';
import { DEFAULT_FIGHTER, getFighter } from '../fighters.js';
import { costModel } from '../costs.js';
import { stageModel } from '../stages.js';
import {
  TEAM_SIZE, TEAM_HEAL, TEAM_INTERMISSION_MS, TEAM_MAX_ROUNDS,
} from '../team.js';
import { runTraining, compareStrategies, listDrills } from '../training.js';
import { isLadderCompetitor, isOfficialBaseline } from './identity.js';
import { readTrainingRuns } from './storage.js';

/**
 * Authoritative reach table, measured from the SAME box model the kernel uses
 * to resolve hits (predictsHit), not the scalar `range` hint — which understates
 * real reach (e.g. hk range=176 but actually connects out to ~206). Published
 * so an agent can learn true per-move reach from get_rules() alone.
 */
function buildReachTable() {
  const probe = { ...getFighter(DEFAULT_FIGHTER), fighterId: DEFAULT_FIGHTER, x: 300, facing: 1, y: 0, vy: 0, vx: 0, state: 'idle', moveId: null, moveFrame: 0, hasHit: false, spentHit: false, hitIds: [], spentHitIds: [], hitstun: 0, blockstun: 0 };
  const out = {};
  for (const [id, m] of Object.entries(MOVES)) {
    if (!m.range) continue;
    let maxHit = -1;
    for (let d = 20; d <= 900; d += 2) {
      const def = { ...probe, fighterId: DEFAULT_FIGHTER, x: 300 + d, facing: -1, state: 'idle', moveId: null };
      if (predictsHit(probe, def, id)) maxHit = d;
    }
    out[id] = maxHit;
  }
  return out;
}
const REACH_TABLE = buildReachTable();

/**
 * Per-archetype gameplans, published as data so a model can map its OWN
 * observation.kit.archetype to a concrete fighting plan. The mechanics come
 * from the real move data, so this table cannot drift from the kernel.
 */
const ARCHETYPE_GAMEPLAN = Object.freeze({
  rush: {
    style: '突进压制',
    ranges: 'close-range',
    plan: 'Your special is an advancing strike with a forward dash — use it as a gap-closer and hit-confirm at mid/close range; it knocks down. You cannot fireball. Walk_f/dash in, then special/hp. Reward is highest the closer you are.',
    uses: ['special 前冲命中即倒', '近身 hp/throw', '无 fireball，靠 dash 接近'],
  },
  volley: {
    style: '波动牵制',
    ranges: 'mid/long-range',
    plan: 'Your special is a projectile — control space from mid/long range with fireball and special. If the opponent gets close (distanceX small), stop zoning: walk_b to create space or throw/dp to punish. In single-ladder you may be mirrored.',
    uses: ['中远距 fireball/special 牵制', 'EX 连发', '被贴身改 walk_b 或 throw'],
  },
  counter: {
    style: '当身反击',
    ranges: 'close-range',
    plan: 'Your special is a counter stance: it absorbs ONE melee hit and returns fixed damage, but is useless vs projectiles and throws. Use it when you read the opponent committing to a melee attack at close range. You cannot fireball. Bait a hit, counter, then punish.',
    uses: ['近身读招用 special 当身', '对波动/投技无效，别乱用', '无 fireball'],
  },
  antiAir: {
    style: '升龙对空',
    ranges: 'close-range / anti-air',
    plan: 'Your special is an invulnerable rising uppercut (launcher): use it to beat jump-ins and as a wakeup reversal. It has real startup invulnerability but is heavily punishable if it whiffs. You cannot fireball. Save it for anti-air or a hard read, not random neutral.',
    uses: ['对空/起身用 special 升龙', '空挥会被重罚', '无 fireball'],
  },
  multi: {
    style: '多段连击',
    ranges: 'mid-range',
    plan: 'Your special has multiple hit segments and the widest cancel window: use it as a hit-confirm starter, then cancel into the strongest follow-up (special -> super). Single hits are weak but the full string hurts. You KEEP fireball. Prioritize landing the multi-hit and chaining.',
    uses: ['special 多段起手命中确认', '命中后取消接 super', '可用 fireball'],
  },
});

/** True reach of each character's special/ex/super, measured from the box model. */
function buildFighterReach() {
  const out = {};
  for (const fid of FIGHTER_KIT_IDS) {
    const kit = FIGHTER_KITS[fid];
    const skills = {};
    for (const action of ['special', 'ex', 'super']) {
      const m = moveFor({ fighterId: fid }, action);
      let maxHit = -1;
      for (let d = 20; d <= 900; d += 2) {
        const a = { ...getFighter(fid), fighterId: fid, x: 300, facing: 1, y: 0, vy: 0, vx: 0, state: 'idle', moveId: null, moveFrame: 0, hasHit: false, spentHit: false, hitIds: [], spentHitIds: [], hitstun: 0, blockstun: 0 };
        const def = { ...a, fighterId: DEFAULT_FIGHTER, x: 300 + d, facing: -1 };
        if (predictsHit(a, def, action)) maxHit = d;
      }
      skills[action] = { label: m.label, mechanics: mechanicsOf(m), hintRange: m.range || 0, trueReach: maxHit };
    }
    out[fid] = { fighterId: fid, archetype: kit.archetype, label: kit.label, skills };
  }
  return out;
}
const FIGHTER_REACH = buildFighterReach();

/** Training ground + public reference-data surface. Reads shared state via `this`. */
export function createTrainingCapability() {
  return {
    // ------------------------------------------------------------ 训练场 / 成本

    /** The published cost model: what is free, what the player pays, what we pay. */
    costModel() {
      return costModel();
    },

    /** Which arenas exist and how one is chosen - data, not prose. */
    stageModel() {
      return stageModel();
    },

    listDrills() {
      return listDrills();
    },

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
    },

    /**
     * Same drills, same seeds, two versions. When strategyA is omitted the agent's
     * currently submitted version is the baseline, which is what "did my last edit
     * make it stronger" means in practice.
     */
    compareTraining({ agent, strategyB, strategyA = null, drills, seeds, rounds } = {}) {
      const a = strategyA || agent.hostedStrategy;
      if (!a || !strategyB) throw new Error('compare needs two strategies (and the agent must have one submitted)');
      return compareStrategies({ strategyA: a, strategyB, drills, seeds, rounds, fighterA: agent.fighterId });
    },

    trainingDir() {
      const dir = path.join(this.dataDir, 'training');
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },

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
    },

    getTrainingHistory(agentId, { limit = 20 } = {}) {
      const file = path.join(this.trainingDir(), String(agentId).replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
      if (!fs.existsSync(file)) return { agentId, runs: [] };
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { agentId, runs: (raw.runs || []).slice(0, Math.min(Number(limit) || 20, 30)) };
    },

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
        // rules 2.2: passivity thresholds and the four-level time-up chain.
        antiStall: antiStallRules(),
        // Per-fighter action availability (data, not prose). `availableActions`
        // is the exact array the observation publishes; a locked action can
        // still return frame data from moveFor but never starts a move.
        fighterActions: Object.fromEntries(Object.keys(FIGHTER_KITS).map((id) => [id, {
          archetype: FIGHTER_KITS[id].archetype,
          availableActions: ACTIONS.filter((a) => actionAvailable(id, a)),
          lockedActions: lockedActions(id).slice(),
        }])),
        reach: {
          note: 'derived.inRange.{move} is THE authoritative, per-frame hit test from the real hitbox/hurtbox AABBs (predictsHit). It is recomputed every frame from the CURRENT distance and the live poses of both fighters. The range field in the move table is only a loose hint and UNDERSTATES real reach (e.g. hk range=176 but connects out to ~206).',
          // True maximum horizontal center-to-center distance (px) at which
          // each move actually connects, measured from the box model. Only use
          // inRange[move] to decide — this table is context/education only.
          trueReachDist: REACH_TABLE,
          rules: [
            'NEVER decide reach from distanceX and the range hint: range is not the hit distance and inRange is not a linear function of distance.',
            'inRange is fetched fresh each decision tick. Do NOT reuse an inRange value from an earlier tick — after walking, the old value is stale and will cause a whiff (attacking when now out of range) or a missed punish (walking when now in range).',
            'Only throw move X when inRange.X is true ON THIS TICK. If it is false, do not attack that move: walk_f to close, or fireball if derived.inRange.fireball is true.',
            'If you had to walk several ticks to close distance, RE-READ inRange before attacking: the move that was out of range 5 ticks ago may now connect, and the move that connected 5 ticks ago may now whiff.',
          ],
        },
        // Role data: your fighter's archetype and skills should SHAPE your plan.
        // Read observation.kit.archetype, then apply the matching gameplan below.
        fighters: {
          playstyles: ARCHETYPE_GAMEPLAN,
          skillReach: FIGHTER_REACH,
          rule: 'Read observation.kit.archetype and follow that archetype gameplan. Your special/ex/super are NOT interchangeable across fighters — use each character trueReach and mechanics from skillReach, and only fire special/ex/super when inRange[that action] is true this tick.',
        },
        // Reward + offensive discipline are published as data so every agent,
        // not just one wrapped prompt, knows how the ladder scores and how to
        // avoid whiffing / waiting instead of fighting to win.
        scoring: {
          source: 'registered player ranked matches only',
          currency: 'wins',
          rule: 'Win more, earn more. Each win adds one win, raises Glicko-2 rating and lifts leaderboard rank (wins first, rating second).',
          win: 'full reward: +1 win, rating up, rank up',
          draw: 'A KO double-knockdown is the only real draw. At time up, equal HP is settled by damage dealt then aggression; if still equal BOTH sides lose (double_loss).',
          loss: 'no reward',
          caution: '3 passive seconds earn a warning; after 5 seconds you lose 20 HP every second and gift the opponent 10 meter. Passive blocking concedes the win and forfeits the reward.',
        },
        offense: {
          neverWhiff: 'Only attack when the inRange flag for that exact move is true. Out of range: walk_f to close or fireball to zone - never punch empty air.',
          whiffRecovery: 'A whiff costs recovery and gives the opponent a free punish. If the last attack in history did not connect (no opponent.hitstun, no boxOverlap), do not repeat it - reposition instead.',
          combos: 'When canCancelInto is non-empty and the attack connected, cancel immediately into the strongest listed follow-up (hp > mp > lp). Do not stand and wait after a hit.',
          resume: 'While frameData.phase is startup/active/recovery you must wait it out; the instant self.actionable is true, resume offense using the range rules.',
          defense: 'Defense is three choices: block / parry / dodge. Read the opponent with derived.incomingHit and derived.incomingProjectileIn, then punish with derived.opponentRecoveryLeft. Throw breaks both dodge and parry. Counterattack the moment you are actionable again.',
        },
        team: {
          format: 'team',
          size: TEAM_SIZE,
          maxRounds: TEAM_MAX_ROUNDS,
          healOnRoundWin: TEAM_HEAL,
          intermissionMs: TEAM_INTERMISSION_MS,
          rules: [
            'Each side fields 3 distinct fighters in a chosen entry order.',
            'A round ends on KO or time up (higher hp wins, then damage, then aggression; still equal = double_loss). The round loser\'s fighter is eliminated; a draw or double_loss eliminates both current fighters.',
            'The round winner\'s fighter recovers ' + TEAM_HEAL + ' hp (capped at ' + CONFIG.MAX_HP + ') and keeps its remaining hp and meter into the next round; benched fighters freeze.',
            'Between rounds each side may reorder its alive pool ONCE (head enters next); silence keeps the order. External agents reply team_order over WS, anyone can call set_team_order during the window.',
            'A side with no alive fighter loses the match; both empty at once is a draw.',
            'Ranked team: declare a roster with set_team (or register_agent team=...), then join_queue(format="team"). Matchmaking pairs same-track agents by nearest rating; results count on the wins-first leaderboard. Scrim/exhibition team rooms stay unranked.',
          ],
        },
        note: 'One decision tick = 6 render frames at 60fps. Hits are resolved by AABB overlap of skeleton-anchored hitboxes against skeleton-derived hurtboxes, NOT by a distance check. Standing block loses to low, crouch block loses to high/overhead, throws are unblockable. The active layer on top of that: parry (招架) negates any blockable height and a projectile for 25 meter but is 16 punishable frames of nothing when it whiffs; dodge (闪避) is 10 invulnerable frames plus a 50-unit backstep for 15 meter, on a 30-frame cooldown, and a throw eats it. Cancel a landed move inside frameData.cancelInto. Neither defensive action can be canceled into, and an evaded or parried attack counts as a whiff for the attacker. The kernel never waits: a late act falls back to defaultAction.',
      };
    },

    getObservationSchema() {
      return OBSERVATION_JSON_SCHEMA;
    },

    listAgents() {
      return Array.from(this.agents.values()).map((a) => ({
        id: a.id, name: a.name, label: a.label, kind: a.kind, track: a.track,
        source: a.source, versionHash: a.versionHash, description: a.description,
        fighterId: a.fighterId || DEFAULT_FIGHTER, team: a.team || null,
        teamName: a.teamName || null, hosted: Boolean(a.hostedStrategy),
        competitor: isLadderCompetitor(a), official: isOfficialBaseline(a),
      }));
    },

    recentMatches(limit = 20) {
      return this.matches.slice(-limit).reverse();
    },

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
    },
  };
}

// Backward-compatible export name for any direct importer of this internal module.
export const LeagueTraining = createTrainingCapability;
