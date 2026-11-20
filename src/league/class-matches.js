/** Match recording, ladder updates and leaderboard publication. */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_FIGHTER } from '../fighters.js';
import { matchCost } from '../costs.js';
import { stageFor } from '../stages.js';
import { serializeReplay } from '../replay.js';
import {
  isLadderCompetitor, isOfficialBaseline, glicko2,
  OFFICIAL_NOMINAL_RATING, OFFICIAL_NOMINAL_RD, RETENTION_CHECK_EVERY,
} from './identity.js';
import { deleteIfExists } from './storage.js';
import { LeagueAgents } from './class-agents.js';

export class LeagueMatches extends LeagueAgents {
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

  /**
   * Remove every league-side trace of a deleted account's agent: token, lock,
   * queue entry, match records and their replay files. Called after Better
   * Auth has deleted the user (the player profile cascades in the DB).
   */
  purgeAgentData(agentId) {
    const agent = this.agents.get(agentId);
    if (agent?.token) this.tokens.delete(agent.token);
    this.agents.delete(agentId);
    this.locked.delete(agentId);
    this.queue = this.queue.filter((entry) => entry.agentId !== agentId);
    const doomed = this.matches.filter((m) => m.a?.id === agentId || m.b?.id === agentId);
    const ids = new Set(doomed.map((m) => m.matchId));
    for (const id of ids) {
      const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '') + '.jsonl';
      // A missing replay is already in the desired state; skip it.
      deleteIfExists(path.join(this.replayDir, safe));
    }
    if (ids.size) {
      this.matches = this.matches.filter((m) => !ids.has(m.matchId));
      this.save();
    }
    return { matches: ids.size };
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
    // Showpiece rotation: two aggressive duelists actually fighting — combos,
    // pressure and whiff-punishes on BOTH sides, never a passive defending bot.
    // Variety comes from style matchups and seeded rhythm, not from row dummy
    // AIs. The hosted DSL template is a deliberate anti-air ZONER (backs off,
    // blocks), so it is intentionally excluded here: one passive side is exactly
    // the "why is P2 just standing there" problem this rotation fixes.
    const showcase = [
      ['duelist_rush', 'duelist_foot'],
      ['duelist_foot', 'duelist_rush'],
      ['duelist_rush', 'duelist_rush'],
      ['duelist_foot', 'duelist_foot'],
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
}
