import type { QueueEntry, Room } from './core';
import type { TrainingHistory } from './training';

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
  ratingHistory?: Array<{ matchId: string; result: string; rating: number }>;
};

export type MeResponse = {
  player: PlayerPublic;
  agent: AgentStatus | null;
  mcp: McpService;
};

export type MeProfileResponse = { email: string; image: string };

export type MyStrategyResponse = {
  strategy: Record<string, unknown> | null;
  versionHash: string;
  ruleCount: number;
};

/** One row of the session-bound replay feed (league.getMyMatches). */
export type MyMatch = {
  matchId: string;
  roomId: string | null;
  mode: string;
  ranked: boolean;
  practice: boolean;
  pairing: string | null;
  stage: string | null;
  format: string;
  side: 'a' | 'b';
  opponent: string;
  opponentId: string;
  opponentOfficial: boolean;
  result: 'win' | 'loss' | 'draw';
  winner: string;
  reason: string;
  hp: number;
  ticks: number;
  ratingDelta: number;
  endedAt: string;
  fighters: Record<string, unknown> | null;
};

export type MyMatchesResponse = { agentId: string | null; matches: MyMatch[] };

export type AuthSession = {
  id: string;
  token: string;
  userId: string;
  expiresAt: string;
  ipAddress?: string | null;
  userAgent?: string | null;
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
