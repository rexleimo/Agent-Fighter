import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link } from 'react-router-dom';
import type { ResourceViewerProps } from '../lib/types';

/** Inline document viewer: fetch a project resource and show it in a modal
 *  overlay so the user never leaves the current page. */
export function ResourceViewer({ title, url, kind = 'markdown', onClose }: ResourceViewerProps) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    setText(''); setError('');
    fetch(url, { cache: 'no-cache' })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then((t) => { if (alive) setText(t); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : '载入失败'); });
    return () => { alive = false; };
  }, [url]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  const copy = () => {
    const clipboard = navigator.clipboard;
    if (!clipboard) return;
    void Promise.resolve()
      .then(() => clipboard.writeText(text))
      .then(
        () => { setCopied(true); window.setTimeout(() => setCopied(false), 1400); },
        () => { /* clipboard unavailable: keep the previous button state */ },
      );
  };

  const isJson = kind === 'json' || url.endsWith('.json');
  return (
    <div className="rv-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rv-panel" role="dialog" aria-modal="true" aria-label={title}>
        <div className="rv-head">
          <div className="rv-title"><b>{title}</b><span className="mono">{url}</span></div>
          <div className="rv-head-actions">
            <button className="mini-btn" type="button" onClick={copy}>{copied ? '已复制' : '复制全文'}</button>
            <Link className="mini-btn" to={'/library?file=' + encodeURIComponent(url.replace(/^\//, ''))}>在文档库打开</Link>
            <button className="rv-close" type="button" onClick={onClose} aria-label="关闭">×</button>
          </div>
        </div>
        <div className="rv-body">
          {error && <div className="acc-error">载入失败：{error}</div>}
          {!error && !text && <div className="muted">载入中…</div>}
          {isJson ? (
            <pre className="rv-code mono">{text}</pre>
          ) : (
            <div className="rv-markdown markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
