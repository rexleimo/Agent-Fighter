import type { ReactNode } from 'react';

/** Chapter header: mono kicker + title + lede + audience chips. */
export function ChapterBanner({ kicker, title, desc, audience }: {
  kicker: string; title: string; desc: string; audience: string[];
}) {
  return (
    <div className="m-banner">
      <div className="m-kicker">{kicker}</div>
      <h1>{title}</h1>
      <p>{desc}</p>
      <div className="m-audience">
        {audience.map((a) => <span key={a} className="m-chip">{a}</span>)}
      </div>
    </div>
  );
}

/** Numbered section inside a chapter. */
export function Sect({ no, title, id, children }: {
  no: string; title: string; id?: string; children: ReactNode;
}) {
  return (
    <section className="m-sect" id={id}>
      <div className="m-sect-head">
        <span className="m-sect-no mono">{no}</span>
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}

/** Data table with the manual's own styling (independent of markdown-body). */
export function MTable({ head, rows, compact }: {
  head: ReactNode[]; rows: ReactNode[][]; compact?: boolean;
}) {
  return (
    <div className="m-table-wrap">
      <table className={'m-table' + (compact ? ' compact' : '')}>
        <thead><tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Note({ kind = 'info', title, children }: {
  kind?: 'info' | 'warn' | 'tip'; title?: string; children: ReactNode;
}) {
  return (
    <div className={`m-note ${kind}`}>
      {title && <div className="m-note-title">{title}</div>}
      <div>{children}</div>
    </div>
  );
}

export function MCode({ children, label }: { children: string; label?: string }) {
  return (
    <div className="m-code">
      {label && <div className="m-code-label mono">{label}</div>}
      <pre>{children}</pre>
    </div>
  );
}

/** Horizontal numbered flow: step cards joined by arrows. */
export function Steps({ items }: { items: { t: string; d: string }[] }) {
  return (
    <div className="m-steps">
      {items.map((s, i) => (
        <div className="m-step-wrap" key={i}>
          <div className="m-step">
            <span className="m-step-no mono">{String(i + 1).padStart(2, '0')}</span>
            <b>{s.t}</b>
            <span>{s.d}</span>
          </div>
          {i < items.length - 1 && <i className="m-step-arrow">→</i>}
        </div>
      ))}
    </div>
  );
}

/** Key-value stat strip. */
export function Stats({ items }: { items: { k: string; v: string }[] }) {
  return (
    <div className="m-stats">
      {items.map((s) => (
        <div className="m-stat" key={s.k}>
          <b className="mono">{s.v}</b>
          <span>{s.k}</span>
        </div>
      ))}
    </div>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <code className="m-inline mono">{children}</code>;
}
