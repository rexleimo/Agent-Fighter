/**
 * Stage registry - the arena a match is fought in.
 *
 * A stage is a property of the MATCH, decided by the server when the match is
 * created and written into the match record, the replay header and the live
 * spectator payload. It is never rolled by the client: a live view showing the
 * dojo while the replay of the same match shows the rooftop is the same class of
 * fabricated data this league spent v0.8/v0.9 removing.
 *
 * Everything here is data plus pure functions so the server can declare a stage
 * without importing any rendering code, and the renderer cannot invent one.
 */

import { getFighter, getTeam } from './fighters.js';

/** Deterministic 32-bit mixing so a seed always yields the same stage. */
function mix(seed, salt) {
  let h = (seed >>> 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= (h >>> 16);
  h = Math.imul(h ^ salt, 0x27d4eb2f);
  return (h ^ (h >>> 15)) >>> 0;
}

/**
 * `plate` is the manifest asset id of the painted background. `layers` are the
 * seed-driven motion/light parameters that give a stage its life; they are
 * declared here rather than hard-coded in the renderer so the same numbers drive
 * live and replay by construction.
 */
export const STAGES = Object.freeze([
  {
    id: 'stage_main',
    name: '霓虹竞技场',
    label: 'NEON ARENA',
    team: null,
    neutral: true,
    description: '官方演示与跨队对决的中性场，雨夜霓虹与环形观众席。',
    plate: 'stage_main',
    layers: { weather: 'rain', ambient: 'neon', crowd: true, parallax: 0.35, flicker: 0.22 },
  },
  {
    id: 'stage_pyre',
    name: '熔铸武馆',
    label: 'FORGE HALL',
    team: 'pyre',
    neutral: false,
    description: '炎征队主场。锻炉余温，火星自炉口飘起。',
    plate: 'stage_pyre',
    layers: { weather: 'embers', ambient: 'warm', crowd: true, parallax: 0.4, flicker: 0.34 },
  },
  {
    id: 'stage_tide',
    name: '防波堤台',
    label: 'BREAKWATER',
    team: 'tide',
    neutral: false,
    description: '潮汐队主场。夜海防波堤，细雨与灯塔扫光。',
    plate: 'stage_tide',
    layers: { weather: 'rain', ambient: 'cool', crowd: false, parallax: 0.5, flicker: 0.16 },
  },
  {
    id: 'stage_steel',
    name: '矿脉工地',
    label: 'QUARRY WORKS',
    team: 'steel',
    neutral: false,
    description: '钢律队主场。采石场与吊装臂，空气里是浮尘。',
    plate: 'stage_steel',
    layers: { weather: 'dust', ambient: 'sodium', crowd: true, parallax: 0.3, flicker: 0.12 },
  },
  {
    id: 'stage_void',
    name: '信号塔顶',
    label: 'SIGNAL MAST',
    team: 'void',
    neutral: false,
    description: '虚数队主场。城市天线阵列顶端，静电与远处雷暴。',
    plate: 'stage_void',
    layers: { weather: 'sparks', ambient: 'storm', crowd: false, parallax: 0.55, flicker: 0.42 },
  },
]);

const BY_ID = new Map(STAGES.map((s) => [s.id, s]));
const BY_TEAM = new Map(STAGES.filter((s) => s.team).map((s) => [s.team, s]));
const NEUTRAL = BY_ID.get('stage_main');

export function stageFor(id) {
  return BY_ID.get(id) || null;
}

/** The fallback that is always honest: the neutral arena, never a guess. */
export function neutralStage() {
  return NEUTRAL;
}

/**
 * Which arena this match is played in.
 *
 * 1. Same team on both sides -> that team's home stage. For a 3v3 the rosters
 *    decide it, so `teamA`/`teamB` are accepted directly instead of sampling one
 *    fighter to stand in for the whole team.
 * 2. Otherwise -> deterministic over the match seed, so replaying the seed
 *    reproduces the arena instead of re-rolling it.
 *
 * `seed` is required for rule 2. Without a seed we return the neutral arena
 * rather than inventing a "random" one, because an unseeded choice cannot be
 * reproduced from the replay and would make live and replay disagree.
 */
export function selectStage({ fighterA = null, fighterB = null, teamA = null, teamB = null, seed = null, mode = 'ranked' } = {}) {
  if (mode === 'demo') return NEUTRAL;
  const ta = teamA || teamOf(fighterA);
  const tb = teamB || teamOf(fighterB);
  if (ta && ta === tb) {
    const home = BY_TEAM.get(ta);
    if (home) return home;
  }
  if (!Number.isFinite(seed)) return NEUTRAL;
  // Exclude the neutral arena from the cross-team roll: it stays the showcase
  // and fallback plate, so a player-visible match always lands on a real arena.
  const pool = STAGES.filter((s) => s.team);
  return pool[mix(seed, 0x5f3a) % pool.length];
}

function teamOf(fighterId) {
  const f = fighterId ? getFighter(fighterId) : null;
  return f && f.team ? f.team : null;
}

/** The team a roster belongs to, or null when it mixes teams. */
export function rosterTeam(fighterIds) {
  const teams = new Set((fighterIds || []).map((id) => teamOf(id)).filter(Boolean));
  return teams.size === 1 ? [...teams][0] : null;
}

/** Publishable model: the enum the API and docs describe, generated from data. */
export function stageModel() {
  return {
    count: STAGES.length,
    neutral: NEUTRAL.id,
    selection: [
      'same team on both sides -> that team home stage',
      'cross-team -> deterministic from the match seed',
      'demo rooms and any unseeded case -> neutral arena (never a guess)',
    ],
    stages: STAGES.map((s) => ({
      id: s.id,
      name: s.name,
      label: s.label,
      team: s.team,
      teamName: s.team && getTeam(s.team) ? getTeam(s.team).name : null,
      neutral: s.neutral,
      description: s.description,
      plate: s.plate,
      layers: s.layers,
    })),
  };
}

/** The one field set that goes into a record: id + name, nothing derived. */
export function stageRef(stage) {
  const s = stage || NEUTRAL;
  return { id: s.id, name: s.name, label: s.label, team: s.team, neutral: s.neutral };
}
