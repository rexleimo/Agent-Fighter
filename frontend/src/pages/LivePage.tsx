import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAppState } from '../hooks/useAppState';
import { useSpectator } from '../hooks/useSpectator';
import { StageCanvas, type ToolState } from '../components/live/StageCanvas';
import { TeamStrip } from '../components/live/TeamStrip';
import { Intermission } from '../components/live/Intermission';
import { isEnabled as soundEnabled, play as playSound, setEnabled as setSoundEnabled } from '@web/audio.js';
import type { Fighter, StageRegistry } from '../lib/types';

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
const SOURCE_LABEL: Record<string, string> = { builtin: '官方基线（内置）', hosted: '服务端托管', external: '外部实时进程' };
const MODE_LABEL: Record<string, string> = { demo: 'DEMO · 演示场', ranked: 'RANKED · 排位场', scrim: 'SCRIM · 私房' };
const PAIRING_LABEL: Record<string, string> = { showcase: '官方基线轮转', rating: '评分就近', code: '房间码', sparring: '官方陪练' };

const short = (value: unknown, size = 8) => String(value ?? '').slice(0, size);
const pct = (value: number, max: number) => `${Math.max(0, Math.min(100, (value / max) * 100))}%`;

function RoomBar({ match }: { match: any }) {
  const team = match?.format === 'team';
  const mode = match?.mode ?? 'demo';
  const sparring = mode === 'ranked' && match?.pairing === 'sparring';
  const tag = team
    ? `TEAM · 组队${match.ranked ? '排位' : '淘汰赛'}${match.code ? ` · ${match.code}` : ''}`
    : `${MODE_LABEL[mode] ?? mode}${match?.code ? ` · ${match.code}` : ''}`;
  const copy = team
    ? (match.ranked
      ? '3v3 组队排位 · 两名已注册玩家 Agent 对打才计胜场 · 胜者回血 15% · 回合间各一次换人'
      : '3v3 组队淘汰 · 不计分 · 胜者回血 15% · 回合间各一次换人机会')
    : mode === 'demo'
      ? '官方基线演示局：引擎真实打完、可逐拍回放，但不计胜场不计分。打开「对战大厅」切到任意一场玩家对局。'
      : mode === 'scrim'
        ? '不计分 · 房间码约战 · 允许不同角色'
        : sparring
          ? '排位房的官方基线陪练局：真实对局、真实回放，但不计胜场不计分；想上榜需要另一名已注册 Agent 同时报名。'
          : `计入胜场榜的玩家排位局 · ${PAIRING_LABEL[match?.pairing] ?? '评分就近'} · 双方镜像角色`;
  return (
    <div className="room-bar">
      <span className={`room-tag mode-${team ? 'team' : mode}`}>{tag}</span>
      <span className="room-copy">{copy}</span>
      <Link className="ghost-btn" to="/lobby"><svg className="ic"><use href="#i-lobby" /></svg>切换房间</Link>
    </div>
  );
}

function PresenceBar({ state }: { state: any }) {
  const presence = state.presence ?? {};
  const online = Number(presence.onlineAgents ?? 0);
  const waiting = Number(presence.waiting ?? 0);
  const match = state.match;
  const sides = [match?.a, match?.b].filter(Boolean);
  const external = sides.filter((s: any) => s.source === 'external');
  let note: string;
  if (match?.mode === 'ranked') {
    note = match.pairing === 'sparring'
      ? '排位房配到官方基线：这一局真实打完、可逐拍回放，但不计胜场不计分——榜单只统计已注册玩家 Agent 之间的战果。'
      : '真实排位对局：两名报名 Agent 按评分就近配对，战果计入胜场榜。';
  } else if (match?.mode === 'scrim') {
    note = '私房约战：凭房间码配对，不计入胜场榜。';
  } else if (online === 0 && waiting === 0) {
    note = '当前没有外部 Agent 连上，匹配队列也是空的。这一场是官方基线演示局；到「对战大厅」报名参赛即可打真实排位。';
  } else if (online === 0) {
    note = `队列里有 ${waiting} 个 Agent 等待配对；超时会配官方基线陪练（真实对局，但不计胜场榜）。`;
  } else {
    note = `有 ${online} 个外部 Agent 通过 WebSocket 在线，可在「对战大厅」切换房间观看它们的对局。`;
  }
  return (
    <div className={`presence-bar${online > 0 ? ' live' : ''}`}>
      <span className="pb-item"><i className={`pb-dot ${online > 0 ? 'on' : 'off'}`} />在线外部 Agent <b>{online}</b></span>
      <span className="pb-item">匹配队列 <b>{waiting}</b></span>
      <span className="pb-item">观众 <b>{presence.spectators ?? 0}</b></span>
      <span className="pb-item">本场来源 <b>{sides.length ? sides.map((s: any) => SOURCE_LABEL[s.source] ?? s.source).join(' / ') : '—'}</b></span>
      <span className={`pb-item${external.length ? '' : ' alert'}`}>本场外部进程 <b>{external.length}</b></span>
      <span className="pb-note">{note}</span>
    </div>
  );
}

function MatchHead({ match }: { match: any }) {
  const a = match?.a;
  const b = match?.b;
  const source = (side: any) => SOURCE_LABEL[side?.source] ?? side?.source ?? '—';
  const conn = (side: any) => side?.source === 'external' ? (side.connected ? ' · WS 已连' : ' · WS 未连') : ' · 无需长连接';
  const fighter = (side: any) => side?.fighter ? `${side.fighter.code} · ${side.fighter.name}` : '—';
  return (
    <div className="match-head">
      <div className="fighter-card side-a">
        <div className="fc-top"><span className="side-tag">SIDE A</span><span className="fc-rating">ELO {a?.rating ?? '—'}</span></div>
        <div className="fc-name">{a?.name ?? '等待连接'}</div>
        <div className="fc-label">{a?.label ?? '—'}</div>
        <div className="fc-meta"><span>{fighter(a)}</span><span className="dot-sep">·</span><span>{source(a)} · {a?.kind ?? '—'}{conn(a)}</span><span className="dot-sep">·</span><span className="mono">v:{short(a?.versionHash, 10) || '—'}</span></div>
        <div className="fc-desc">{a?.description ?? '—'}</div>
      </div>
      <div className="vs-block">
        <div className="vs-round">{match?.format === 'team' ? `回合 ${match.team?.round ?? 1}` : '第 1 局'}</div>
        <div className="vs-mark">VS</div>
        <div className="vs-sub mono">{match?.matchId ?? '—'}</div>
        <div className="vs-tick">TICK {match?.tick === undefined ? '—' : String(match.tick).padStart(3, '0')} / {match?.totalTicks ?? '—'}</div>
      </div>
      <div className="fighter-card side-b">
        <div className="fc-top"><span className="fc-rating">ELO {b?.rating ?? '—'}</span><span className="side-tag">SIDE B</span></div>
        <div className="fc-name">{b?.name ?? '等待连接'}</div>
        <div className="fc-label">{b?.label ?? '—'}</div>
        <div className="fc-meta"><span className="mono">v:{short(b?.versionHash, 10) || '—'}</span><span className="dot-sep">·</span><span>{b?.kind ?? '—'} · {source(b)}{conn(b)}</span><span className="dot-sep">·</span><span>{fighter(b)}</span></div>
        <div className="fc-desc">{b?.description ?? '—'}</div>
      </div>
    </div>
  );
}

function Hud({ frame, match }: { frame: any; match: any }) {
  const a = frame?.a ?? null;
  const b = frame?.b ?? null;
  return (
    <div className="hud">
      <div className="hud-side">
        <div className="hud-row"><span className="hud-name">{(match?.a?.name ?? 'SIDE A').toUpperCase().slice(0, 18)}</span><span className="mono hud-hp">{a ? a.hp : '—'}</span></div>
        <div className="bar hp"><i style={{ width: a ? pct(a.hp ?? 0, 1000) : '0%' }} /></div>
        <div className="bar meter"><i style={{ width: a ? pct(a.meter ?? 0, 300) : '0%' }} /></div>
      </div>
      <div className="hud-center">
        <div className="timer mono">{frame && frame.timer !== undefined ? frame.timer : '—'}</div>
        <div className="timer-cap">回合剩余</div>
      </div>
      <div className="hud-side right">
        <div className="hud-row"><span className="mono hud-hp">{b ? b.hp : '—'}</span><span className="hud-name">{(match?.b?.name ?? 'SIDE B').toUpperCase().slice(0, 18)}</span></div>
        <div className="bar hp right"><i style={{ width: b ? pct(b.hp ?? 0, 1000) : '0%' }} /></div>
        <div className="bar meter right"><i style={{ width: b ? pct(b.meter ?? 0, 300) : '0%' }} /></div>
      </div>
    </div>
  );
}

function eventTitle(event: any): string {
  const side = (key: string) => key === 'a' ? 'A' : 'B';
  switch (event.type) {
    case 'hit': return `${side(event.by)} · ${ACTION_LABEL[event.move] ?? event.move} 命中 · ${event.damage} 伤害${event.combo > 1 ? ` · ${event.combo} 连击` : ''}`;
    case 'block': return `${side(event.on)} 防住 ${ACTION_LABEL[event.move] ?? event.move} · 削血 ${event.damage}`;
    case 'spawn': return `${side(event.by)} 发出 ${ACTION_LABEL[event.move] ?? event.move}`;
    case 'ko': return `KO · 胜方 ${String(event.winner ?? '').toUpperCase()}`;
    case 'time_up': return `时间到 · 按剩余血量判定，胜方 ${String(event.winner ?? '').toUpperCase()}`;
    case 'cancel': return `${side(event.by)} · 取消连段 ${ACTION_LABEL[event.from] ?? event.from} → ${ACTION_LABEL[event.into] ?? event.into}`;
    case 'super_start': return `${side(event.by)} · 超必杀发动 · 消耗 100 气`;
    case 'armor': return `${side(event.on)} · 霸体吸收 ${event.damage} 伤害，未进入硬直`;
    case 'evade': return `${side(event.by)} · 闪避穿过 ${ACTION_LABEL[event.absorbed] ?? event.absorbed}（${event.height}）· 无伤害 + ${event.meterGain} 气`;
    case 'parry': return `${side(event.by)} · 招架 ${ACTION_LABEL[event.absorbed] ?? event.absorbed}（${event.height}）· 零伤害 + ${event.meterGain} 气`;
    case 'wakeup': return `${side(event.by)} · 起身，短暂无敌`;
    case 'move_start': return `${side(event.by)} · 发动 ${ACTION_LABEL[event.move] ?? event.move}${event.meterCost ? ` · 消耗 ${event.meterCost} 气` : ''}`;
    default: return EVENT_LABEL[event.type] ?? event.type;
  }
}

function DecisionFeed({ decisions }: { decisions: any[] }) {
  return (
    <section className="panel">
      <div className="panel-head"><h2>决策事件流</h2><span className="panel-note">每 100ms 一拍 · Agent 看到什么、为什么出这招</span></div>
      <div className="event-list">
        {decisions.length === 0 && <div className="empty">等待下一拍…</div>}
        {decisions.map((d, index) => (
          <div className="ev" key={`${d.tick}-${d.side}-${index}`}>
            <span className="ev-tick">{String(d.tick).padStart(3, '0')}</span>
            <span className={`ev-side ${d.side}`}>{d.side === 'a' ? 'A' : 'B'}</span>
            <div className="ev-body">
              <div className="ev-title">{d.text}</div>
              <div className="ev-sub mono">{d.action} · 帧优势 {d.frameAdvantage} · 距离 {d.distanceX}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function CombatFeed({ combat, budget }: { combat: any[]; budget: any }) {
  const visible = combat.filter((e) => e.type !== 'move_start' || ['special', 'ex', 'super'].includes(e.move));
  return (
    <section className="panel">
      <div className="panel-head"><h2>战斗日志</h2><span className="panel-note">命中 / 防御 / 判定 / 判负</span></div>
      <div className="event-list compact">
        {visible.length === 0 && <div className="empty">等待交火…</div>}
        {visible.map((e, index) => (
          <div className={`ev ${e.type === 'hit' ? 'ev-hit' : e.type === 'block' ? 'ev-block' : e.type === 'ko' ? 'ev-ko' : ''}`} key={`${e.tick}-${index}`}>
            <span className="ev-tick">{String(e.tick).padStart(3, '0')}</span>
            <div className="ev-body">
              <div className="ev-title">{eventTitle(e)}</div>
              <div className="ev-sub mono">frame {e.frame}{e.frameAdvantage !== undefined ? ` · adv ${e.frameAdvantage}` : ''}</div>
            </div>
          </div>
        ))}
      </div>
      {budget && (
        <div className="budget">
          {[
            ['A 平均决策耗时', `${budget.a.avgMs} ms`],
            ['A 超时 / 模型调用', `${budget.a.timeouts} / ${budget.a.modelCalls}`],
            ['B 平均决策耗时', `${budget.b.avgMs} ms`],
            ['B 超时 / 模型调用', `${budget.b.timeouts} / ${budget.b.modelCalls}`],
          ].map(([label, value]) => (
            <div className="budget-item" key={label}><span>{label}</span><b>{value}</b></div>
          ))}
        </div>
      )}
    </section>
  );
}

function Toolbar({ tools, setTools }: { tools: ToolState; setTools: (next: ToolState) => void }) {
  const [sound, setSound] = useState(soundEnabled());
  const toggleTech = () => {
    const on = !(tools.showBoxes || tools.showBones || tools.showRuler || tools.showGrid);
    setTools({ ...tools, showBoxes: on, showBones: on, showRuler: on, showGrid: on });
  };
  const toggleSound = () => {
    const next = !sound;
    setSound(next);
    setSoundEnabled(next);
    if (next) playSound('wakeup');
  };
  const items: Array<[keyof ToolState | 'tech' | 'sound', string, boolean, () => void]> = [
    ['showBoxes', '判定框', tools.showBoxes, () => setTools({ ...tools, showBoxes: !tools.showBoxes })],
    ['showBones', '骨架', tools.showBones, () => setTools({ ...tools, showBones: !tools.showBones })],
    ['showFx', '技能特效', tools.showFx, () => setTools({ ...tools, showFx: !tools.showFx })],
    ['showRuler', '距离标尺', tools.showRuler, () => setTools({ ...tools, showRuler: !tools.showRuler })],
    ['showGrid', '地面网格', tools.showGrid, () => setTools({ ...tools, showGrid: !tools.showGrid })],
    ['tech', '技术视角', tools.showBoxes || tools.showBones || tools.showRuler || tools.showGrid, toggleTech],
    ['sound', `声音 ${sound ? '开' : '关'}`, sound, toggleSound],
  ];
  return (
    <div className="stage-tools">
      {items.map(([key, label, active, action]) => (
        <button key={key} className={`tool-btn${active ? ' active' : ''}`} type="button" onClick={action}>{label}</button>
      ))}
      <span className="tool-note">默认广播视图 · 技术视角可看判定框 / 骨架 · 观战端只读</span>
    </div>
  );
}

/**
 * What the screen is actually showing. Only a ranked room pairing two
 * registrants gets the LIVE treatment; official showcase and sparring rooms
 * say so, so a picture can never be read as a ladder broadcast.
 */
function channelLabel(match: any): string {
  if (!match) return '等待真实对局';
  if (match.status === 'finished') return 'MATCH ENDED';
  if (match.mode === 'ranked') return match.pairing === 'sparring' ? 'PRACTICE · 陪练局（不计榜）' : 'MATCH LIVE';
  if (match.mode === 'scrim') return 'SCRIM · 私房局';
  return 'SHOWCASE · 官方演示局';
}

export function LivePage() {
  const [params] = useSearchParams();
  const roomId = params.get('room');
  const { state, frameQueue, current } = useSpectator(roomId);
  const app = useAppState();
  const rules = useQuery({
    queryKey: ['rules'],
    queryFn: () => api<{ moves: Record<string, any> }>('/api/rules'),
    staleTime: Infinity,
  });
  const [tools, setTools] = useState<ToolState>({
    showBoxes: false, showBones: false, showFx: true, showRuler: false, showGrid: false,
  });
  const fighters: Fighter[] = state.fighters.length ? state.fighters : (app.data?.fighters ?? []);
  const match = state.match;
  const frame = state.hud ?? match?.lastFrame ?? null;
  const team = state.team;
  // Index the server registry by id once per payload; the renderer resolves the
  // match's arena through it instead of carrying its own list of stage names.
  const stages = useMemo<StageRegistry>(() => {
    const map: StageRegistry = {};
    for (const s of app.data?.stages?.stages ?? []) map[s.id] = s;
    return map;
  }, [app.data?.stages]);

  return (
    <>
      <RoomBar match={match} />
      <PresenceBar state={state} />
      <MatchHead match={match} />
      {team && <TeamStrip team={team as any} fighters={fighters} />}
      <div className="stage-shell">
        <StageCanvas
          frameQueue={frameQueue}
          current={current}
          match={match}
          moves={rules.data?.moves ?? {}}
          fighters={fighters}
          tools={tools}
          lastResult={state.lastResult}
          stages={stages}
        />
        <div className="stage-topbar">
          <span className={`live-badge${match?.status === 'finished' || match?.mode !== 'ranked' || match?.pairing === 'sparring' ? ' replay' : ''}`}>
            <i />{channelLabel(match)}
          </span>
          <span className="mono frame-readout">
            {frame ? `FRAME ${String(frame.frame ?? 0).padStart(4, '0')} · TICK ${String(state.tick).padStart(4, '0')}` : 'FRAME — · TICK —'}
          </span>
        </div>
        <Toolbar tools={tools} setTools={setTools} />
        <Intermission value={state.intermission as any} />
      </div>
      <Hud frame={frame} match={match} />
      <div className="live-lower">
        <DecisionFeed decisions={state.decisions} />
        <CombatFeed combat={state.combat} budget={state.budget} />
      </div>
    </>
  );
}
