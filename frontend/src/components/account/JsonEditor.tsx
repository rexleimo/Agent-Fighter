import { useMemo, type KeyboardEvent } from 'react';
import type { JsonEditorProps } from '../../lib/types';

/** Tokenize JSON into colored spans. Escapes HTML-safe by building React nodes, not innerHTML. */
function highlight(json: string) {
  const nodes: Array<{ text: string; cls: string }> = [];
  // Matches strings (keys + values), numbers, booleans, null, and punctuation.
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|\b(true|false|null)\b|([{}[\],:])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(json))) {
    if (m.index > last) nodes.push({ text: json.slice(last, m.index), cls: '' });
    if (m[1]) {
      // A string followed by ':' is a key.
      nodes.push({ text: m[1], cls: m[2] ? 'je-key' : 'je-str' });
      if (m[2]) nodes.push({ text: m[2], cls: '' });
    } else if (m[3]) nodes.push({ text: m[3], cls: 'je-num' });
    else if (m[4]) nodes.push({ text: m[4], cls: 'je-bool' });
    else if (m[5]) nodes.push({ text: m[5], cls: 'je-punc' });
    last = re.lastIndex;
  }
  if (last < json.length) nodes.push({ text: json.slice(last), cls: '' });
  return nodes;
}

/**
 * Editable JSON with syntax highlighting. A transparent <textarea> sits over a
 * colored <pre>; both share identical font metrics so the caret lines up.
 * Tab inserts two spaces instead of moving focus.
 */
export function JsonEditor({ value, onChange, rows = 18, ariaLabel = 'JSON' }: JsonEditorProps) {
  const tokens = useMemo(() => highlight(value), [value]);
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart, end = el.selectionEnd;
      const next = value.slice(0, start) + '  ' + value.slice(end);
      onChange(next);
      requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = start + 2; });
    }
  };
  return (
    <div className="je-wrap" style={{ ['--je-rows' as string]: rows }}>
      <pre className="je-highlight mono" aria-hidden="true">
        {tokens.map((t, i) => <span key={i} className={t.cls}>{t.text}</span>)}
        {'\n'}
      </pre>
      <textarea
        className="je-input mono"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        spellCheck={false}
        aria-label={ariaLabel}
      />
    </div>
  );
}
