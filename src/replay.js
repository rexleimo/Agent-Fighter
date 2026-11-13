import { createHash } from 'node:crypto';

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

export function hashObject(obj) {
  return createHash('sha256').update(stableStringify(obj)).digest('hex');
}

export function createReplay(matchId, seed, agents) {
  return {
    format: 'afl-replay/1',
    matchId,
    seed,
    rulesVersion: '1.0',
    agents: agents.map((a) => ({ id: a.id, name: a.name, versionHash: a.versionHash, kind: a.kind })),
    ticks: [],
  };
}

export function appendTick(replay, record) {
  replay.ticks.push(record);
}

export function serializeReplay(replay) {
  // The header carries the fighters and round-start hp/meter: kits change
  // frame data, so a tick tape alone cannot reproduce the state-hash chain.
  const header = {
    format: replay.format || 'afl-replay/1',
    matchId: replay.matchId,
    seed: replay.seed,
    rulesVersion: replay.rulesVersion,
    agents: replay.agents || [],
    fighters: replay.fighters || null,
    // The arena travels inside the replay file itself. If it only lived in
    // league.json, a replay downloaded on its own could not prove which stage it
    // was fought on, and the viewer would have to guess.
    stage: replay.stage || null,
    start: replay.start || null,
  };
  return JSON.stringify(header) + '\n'
    + replay.ticks.map((t) => JSON.stringify(t)).join('\n') + (replay.ticks.length ? '\n' : '');
}

export function parseReplay(text, matchId = 'local') {
  const lines = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const head = lines.length && typeof lines[0].tick !== 'number' ? lines.shift() : null;
  return {
    format: (head && head.format) || 'afl-replay/1',
    matchId: (head && head.matchId) || matchId,
    seed: head ? head.seed : (lines[0] ? lines[0].seed : 1),
    rulesVersion: head ? head.rulesVersion : undefined,
    agents: (head && head.agents) || [],
    fighters: (head && head.fighters) || undefined,
    start: (head && head.start) || undefined,
    ticks: lines,
  };
}
