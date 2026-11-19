import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAppState } from '../hooks/useAppState';
import { useSpectator } from '../hooks/useSpectator';
import { StageCanvas, type ToolState } from '../components/live/StageCanvas';
import { BroadcastHud } from '../components/live/BroadcastHud';
import { BroadcastStatus } from '../components/live/BroadcastStatus';
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
      {/* One phase-aware status rail replaces the three stacked strips. */}
      <BroadcastStatus state={state} />
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
        {/* Matchup fused onto the canvas, KOF-style — no separate stacked panels. */}
        <BroadcastHud match={match} frame={frame} team={team as any} fighters={fighters} />
        <div className="stage-topbar">
          <span className={`live-badge${match?.status === 'finished' || match?.mode !== 'ranked' || match?.pairing === 'sparring' ? ' replay' : ''}`}>
            <i />{channelLabel(match)}
          </span>
          <span className="mono frame-readout">
            {frame ? `FRAME ${String(frame.frame ?? 0).padStart(4, '0')} · TICK ${String(state.tick).padStart(4, '0')}` : 'FRAME — · TICK —'}
          </span>
        </div>
        <Toolbar tools={tools} setTools={setTools} />
      </div>
      <div className="live-lower">
        <DecisionFeed decisions={state.decisions} />
        <CombatFeed combat={state.combat} budget={state.budget} />
      </div>
    </>
  );
}
