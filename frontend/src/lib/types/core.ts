import type { LeaderboardResponse, LeaderboardRow } from './leaderboard';

export type Palette = {
  base: string;
  accent?: string;
  [key: string]: string | undefined;
};

export type Fighter = {
  id: string;
  code: string;
  name: string;
  team: string;
  teamName?: string;
  teamCode?: string;
  teamMotif?: string;
  teamColor?: string;
  title?: string;
  style?: string;
  tagline?: string;
  bio?: string;
  profile?: { reach?: number; speed?: number; power?: number; guard?: number };
  palette: Palette & { light?: string; accent?: string };
  art?: string;
  archetype?: string;
  signature?: { name: string; shape?: string };
  kit?: { label?: string; tags?: string[]; blurb?: string; [key: string]: unknown };
  skills?: Array<{
    name: string;
    startup: number;
    active: number;
    recovery: number;
    cost?: number;
    mechanic?: string;
    potentialDamage?: number;
    damage?: number;
  }>;
  [key: string]: unknown;
};

export type TeamGroup = {
  id: string;
  name: string;
  fighters: string[];
  [key: string]: unknown;
};

export type FighterBrief = {
  id: string;
  name: string;
  code: string;
  title?: string;
  style?: string;
  palette: Palette;
  team?: string;
  teamName?: string;
  [key: string]: unknown;
};

export type SideAgent = {
  id: string;
  name: string;
  fighter?: FighterBrief;
  source?: string;
  connected?: boolean;
  official?: boolean;
  competitor?: boolean;
  rating?: number;
};

export type TeamSlot = {
  fighterId: string;
  hp: number;
  meter?: number;
  [key: string]: unknown;
};

export type TeamSide = {
  alive: number;
  current?: string;
  order: TeamSlot[];
  fallen: string[];
  [key: string]: unknown;
};

export type TeamView = {
  round: number;
  maxRounds: number;
  over?: boolean;
  a: TeamSide;
  b: TeamSide;
  [key: string]: unknown;
};

export type Room = {
  roomId: string;
  mode: string;
  format?: string;
  status: string;
  ranked?: boolean;
  code?: string | null;
  pairing?: string;
  matchId?: string | null;
  tick: number;
  round?: number;
  team?: TeamView | null;
  a: SideAgent | null;
  b: SideAgent | null;
  spectators: number;
  watchUrl: string;
  [key: string]: unknown;
};

export type QueueEntry = {
  agentId: string;
  name: string;
  team: string[] | null;
  mode: string;
  format: string;
  source?: string;
  rating: number;
  waitingMs: number;
};

export type MatchSummary = {
  matchId: string;
  roomId?: string | null;
  mode?: string;
  format?: string;
  ranked?: boolean;
  practice?: boolean;
  pairing?: string | null;
  a?: { id: string; name: string; official?: boolean; competitor?: boolean; [key: string]: unknown };
  b?: { id: string; name: string; [key: string]: unknown };
  winner?: 'a' | 'b' | 'draw';
  winnerName?: string;
  reason?: string;
  endedAt?: string;
  ticks?: number;
  ratingDeltaA?: number;
  ratingDeltaB?: number;
  [key: string]: unknown;
};

export type Frame = {
  frame: number;
  tick: number;
  [key: string]: unknown;
};

export type MatchInfo = {
  matchId?: string;
  format?: string;
  mode?: string;
  status?: string;
  /** Arena id chosen by the server at kickoff. Absent on matches recorded
   *  before stage tracking existed - the renderer reads that as "unknown",
   *  not as "neutral arena". */
  stage?: string | null;
  seed?: number | null;
  lastFrame?: Frame | null;
  a?: { id: string; name: string; [key: string]: unknown };
  b?: { id: string; name: string; [key: string]: unknown };
  team?: TeamView | null;
  [key: string]: unknown;
};

export type StageLayers = {
  weather: 'rain' | 'embers' | 'dust' | 'sparks' | 'none';
  ambient: 'neon' | 'warm' | 'cool' | 'sodium' | 'storm';
  crowd: boolean;
  parallax: number;
  flicker: number;
};

/** One arena in the server registry. `id` is what a match record carries. */
export type StageInfo = {
  id: string;
  name: string;
  label: string;
  team: string | null;
  teamName: string | null;
  neutral: boolean;
  description: string;
  plate: string;
  layers: StageLayers;
};

/** GET /api/stages, and the `stages` block of /api/state. */
export type StageModel = {
  count: number;
  neutral: string;
  selection: string[];
  stages: StageInfo[];
};

export type StageRegistry = Record<string, StageInfo>;

export type AppState = {
  server: {
    name: string;
    season: string;
    tickMs: number;
    framesPerTick: number;
    matchTicks: number;
    version: string;
  };
  match: MatchInfo | null;
  /** Arena registry the server uses to pick each match's stage. */
  stages?: StageModel;
  rooms: Room[];
  lobby: {
    queue: QueueEntry[];
    waiting: number;
    spectators: number;
    onlineAgents: number;
    totalRooms?: number;
    finishedRooms?: number;
  };
  leaderboard: LeaderboardResponse & { season: string; rows: LeaderboardRow[] };
  recentMatches: MatchSummary[];
  agents: AgentSummary[];
  fighters: Fighter[];
  teams: TeamGroup[];
  queue: number;
  spectators: number;
  onlineAgents: number;
};

export type AgentSummary = {
  id: string;
  name: string;
  label?: string;
  kind?: string;
  track?: string;
  source?: string;
  versionHash?: string;
  description?: string;
  fighterId?: string;
  team: string[] | null;
  teamName?: string | null;
  hosted?: boolean;
};
