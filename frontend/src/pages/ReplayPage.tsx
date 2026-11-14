import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAppState } from '../hooks/useAppState';
import { createStageRenderer } from '../game/stage.js';
import type { Fighter, MatchSummary, StageRegistry } from '../lib/types';

const REASON_LABEL: Record<string, string> = { ko: 'KO', time_up: '时间到', elimination: '全队淘汰' };
const ACTION_LABEL: Record<string, string> = {
  idle: '待机', walk_f: '前走', walk_b: '后撤', jump: '跳跃', crouch: '蹲防', block: '站防', throw: '投技',
  lp: '轻拳', mp: '中拳', hp: '重拳', lk: '轻脚', mk: '中脚', hk: '重脚', dp: '升龙', fireball: '波动',
  dash: '前冲', special: '专属技', ex: 'EX 强化', super: '超必杀', dodge: '闪避', parry: '招架',
};
const EVENT_LABEL: Record<string, string> = {
  hit: '命中', block: '防御', spawn: '发出波动', ko: 'KO', time_up: '时间到',
  cancel: '取消连段', super_start: '超必杀发动', armor: '霸体吸收', wakeup: '起身',
  move_start: '出招', hitstop: '命中停顿', evade: '闪避成功', parry: '招架成功',
};

type Tick = {
  frames: any[];
  actions: { a: string; b: string };
  events: any[];
  observation: any;
  round?: number;
};

function ReplayCanvas({
  ticks,
  index,
  match,
  moves,
  fighters,
  stages,
}: {
  ticks: Tick[];
  index: number;
  match: any;
  moves: Record<string, any>;
  fighters: Fighter[];
  stages: StageRegistry | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<any>(null);
  const viewRef = useRef<any>({
    moves: {},
    fighters: [],
    current: null,
    match: null,
    lastResult: null,
    replay: { ticks: [], index: 0 },
    spriteTrack: { a: {}, b: {} },
    showBoxes: false,
    showBones: false,
    showFx: true,
    showRuler: false,
    showGrid: false,
    stageRegistry: null,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = createStageRenderer({
      view: viewRef.current,
      stageCanvas: document.createElement('canvas'),
      replayCanvas: canvas,
    });
    rendererRef.current = renderer;
    // The arena is resolved from the match record inside draw(); preloading one
    // fixed plate here is what made every replay open on the same venue.
  }, []);

  useEffect(() => {
    viewRef.current.moves = moves;
    viewRef.current.fighters = fighters;
    viewRef.current.stageRegistry = stages;
  }, [moves, fighters, stages]);

  useEffect(() => {
    const tick = ticks[index];
    if (!tick) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const renderer = rendererRef.current;
    if (!canvas || !ctx || !renderer) return;
    const frame = tick.frames[tick.frames.length - 1] ?? tick.frames[0];
    viewRef.current.match = match;
    viewRef.current.current = frame;
    viewRef.current.replay = { ticks, index };
    renderer.ensureMatchFighters(match);
    renderer.observeReplay(frame, tick.events);
    renderer.replaceReplayImpact(index);
    renderer.draw(ctx, frame, match, canvas);
  }, [ticks, index, match]);

  return <canvas id="replayCanvas" ref={canvasRef} width={960} height={530} />;
}

export function ReplayPage() {
  const app = useAppState();
  // A replay link must be shareable: without this the page can only ever open
  // on the newest match, so there is no way to point at one arena in particular
  // (and no way for a gate to assert live and replay agree on a given match).
  const [params, setParams] = useSearchParams();
  const matchesQuery = useQuery({
    queryKey: ['matches'],
    queryFn: () => api<{ matches: MatchSummary[] }>('/api/matches'),
    refetchInterval: 8000,
  });
  const rules = useQuery({
    queryKey: ['rules'],
    queryFn: () => api<{ moves: Record<string, any> }>('/api/rules'),
    staleTime: Infinity,
  });
  const [matchId, setMatchId] = useState<string | null>(null);
  const [replay, setReplay] = useState<{ match: any; ticks: Tick[] } | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState('');

  const matches = matchesQuery.data?.matches ?? [];
  const fighters = app.data?.fighters ?? [];
  const stages = useMemo<StageRegistry>(() => {
    const map: StageRegistry = {};
    for (const s of app.data?.stages?.stages ?? []) map[s.id] = s;
    return map;
  }, [app.data?.stages]);

  async function select(id: string) {
    setPlaying(false);
    setError('');
    try {
      const data = await api<{ match: any; ticks: Tick[] }>(`/api/replay/${encodeURIComponent(id)}?render=1`);
      setMatchId(id);
      setReplay({ match: data.match, ticks: data.ticks ?? [] });
      setIndex(0);
      setParams((prev) => { const next = new URLSearchParams(prev); next.set('match', id); return next; }, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : '回放载入失败');
    }
  }

  useEffect(() => {
    const want = params.get('match');
    if (!want || want === matchId) return;
    if (matches.some((m) => m.matchId === want)) select(want);
  }, [params, matches]);

  useEffect(() => {
    if (params.get('match')) return;
    if (!matchId && matches.length) select(matches[0].matchId);
    // Deep link wins; otherwise open the newest match once, then let the user drive.
  }, [matches.length]);

  useEffect(() => {
    if (!playing || !replay) return;
    if (index >= replay.ticks.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setIndex((i) => i + 1), 100);
    return () => window.clearTimeout(timer);
  }, [playing, index, replay]);

  const tick = replay?.ticks[index];
  const max = Math.max(0, (replay?.ticks.length ?? 0) - 1);
  const frame = tick ? (tick.frames[tick.frames.length - 1] ?? tick.frames[0]) : null;
  const eventRows = useMemo(() => {
    if (!tick) return [];
    const rows: Array<{ title: string; sub: string }> = [{
      title: `A → ${ACTION_LABEL[tick.actions.a] ?? tick.actions.a} · B → ${ACTION_LABEL[tick.actions.b] ?? tick.actions.b}`,
      sub: `${tick.actions.a} / ${tick.actions.b}`,
    }];
    for (const event of tick.events ?? []) {
      const title = event.type === 'hit'
        ? `${event.by === 'a' ? 'A' : 'B'} · ${ACTION_LABEL[event.move] ?? event.move} 命中 ${event.damage}`
        : event.type === 'block'
          ? `防住 ${ACTION_LABEL[event.move] ?? event.move}`
          : event.type === 'evade' || event.type === 'parry'
            ? `${event.by === 'a' ? 'A' : 'B'} · ${EVENT_LABEL[event.type]} ${ACTION_LABEL[event.absorbed] ?? event.absorbed} · +${event.meterGain} 气`
            : EVENT_LABEL[event.type] ?? event.type;
      rows.push({ title, sub: `frame ${event.frame}` });
    }
    return rows;
  }, [tick]);

  return (
    <>
      <div className="view-head">
        <div>
          <h1>对局回放</h1>
          <p>逐拍重演 · 拖动时间轴查看任意一拍的动作、事件与完整 observation。</p>
        </div>
        <button className="ghost-btn" type="button" onClick={() => matchesQuery.refetch()} disabled={matchesQuery.isFetching}>
          <svg className="ic"><use href="#i-replay" /></svg>
          刷新对局
        </button>
      </div>

      <div className="replay-layout">
        <div className="match-list panel">
          {matches.length === 0 && <div className="empty">暂无已结束对局，稍等一局打完。</div>}
          {matches.map((m) => (
            <MatchItem key={m.matchId} match={m} active={m.matchId === matchId} onSelect={() => select(m.matchId)} />
          ))}
        </div>

        <div className="replay-main">
          <div className="stage-shell replay-stage">
            <ReplayCanvas
              ticks={replay?.ticks ?? []}
              index={index}
              match={replay?.match}
              moves={rules.data?.moves ?? {}}
              fighters={fighters}
              stages={stages}
            />
            <div className="stage-topbar">
              <span className="live-badge replay"><svg className="ic"><use href="#i-replay" /></svg>REPLAY</span>
              <span className="mono frame-readout">
                {frame ? `FRAME ${String(frame.frame).padStart(4, '0')} · TICK ${String(index).padStart(4, '0')}${tick?.round ? ` · ROUND ${tick.round}` : ''}` : '未选择对局'}
              </span>
            </div>
          </div>

          <div className="replay-controls panel">
            <button className="play-btn" type="button" onClick={() => setPlaying((v) => !v)} disabled={!replay?.ticks.length}>
              <svg className="ic"><use href={playing ? '#i-pause' : '#i-play'} /></svg>
            </button>
            <input
              type="range"
              min={0}
              max={max}
              value={Math.min(index, max)}
              step={1}
              onChange={(event) => { setPlaying(false); setIndex(Number(event.target.value)); }}
            />
            <span className="mono">{String(index + 1).padStart(3, '0')} / {replay?.ticks.length ?? 0}</span>
          </div>

          {error && <div className="acc-error">{error}</div>}

          <div className="replay-detail">
            <div className="panel">
              <div className="panel-head"><h2>本拍动作与事件</h2></div>
              <div className="event-list compact">
                {eventRows.length === 0 && <div className="empty">选择一局回放</div>}
                {eventRows.map((row, i) => (
                  <div className={`ev${i > 0 ? ' ev-hit' : ''}`} key={i}>
                    <span className="ev-tick">{String(index).padStart(3, '0')}</span>
                    <div className="ev-body">
                      <div className="ev-title">{row.title}</div>
                      <div className="ev-sub mono">{row.sub}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="panel">
              <div className="panel-head"><h2>Observation (SIDE A)</h2></div>
              <pre className="json-view">{tick ? JSON.stringify(tick.observation, null, 1) : '—'}</pre>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function MatchItem({ match, active, onSelect }: { match: MatchSummary; active: boolean; onSelect: () => void }) {
  const a = match.a as any;
  const b = match.b as any;
  const draw = match.winner === 'draw' || (match as any).winnerName === 'draw';
  return (
    <button className={`match-item${active ? ' active' : ''}`} type="button" onClick={onSelect}>
      <div className="mi-top"><span>{match.matchId.slice(0, 18)}</span><span>{String(match.ticks ?? '—')} 拍</span></div>
      <div className="mi-names"><b>{a?.name ?? 'A'}</b> vs <span>{b?.name ?? 'B'}</span></div>
      <div className="mi-meta">
        {match.format === 'team' ? '3v3 组队 · ' : ''}
        {draw ? '平局' : <>胜 <b className="mi-win">{String((match as any).winnerName ?? match.winner ?? '—')}</b></>}
        {' '}· {REASON_LABEL[String(match.reason)] ?? match.reason ?? '—'} · Δ {(match as any).ratingDeltaA ?? 0}
      </div>
    </button>
  );
}
