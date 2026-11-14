import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function slugify(text: string): string {
  return text.trim().toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Remove a leading YAML frontmatter block (--- … ---) so SKILL.md metadata
 *  (name/description) is not rendered as body text. Files without frontmatter
 *  are returned unchanged. The original raw text is still used for copy/download. */
export function stripFrontmatter(md: string): string {
  if (!/^---\r?\n/.test(md)) return md;
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/.exec(md);
  return m ? md.slice(m[0].length).replace(/^\r?\n/, '') : md;
}

function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (node && typeof node === 'object' && 'props' in node) {
    return nodeText((node as { props: { children?: ReactNode } }).props.children);
  }
  return '';
}

export type TocEntry = { id: string; text: string; level: 2 | 3 };

export function buildToc(md: string): TocEntry[] {
  const out: TocEntry[] = [];
  for (const line of md.split('\n')) {
    const m = /^(#{2,3})\s+(.+)$/.exec(line);
    if (m) out.push({ id: slugify(m[2]), text: m[2], level: m[1].length as 2 | 3 });
  }
  return out;
}

/** Tracks which heading is currently under the fixed topbar. */
export function useScrollSpy(ids: string[]): string {
  const [active, setActive] = useState('');
  useEffect(() => {
    if (!ids.length) return;
    // Synchronous read-only measurement (no rAF): correct immediately on mount and
    // never stalls when a backgrounded tab throttles requestAnimationFrame.
    const compute = () => {
      let current = ids[0] ?? '';
      for (const id of ids) {
        const el = document.getElementById('sec-' + id);
        if (el && el.getBoundingClientRect().top <= 130) current = id;
      }
      setActive((prev) => (prev === current ? prev : current));
    };
    compute();
    window.addEventListener('scroll', compute, { passive: true });
    window.addEventListener('resize', compute);
    return () => { window.removeEventListener('scroll', compute); window.removeEventListener('resize', compute); };
  }, [ids.join('|')]);
  return active;
}

export function Toc({ entries, active, onJump }: {
  entries: TocEntry[]; active: string; onJump?: (id: string) => void;
}) {
  return (
    <nav className="lib-toc">
      {entries.map((entry) => (
        <a
          key={entry.id + entry.text}
          href={'#sec-' + entry.id}
          className={'lib-toc-link lv' + entry.level + (active === entry.id ? ' active' : '')}
          onClick={(event) => {
            event.preventDefault();
            document.getElementById('sec-' + entry.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            onJump?.(entry.id);
          }}
        >
          {entry.text}
        </a>
      ))}
    </nav>
  );
}

/**
 * The manual's markdown body: heading anchors for the scrollspy TOC, and
 * scroll wrappers around bare <table>/<pre> so wide content never blows out
 * a narrow grid (the tables carry a 520px min-width).
 */
export function MarkdownReader({ md }: { md: string }) {
  const heading = (level: 2 | 3) => ({ children }: { children?: ReactNode }) => {
    const id = 'sec-' + slugify(nodeText(children));
    const Tag = level === 2 ? 'h2' : 'h3';
    return <Tag id={id}>{children}</Tag>;
  };
  const scrollWrap = (Tag: 'table' | 'pre', cls: string) =>
    ({ children }: { children?: ReactNode }) => (
      <div className={cls}><Tag>{children}</Tag></div>
    );
  return (
    <div className="markdown-body lib-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h2: heading(2),
          h3: heading(3),
          table: scrollWrap('table', 'table-wrap'),
          pre: scrollWrap('pre', 'code-block'),
        }}
      >
        {md}
      </ReactMarkdown>
    </div>
  );
}
