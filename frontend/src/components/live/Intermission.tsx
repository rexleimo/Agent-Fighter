import { useEffect, useState } from 'react';

export type IntermissionState = {
  round: number;
  remainingMs: number;
  deadlineMs?: number;
  locked?: { a?: boolean; b?: boolean };
};

/** Circumference of the countdown ring (r=16). */
const RING = 2 * Math.PI * 16;

/**
 * Intermission / 换人窗口 — the phase-detail block inside the single broadcast
 * status rail. It renders a countdown ring plus one chip per side, replacing the
 * old standalone full-width strip that piled round / timer / locks / prose into
 * one line. The stage stays visible throughout.
 */
export function IntermissionDetail({ value }: { value: IntermissionState }) {
  const [left, setLeft] = useState(value.remainingMs);

  useEffect(() => {
    const started = Date.now();
    setLeft(value.remainingMs);
    const timer = window.setInterval(() => {
      setLeft(Math.max(0, value.remainingMs - (Date.now() - started)));
    }, 100);
    return () => window.clearInterval(timer);
  }, [value]);

  const total = Math.max(1, value.deadlineMs ?? value.remainingMs ?? 8000);
  const progress = Math.max(0, Math.min(1, left / total));
  const seconds = (left / 1000).toFixed(1);
  const lockedA = Boolean(value.locked?.a);
  const lockedB = Boolean(value.locked?.b);

  return (
    <div className="sr-phase-detail" role="status" aria-live="polite">
      <div className="sr-countdown" aria-label={`换人窗口剩余 ${seconds} 秒`}>
        <svg className="sr-ring" viewBox="0 0 40 40" aria-hidden="true">
          <circle className="sr-ring-track" cx="20" cy="20" r="16" />
          <circle
            className="sr-ring-value"
            cx="20" cy="20" r="16"
            style={{ strokeDasharray: `${(progress * RING).toFixed(2)} ${RING.toFixed(2)}` }}
          />
        </svg>
        <span className="sr-ring-label mono">{seconds}<small>s</small></span>
      </div>
      <div className="sr-sides">
        <span className={`sr-side${lockedA ? ' done' : ''}`}>
          <i />A 方 <b>{lockedA ? '已锁定' : '选择中…'}</b>
        </span>
        <span className={`sr-side${lockedB ? ' done' : ''}`}>
          <i />B 方 <b>{lockedB ? '已锁定' : '选择中…'}</b>
        </span>
      </div>
    </div>
  );
}
