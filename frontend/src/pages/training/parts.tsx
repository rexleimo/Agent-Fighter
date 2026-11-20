import { useState } from 'react';
import type { DrillList, TrainingReport } from '../../lib/types';

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2, info: 3 } as const;

export function pct(n: number | null | undefined) {
  return n === null || n === undefined ? '—' : `${n}%`;
}

export function DrillPicker({ drills, picked, toggle }: {
  drills: DrillList | undefined;
  picked: string[];
  toggle: (id: string) => void;
}) {
  const [tab, setTab] = useState(0);
  if (!drills) return <p className="muted">靶单加载中…</p>;
  const groups = [
    { title: '训练靶', hint: '联赛自有 bot', items: drills.drills },
    { title: '镜像', hint: '照镜子', items: drills.mirror ? [drills.mirror] : [] },
    { title: '官方基线', hint: '同样不进榜', items: drills.baselines },
  ];
  const active = groups[tab];
  return (
    <div className="tr-drills">
      <div className="tr-drill-tabs" role="tablist">
        {groups.map((g, i) => (
          <button key={g.title} type="button" role="tab" aria-selected={i === tab}
            className={'tr-drill-tab' + (i === tab ? ' active' : '')} onClick={() => setTab(i)}>
            {g.title} <span className="mono">{g.items.length}</span>
          </button>
        ))}
      </div>
      <p className="tr-drill-tabhint">{active.hint}</p>
      <div className="tr-drill-list">
        {active.items.map((d) => (
          <button
            key={d.id}
            type="button"
            className={'tr-drill' + (picked.includes(d.id) ? ' on' : '')}
            onClick={() => toggle(d.id)}
            title={d.goal}
          >
            <span className="tr-drill-name">{d.name}</span>
            <span className="mono tr-drill-tag">{d.id}</span>
          </button>
        ))}
      </div>
      <p className="muted tr-note">{drills.note}</p>
    </div>
  );
}

export function Findings({ report }: { report: TrainingReport }) {
  const sorted = [...report.findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return (
    <div className="tr-findings">
      <h3>该怎么改</h3>
      {sorted.map((f) => (
        <div key={f.code + (f.ruleIndexes || []).join(',') + (f.opponent ?? '')} className={'tr-finding sev-' + f.severity}>
          <div className="tr-finding-head">
            <span className={'tr-sev tr-sev-' + f.severity}>{f.severity}</span>
            <span className="mono">{f.code}</span>
          </div>
          <p>{f.message}</p>
          {f.hint && <p className="tr-hint">{f.hint}</p>}
        </div>
      ))}
    </div>
  );
}
