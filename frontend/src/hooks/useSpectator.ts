import { useEffect, useReducer, useRef, type MutableRefObject } from 'react';
import type { AgentSummary, Fighter, MatchSummary, Room } from '../lib/types';

type AnyRecord = Record<string, any>;

export type SpectatorState = {
  connected: boolean;
  roomId: string | null;
  season: string;
  match: AnyRecord | null;
  rooms: Room[];
  presence: AnyRecord | null;
  fighters: Fighter[];
  board: AnyRecord | null;
  recent: MatchSummary[];
  agents: AgentSummary[];
  current: AnyRecord | null;
  lastResult: AnyRecord | null;
  decisions: AnyRecord[];
  combat: AnyRecord[];
  budget: AnyRecord | null;
  tick: number;
  hud: AnyRecord | null;
  team: AnyRecord | null;
  intermission: AnyRecord | null;
};

type Action =
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

const initial: SpectatorState = {
  connected: false,
  roomId: null,
  season: 'S1',
  match: null,
  rooms: [],
  presence: null,
  fighters: [],
  board: null,
  recent: [],
  agents: [],
  current: null,
  lastResult: null,
  decisions: [],
  combat: [],
  budget: null,
  tick: 0,
  hud: null,
  team: null,
  intermission: null,
};

const MAX_EVENTS = 70;

function reducer(state: SpectatorState, action: Action): SpectatorState {
  switch (action.type) {
    case 'socket':
      return { ...state, connected: action.connected, roomId: action.roomId ?? state.roomId };
    case 'hello': {
      const msg = action.msg;
      const match = msg.match ?? null;
      return {
        ...state,
        roomId: msg.roomId ?? null,
        season: msg.server?.season ?? state.season,
        match,
        board: msg.leaderboard ?? state.board,
        recent: msg.recentMatches ?? state.recent,
        agents: msg.agents ?? state.agents,
        rooms: msg.rooms ?? state.rooms,
        presence: msg.presence ?? state.presence,
        fighters: msg.fighters ?? state.fighters,
        current: match?.lastFrame ?? null,
        lastResult: null,
        decisions: [],
        combat: [],
        budget: null,
        tick: match?.tick ?? 0,
        hud: match?.lastFrame ?? null,
        team: match?.team ?? null,
        intermission: match?.intermission ?? null,
      };
    }
    case 'rooms':
      return {
        ...state,
        rooms: action.msg.rooms ?? state.rooms,
        presence: action.msg.presence ?? state.presence,
        board: action.msg.leaderboard ?? state.board,
        recent: action.msg.recentMatches ?? state.recent,
      };
    case 'match_start': {
      const match = action.msg.match ?? null;
      return {
        ...state,
        match,
        current: match?.lastFrame ?? null,
        lastResult: null,
        decisions: [],
        combat: [],
        budget: null,
        tick: match?.tick ?? 0,
        hud: match?.lastFrame ?? null,
        team: match?.team ?? null,
        intermission: null,
      };
    }
    case 'round_start': {
      const match = action.msg.match ?? state.match;
      return {
        ...state,
        match,
        current: match?.lastFrame ?? null,
        decisions: [],
        combat: [],
        tick: match?.tick ?? state.tick,
        hud: match?.lastFrame ?? state.hud,
        team: match?.team ?? action.msg.team ?? state.team,
        intermission: null,
      };
    }
    case 'round_end':
      return { ...state, team: action.msg.team ?? state.team };
    case 'intermission':
      return {
        ...state,
        team: action.msg.team ?? state.team,
        intermission: {
          round: action.msg.round,
          deadlineMs: action.msg.deadlineMs ?? action.msg.remainingMs ?? 8000,
          remainingMs: action.msg.remainingMs ?? action.msg.deadlineMs ?? 8000,
          locked: action.msg.locked ?? {},
        },
      };
    case 'order_locked': {
      if (!state.intermission) return state;
      return {
        ...state,
        intermission: {
          ...state.intermission,
          locked: { ...state.intermission.locked, [action.msg.side]: true },
        },
      };
    }
    case 'tick': {
      const msg = action.msg;
      const decisions = [...state.decisions];
      for (const side of ['a', 'b'] as const) {
        const row = msg.decisions?.[side];
        if (row) decisions.push({ side, ...row });
      }
      const combat = msg.events?.length ? [...state.combat, ...msg.events] : state.combat;
      return {
        ...state,
        decisions: decisions.slice(-MAX_EVENTS),
        combat: combat.slice(-MAX_EVENTS),
        budget: msg.budget ?? state.budget,
        tick: msg.tick ?? state.tick,
        hud: msg.hud ?? state.hud,
        match: state.match ? { ...state.match, tick: msg.tick ?? state.match.tick } : state.match,
      };
    }
    case 'match_end':
      return {
        ...state,
        lastResult: { ...action.msg.result, matchId: action.msg.matchId },
        match: state.match ? { ...state.match, status: 'finished' } : state.match,
        board: action.msg.leaderboard ?? state.board,
        recent: action.msg.recentMatches ?? state.recent,
      };
    default:
      return state;
  }
}

export function useSpectator(roomId: string | null) {
  const [state, dispatch] = useReducer(reducer, initial);
  const frameQueue = useRef<AnyRecord[]>([]);
  const current = useRef<AnyRecord | null>(null);
  const lastMatchId = useRef<string | null>(null);

  useEffect(() => {
    let closed = false;
    let socket: WebSocket | null = null;
    let retry = 0;

    const connect = () => {
      if (closed) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const query = roomId ? `?room=${encodeURIComponent(roomId)}` : '';
      socket = new WebSocket(`${proto}://${window.location.host}/ws/spectate${query}`);
      socket.onopen = () => dispatch({ type: 'socket', connected: true, roomId });
      socket.onclose = () => {
        dispatch({ type: 'socket', connected: false, roomId });
        if (!closed) retry = window.setTimeout(connect, 2000);
      };
      socket.onerror = () => socket?.close();
      socket.onmessage = (event) => {
        let msg: AnyRecord;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.roomId && roomId && msg.roomId !== roomId && msg.type !== 'hello' && msg.type !== 'rooms') return;
        switch (msg.type) {
          case 'hello':
            frameQueue.current.length = 0;
            current.current = msg.match?.lastFrame ?? null;
            lastMatchId.current = msg.match?.matchId ?? null;
            dispatch({ type: 'hello', msg });
            break;
          case 'rooms':
            dispatch({ type: 'rooms', msg });
            break;
          case 'match_start':
            frameQueue.current.length = 0;
            current.current = msg.match?.lastFrame ?? null;
            lastMatchId.current = msg.match?.matchId ?? null;
            dispatch({ type: 'match_start', msg });
            break;
          case 'round_start':
            frameQueue.current.length = 0;
            current.current = msg.match?.lastFrame ?? null;
            dispatch({ type: 'round_start', msg });
            break;
          case 'round_end':
            dispatch({ type: 'round_end', msg });
            break;
          case 'intermission':
            dispatch({ type: 'intermission', msg });
            break;
          case 'order_locked':
            dispatch({ type: 'order_locked', msg });
            break;
          case 'tick':
            if (!lastMatchId.current || msg.matchId !== lastMatchId.current) break;
            if (msg.frames?.length) {
              frameQueue.current.push(...msg.frames);
              if (frameQueue.current.length > 40) {
                frameQueue.current.splice(0, frameQueue.current.length - 24);
              }
            }
            dispatch({ type: 'tick', msg });
            break;
          case 'match_end':
            dispatch({ type: 'match_end', msg });
            break;
          default:
            break;
        }
      };
    };

    connect();
    return () => {
      closed = true;
      window.clearTimeout(retry);
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, [roomId]);

  return { state, frameQueue, current } satisfies {
    state: SpectatorState;
    frameQueue: MutableRefObject<AnyRecord[]>;
    current: MutableRefObject<AnyRecord | null>;
  };
}
