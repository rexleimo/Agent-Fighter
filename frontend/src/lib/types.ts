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

export type LeaderboardRow = {
  rank: number;
  id: string;
  name: string;
  label?: string;
  kind?: string;
  track?: string;
  source?: string;
  versionHash?: string;
  fighterId?: string;
  team: string[] | null;
  teamName?: string | null;
  rating: number;
  rd?: number;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  modelCallsPerMatch?: number;
  timeouts?: number;
};

export type MatchSummary = {
  matchId: string;
  roomId?: string | null;
  mode?: string;
  format?: string;
  ranked?: boolean;
  a?: { id: string; name: string; [key: string]: unknown };
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
  lastFrame?: Frame | null;
  a?: { id: string; name: string; [key: string]: unknown };
  b?: { id: string; name: string; [key: string]: unknown };
  team?: TeamView | null;
  [key: string]: unknown;
};

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
  rooms: Room[];
  lobby: {
    queue: QueueEntry[];
    waiting: number;
    spectators: number;
    onlineAgents: number;
    totalRooms?: number;
    finishedRooms?: number;
  };
  leaderboard: { season: string; rows: LeaderboardRow[] };
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

export type PlayerPublic = {
  id: string;
  username: string;
  displayName: string;
  role: 'player' | 'admin';
  status: string;
  agentId: string | null;
  mcp: { assigned: boolean; issuedAt?: string | null };
  createdAt: string;
  lastLoginAt?: string | null;
};

export type McpService = {
  assigned: boolean;
  issuedAt?: string | null;
  key?: string;
  path?: string;
  url?: string;
};

export type MeResponse = {
  player: PlayerPublic;
  agent: AgentStatus | null;
  mcp: McpService;
};

export type AgentStatus = {
  id: string;
  name: string;
  team: string[] | null;
  teamName: string | null;
  source: string;
  versionHash: string;
  rating: number;
  wins: number;
  losses: number;
  draws: number;
  matches: number;
};

export type MyAgentResponse = {
  agent: AgentStatus;
  queue: QueueEntry | null;
  room: Room | null;
  recentMatches: Array<{
    matchId: string;
    opponent: string;
    result: 'win' | 'loss' | 'draw';
    ratingDelta?: number;
    format?: string;
    endedAt?: string;
  }>;
};

export type AdminPlayer = PlayerPublic & {
  mcp: McpService;
  agent: AgentStatus | null;
};
