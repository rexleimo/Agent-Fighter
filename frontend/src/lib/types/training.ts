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

export type TrainingHistory = { agentId: string; runs: Array<{ at: string; versionHash: string; drills: string[]; seeds: number[]; games: number; wins: number; losses: number; draws: number; strengthIndex: number | null; findings: Array<{ code: string; severity: string; message: string }> }> };
