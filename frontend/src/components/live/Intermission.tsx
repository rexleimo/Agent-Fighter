import { useEffect, useState } from 'react';

type IntermissionState = {
  round: number;
  remainingMs: number;
  deadlineMs?: number;
  locked?: { a?: boolean; b?: boolean };
};

export function Intermission({ value }: { value: IntermissionState | null }) {
  const [left, setLeft] = useState(0);

  useEffect(() => {
    if (!value) return;
    const started = Date.now();
    setLeft(value.remainingMs);
    const timer = window.setInterval(() => {
      setLeft(Math.max(0, value.remainingMs - (Date.now() - started)));
    }, 100);
    return () => window.clearInterval(timer);
  }, [value]);

  if (!value) return null;
  const lockedA = Boolean(value.locked?.a);
  const lockedB = Boolean(value.locked?.b);
  return (
    <div className="team-intermission">
      <div className="ti-card">
        <div className="ti-kicker mono">INTERMISSION</div>
        <div className="ti-title">第 {value.round} 回合结束 · 换人窗口</div>
        <div className="ti-count mono">{(left / 1000).toFixed(1)}s</div>
        <div className="ti-locks">
          <span className={`ti-lock ${lockedA ? 'locked' : ''}`}>A 方 {lockedA ? '已锁定' : '选择中…'}</span>
          <span className={`ti-lock ${lockedB ? 'locked' : ''}`}>B 方 {lockedB ? '已锁定' : '选择中…'}</span>
        </div>
        <p className="ti-note">双方 Agent 各有一次调整出场顺序的机会（存活角色重新排序，首位下场出战）；超时未提交保持原序。人类只能观战。</p>
      </div>
    </div>
  );
}
