/**
 * Team elimination (KOF-style 3v3) as a pure state machine.
 *
 * The kernel (engine.js) still fights ONE round at a time and stays
 * byte-deterministic. Everything that spans rounds lives here: the ordered
 * roster, carried hp/meter, elimination, the winner's recovery bonus and the
 * once-per-intermission order change. No timers, no IO — the Room drives the
 * clock and feeds results in, which keeps the whole mode unit-testable and
 * replayable from (teams, orders, per-round action tapes).
 *
 * Rules implemented (see docs/team-battle.md):
 *   - 3 distinct fighters per side, entry order chosen before the match.
 *   - A round ends on KO or time up; the round loser's fighter is eliminated
 *     either way. A drawn round eliminates BOTH current fighters.
 *   - The round winner's fighter recovers 15% of max HP (capped) and keeps its
 *     remaining hp and meter; benched fighters freeze at their stored values.
 *   - Between rounds each side may reorder its alive pool ONCE; the head of
 *     the order enters the next round. Silence keeps the current order.
 *   - A side with no alive fighter loses; both empty at once is a draw.
 */
import { CONFIG } from './config.js';
import { isValidFighter } from './fighters.js';
import { hashObject } from './replay.js';
import { replayMatch, renderReplay } from './engine.js';

export const TEAM_SIZE = 3;
export const TEAM_HEAL = Math.floor(CONFIG.MAX_HP * 0.15);
export const TEAM_MAX_ROUNDS = TEAM_SIZE * 2 - 1;
export const TEAM_INTERMISSION_MS = 8000;

export function normalizeTeam(ids) {
  if (!Array.isArray(ids) || ids.length !== TEAM_SIZE) {
    throw new Error('a team needs exactly ' + TEAM_SIZE + ' fighters');
  }
  const seen = new Set();
  for (const id of ids) {
    if (!isValidFighter(id)) throw new Error('unknown fighter: ' + id);
    if (seen.has(id)) throw new Error('duplicate fighter in team: ' + id);
    seen.add(id);
  }
  return ids.slice();
}

function makeSide(ids) {
  return {
    roster: Object.fromEntries(ids.map((id) => [id, { hp: CONFIG.MAX_HP, meter: 0, alive: true }])),
    order: ids.slice(),
    fallen: [],
  };
}

export function createTeamState({ matchId = 'local', seed = 1, teams }) {
  return {
    format: 'team',
    matchId,
    seed: seed >>> 0,
    round: 1,
    sides: { a: makeSide(normalizeTeam(teams.a)), b: makeSide(normalizeTeam(teams.b)) },
    over: false,
    winner: null,
    reason: null,
    rounds: [],
  };
}

export function currentOf(ts, side) {
  return ts.sides[side].order[0] || null;
}

/** What the next round's kernel match must be created with. */
export function teamRoundStart(ts) {
  const seat = (side) => {
    const id = currentOf(ts, side);
    const slot = ts.sides[side].roster[id];
    return { fighterId: id, hp: slot.hp, meter: slot.meter };
  };
  const a = seat('a');
  const b = seat('b');
  return {
    fighters: { a: a.fighterId, b: b.fighterId },
    start: { a: { hp: a.hp, meter: a.meter }, b: { hp: b.hp, meter: b.meter } },
  };
}

function eliminate(ts, side) {
  const s = ts.sides[side];
  const id = s.order.shift();
  if (!id) return null;
  s.roster[id].alive = false;
  s.roster[id].hp = 0;
  s.fallen.push(id);
  return { side, fighterId: id };
}

/**
 * Fold one finished round into the team state. `result` is the kernel's round
 * verdict ({winner:'a'|'b'|'draw', reason:'ko'|'time_up'}). Returns the round
 * summary that also goes into the replay envelope.
 */
export function applyRoundResult(ts, result) {
  const round = ts.round;
  const eliminated = [];
  const losers = result.winner === 'draw' ? ['a', 'b'] : [result.winner === 'a' ? 'b' : 'a'];
  for (const side of losers) {
    const out = eliminate(ts, side);
    if (out) eliminated.push(out);
  }
  let healed = null;
  if (result.winner !== 'draw') {
    const id = currentOf(ts, result.winner);
    const slot = ts.sides[result.winner].roster[id];
    const before = slot.hp;
    slot.hp = Math.min(CONFIG.MAX_HP, slot.hp + TEAM_HEAL);
    healed = { side: result.winner, fighterId: id, amount: slot.hp - before };
  }
  const emptyA = ts.sides.a.order.length === 0;
  const emptyB = ts.sides.b.order.length === 0;
  if (emptyA || emptyB) {
    ts.over = true;
    ts.winner = emptyA && emptyB ? 'draw' : emptyA ? 'b' : 'a';
    ts.reason = 'elimination';
  }
  const summary = {
    round,
    winner: result.winner,
    reason: result.reason,
    eliminated,
    healed,
    alive: { a: ts.sides.a.order.length, b: ts.sides.b.order.length },
    hp: { a: slotHp(ts, 'a'), b: slotHp(ts, 'b') },
    matchOver: ts.over,
    matchWinner: ts.winner,
  };
  ts.rounds.push(summary);
  if (!ts.over) ts.round += 1;
  return summary;
}

function slotHp(ts, side) {
  const id = currentOf(ts, side);
  return id ? ts.sides[side].roster[id].hp : 0;
}

export function isValidOrder(ts, side, ids) {
  const s = ts.sides[side];
  if (!Array.isArray(ids) || ids.length !== s.order.length) return false;
  const want = new Set(s.order);
  const seen = new Set();
  for (const id of ids) {
    if (!want.has(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

/**
 * The once-per-intermission order change. Must be a permutation of the alive
 * pool exactly — no additions, no drops, no duplicates. Returns false instead
 * of throwing so a bad client input can be rejected without killing the room.
 */
export function applyOrder(ts, side, ids) {
  if (!isValidOrder(ts, side, ids)) return false;
  ts.sides[side].order = ids.slice();
  return true;
}

/** Public, read-only shape for HUD / observation / broadcasts. */
export function teamView(ts) {
  const side = (key) => {
    const s = ts.sides[key];
    return {
      current: s.order[0] || null,
      alive: s.order.length,
      order: s.order.map((id) => ({ fighterId: id, hp: s.roster[id].hp, meter: s.roster[id].meter })),
      fallen: s.fallen.slice(),
    };
  };
  return {
    format: 'team',
    round: ts.round,
    maxRounds: TEAM_MAX_ROUNDS,
    over: ts.over,
    winner: ts.winner,
    a: side('a'),
    b: side('b'),
  };
}

export function teamResult(ts) {
  return {
    winner: ts.winner,
    reason: ts.reason,
    rounds: ts.rounds.slice(),
    survivors: { a: ts.sides.a.order.length, b: ts.sides.b.order.length },
    fallen: { a: ts.sides.a.fallen.slice(), b: ts.sides.b.fallen.slice() },
  };
}

/**
 * Replay envelope: the team match is reproducible from (teams, per-round
 * action tapes, intermission orders). Each round keeps its own single-round
 * replay so the existing hash-chain verification applies unchanged.
 */
export function createTeamReplay(matchId, seed, agents, teams) {
  return {
    format: 'afl-team-replay/1',
    matchId,
    seed,
    teams: { a: teams.a.slice(), b: teams.b.slice() },
    agents: agents.map((a) => ({ id: a.id, name: a.name, versionHash: a.versionHash, kind: a.kind })),
    rounds: [],
  };
}

export function appendTeamRound(envelope, record) {
  envelope.rounds.push(record);
}

export function replayTeamMatch(envelope) {
  const ts = createTeamState({ matchId: envelope.matchId, seed: envelope.seed, teams: envelope.teams });
  const mismatches = [];
  for (const rec of envelope.rounds) {
    if (hashObject(teamRoundStart(ts)) !== hashObject(rec.start)) {
      mismatches.push({ round: rec.round, field: 'start' });
      break;
    }
    const single = replayMatch(rec.replay);
    if (!single.ok) {
      mismatches.push({ round: rec.round, field: 'ticks', detail: single.mismatches });
      break;
    }
    const summary = applyRoundResult(ts, rec.result);
    if (hashObject(summary) !== hashObject(rec.summary)) {
      mismatches.push({ round: rec.round, field: 'summary' });
      break;
    }
    for (const side of ['a', 'b']) {
      if (rec.orders && rec.orders[side] && !applyOrder(ts, side, rec.orders[side])) {
        mismatches.push({ round: rec.round, field: 'order', side });
      }
    }
  }
  return { ok: mismatches.length === 0, mismatches, rounds: envelope.rounds.length, over: ts.over, winner: ts.winner };
}

export function renderTeamReplay(envelope) {
  return envelope.rounds.map((rec) => ({
    round: rec.round,
    start: rec.start,
    orders: rec.orders,
    result: rec.result,
    summary: rec.summary,
    ticks: renderReplay(rec.replay),
  }));
}

/** One flat tick tape for the spectator replay player, round-tagged. */
export function flattenTeamReplay(envelope) {
  return envelope.rounds.flatMap((rec) => renderReplay(rec.replay).map((t) => ({ ...t, round: rec.round })));
}

export function parseTeamReplay(text) {
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  return data && data.format === 'afl-team-replay/1' ? data : null;
}