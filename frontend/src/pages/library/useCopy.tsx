import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Clipboard with visible feedback. Falls back to execCommand when the
 * async Clipboard API is unavailable (non-secure context), so the copy
 * action never silently does nothing.
 */
export function useCopy(timeout = 1600) {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const copy = useCallback(async (text: string, key?: string) => {
    const id = key ?? text;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } finally { ta.remove(); }
    }
    setCopied(id);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(null), timeout);
  }, [timeout]);

  return { copied, copy };
}

export function CopyButton({ text, copyKey, copied, onCopy, label, className = '' }: {
  text: string; copyKey?: string; copied: string | null;
  onCopy: (text: string, key?: string) => void; label?: string; className?: string;
}) {
  const id = copyKey ?? text;
  const done = copied === id;
  return (
    <button
      type="button"
      className={`copy-btn${done ? ' done' : ''} ${className}`}
      onClick={() => onCopy(text, id)}
      title={done ? '已复制' : '复制'}
      aria-label={done ? '已复制' : (label ?? '复制')}
    >
      <svg className="ic"><use href={done ? '#i-check' : '#i-copy'} /></svg>
      {label && <span>{done ? '已复制' : label}</span>}
    </button>
  );
}
