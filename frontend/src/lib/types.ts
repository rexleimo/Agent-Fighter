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
  practiceMatches?: number;
  trainingRuns?: number;
  winRate: number | null;
  cost?: AgentCost;
};

/** Server-observed spend. `declaredModelCalls` is client-reported, never a bill. */
export type AgentCost = {
  modelCallsPerMatch?: number;
  declaredModelCalls?: number;
  timeouts?: number;
  budgetExceeded?: number;
  hostedTicksEvaluated?: number;
};

export type CostClass = {
  id: string;
  title: string;
  payer: string | null;
  note: string;
  items: string[];
};

export type CostModel = {
  version: string;
  maxModelCallsPerMatch: number;
  decisionDeadlineMs: number;
  replayRetention: number;
  classes: CostClass[];
  surfaces: Record<string, string>;
  surfacesDetailed?: Record<string, { class: string; title: string; payer: string | null }>;
  matchResources?: { maxMeter: number; exCost: number; superCost: number; note: string };
  principle: string;
};

export type DrillList = {
  drills: Array<{ id: string; name: string; goal: string; skill: string; source: string; llm: boolean }>;
  mirror?: { id: string; name: string; goal: string; source: string; llm: boolean };
  baselines: Array<{ id: string; name: string; goal: string; skill: string; source: string; llm: boolean }>;
  note: string;
  freeClass?: string;
};

export type TrainingRow = {
  opponent: string;
  opponentId: string;
  opponentKind: string;
  name?: string;
  goal?: string | null;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  avgHpLeft: number;
  avgTicks: number;
  fallbackShare: number;
  meterSpent: number;
  superUsed: number;
};

export type TrainingFinding = {
  code: string;
  severity: 'high' | 'medium' | 'low' | 'info';
  message: string;
  hint: string;
  ruleIndexes?: number[];
  opponent?: string;
};

export type TrainingReport = {
  kind: 'training';
  countsTowardLadder: false;
  versionHash: string;
  strategyName: string;
  drills: string[];
  seeds: number[];
  games: number;
  gameCap: number;
  truncated: boolean;
  outcomeVariety: { distinct: number; games: number; diversified: boolean };
  wins: number;
  losses: number;
  draws: number;
  strengthIndex: number | null;
  strengthIndexNote?: string;
  rows: TrainingRow[];
  rules: Array<{ ruleIndex: number; action: string; note?: string; fires: number; hits: number; whiffs: number; punished: number; hitRate: number; shadowedBy: number[] }>;
  actions: Array<{ move: string; attempts: number; hits: number; whiffs: number; whiffRate: number; punished: number; avgDistance: number | null }>;
  cost: { billingClass: string; llmUsed: boolean; modelCalls: number; opponentEngine: string; note: string };
  methodology: Record<string, string>;
  findings: TrainingFinding[];
};

export type TrainingCompare = {
  kind: 'training-compare';
  countsTowardLadder: false;
  seeds: number[];
  drills: string[];
  games: number;
  versionA: { hash: string; wins: number; strengthIndex: number | null };
  versionB: { hash: string; wins: number; strengthIndex: number | null };
  perOpponent: Array<{ opponent: string; aWinRate: number; bWinRate: number; delta: number; games: number }>;
  strengthDelta: number | null;
  verdict: 'stronger' | 'weaker' | 'flat' | 'inconclusive';
  verdictNote: string;
  sample: { gamesPerVersion: number; opponents: number; seeds: number };
  changedSeeds: string[];
  caveat: string;
};

export type LeaderboardResponse = {
  season: string;
  rows: LeaderboardRow[];
  scope?: string;
  scopeNote?: string;
  ladderStartedAt?: string | null;
  officials?: Array<{ id: string; name: string; source?: string; rating: number; rd: number; exhibitionMatches?: number }>;
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

export type TrainingHistory = { agentId: string; runs: Array<{ at: string; versionHash: string; drills: string[]; seeds: number[]; games: number; wins: number; losses: number; draws: number; strengthIndex: number | null; findings: Array<{ code: string; severity: string; message: string }> }> };

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
  practiceMatches?: number;
  trainingRuns?: number;
  hasStrategy?: boolean;
  ruleCount?: number;
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
    ranked?: boolean;
    practice?: boolean;
    opponentOfficial?: boolean;
  }>;
  training?: TrainingHistory;
  cost?: {
    declaredModelCalls: number;
    timeouts: number;
    budgetExceeded: number;
    hostedTicksEvaluated: number;
    trainingRuns: number;
    budgetLimit: number;
    hosted: boolean;
  };
};

export type AdminPlayer = PlayerPublic & {
  mcp: McpService;
  agent: AgentStatus | null;
};
