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

export type LeaderboardResponse = {
  season: string;
  rows: LeaderboardRow[];
  scope?: string;
  scopeNote?: string;
  ladderStartedAt?: string | null;
  officials?: Array<{ id: string; name: string; source?: string; rating: number; rd: number; exhibitionMatches?: number }>;
};
