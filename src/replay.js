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
  return replay.ticks.map((t) => JSON.stringify(t)).join('\n') + (replay.ticks.length ? '\n' : '');
}

export function parseReplay(text, matchId = 'local') {
  const ticks = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { format: 'afl-replay/1', matchId, seed: ticks[0] ? ticks[0].seed : 1, ticks };
}
