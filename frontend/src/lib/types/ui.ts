import type { MutableRefObject } from 'react';
import type { Fighter, StageRegistry } from './core';
import type { MeResponse } from './account';

/* ------------------------------- components ------------------------------ */

/** ResourceViewer (components/ResourceViewer.tsx) */
export type ResourceViewerProps = {
  title: string;
  url: string;
  kind?: 'markdown' | 'json' | 'text';
  onClose: () => void;
};

/** BroadcastHud (components/live/BroadcastHud.tsx) */
export type BroadcastSlot = { fighterId: string; hp: number; meter?: number };
export type BroadcastSide = { alive: number; current: string | null; order: BroadcastSlot[]; fallen: string[] };
export type BroadcastTeam = { round: number; maxRounds: number; a: BroadcastSide; b: BroadcastSide };

/** StageCanvas (components/live/StageCanvas.tsx) */
export type ToolState = {
  showBoxes: boolean;
  showBones: boolean;
  showFx: boolean;
  showRuler: boolean;
  showGrid: boolean;
};
export type StageCanvasProps = {
  frameQueue: MutableRefObject<any[]>;
  current: MutableRefObject<any | null>;
  match: any;
  moves: Record<string, any>;
  fighters: Fighter[];
  tools: ToolState;
  lastResult: any;
  stages: StageRegistry | null;
};

/** McpCard (components/account/McpCard.tsx) */
export type McpCardProps = {
  me: MeResponse;
  busy: boolean;
  onIssue: () => void;
  error: string;
};

/** SecurityCard (components/account/SecurityCard.tsx) */
export type SecurityCardProps = { me: MeResponse; onLogout: () => void };

/** AuthCard (components/account/AuthCard.tsx) */
export type SubmitValues = { username: string; password: string; displayName?: string; captcha: string };
export type AuthCardProps = {
  mode: 'login' | 'register';
  onModeChange: (mode: 'login' | 'register') => void;
  onSubmit: (values: SubmitValues) => void;
  busy: boolean;
  serverError: string;
  captchaNonce: number;
};

/** GettingStartedCard (components/account/GettingStartedCard.tsx) */
export type GettingStartedStep = { key: string; label: string; hint: string; done: boolean; to?: string };

/** JsonEditor (components/account/JsonEditor.tsx) */
export type JsonEditorProps = {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  ariaLabel?: string;
};

/* --------------------------------- hooks --------------------------------- */

/** useSpectator (hooks/useSpectator.ts) */
export type AnyRecord = Record<string, any>;
export type SpectatorAction =
  | { type: 'socket'; connected: boolean; roomId?: string | null }
  | { type: 'hello'; msg: AnyRecord }
  | { type: 'rooms'; msg: AnyRecord }
  | { type: 'match_start'; msg: AnyRecord }
  | { type: 'round_start'; msg: AnyRecord }
  | { type: 'round_end'; msg: AnyRecord }
  | { type: 'intermission'; msg: AnyRecord }
  | { type: 'order_locked'; msg: AnyRecord }
  | { type: 'tick'; msg: AnyRecord }
  | { type: 'match_end'; msg: AnyRecord };

/* --------------------------------- pages --------------------------------- */

/** BoardPage (pages/BoardPage.tsx) */
export type LeaderboardTrack = 'all' | 'open' | 'rule_only';

/** DirectoryView (pages/library/DirectoryView.tsx) */
export type ClientChip = { id: string; name: string };

/** SetupPage (pages/SetupPage.tsx) */
export type SetupStatus = { needsSetup: boolean };

/** ConnectPage (pages/ConnectPage.tsx) */
export type ViewerResource = { title: string; url: string; kind: 'markdown' | 'json' | 'text' };
export type McpClientConfig = {
  id: string;
  name: string;
  scope: string;
  language: string;
  cli: string;
  template: string;
  note: string;
};
export type McpConfigFile = {
  endpoint: string;
  note: string;
  clients: McpClientConfig[];
};

/** AccountLayout (pages/account/AccountLayout.tsx) */
export type AccountCredentials = { username: string; password: string; displayName?: string; captcha: string };
export type AccountContextValue = {
  me: MeResponse;
  issue: { mutate: () => void; isPending: boolean };
  logout: { mutate: () => void; isPending: boolean };
};

/** ReplayPage (pages/ReplayPage.tsx) */
export type ReplayTick = {
  frames: any[];
  actions: { a: string; b: string };
  events: any[];
  observation: any;
  round?: number;
};
