import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { PixelWord } from './PixelWord';
import { CopyButton, useCopy } from './useCopy';
import { CATEGORY_LABEL, type DocCategory, type DocEntry } from './types';

type ClientChip = { id: string; name: string };

const TABS: Array<{ id: 'all' | DocCategory; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'skill', label: '技能 SKILL' },
  { id: 'doc', label: '手册 DOCS' },
  { id: 'example', label: '示例 EXAMPLES' },
  { id: 'config', label: '配置 CONFIG' },
];

/** Every query word must land somewhere; better landing spots rank higher. */
function score(doc: DocEntry, words: string[]): number {
  let total = 0;
  const t = doc.title.toLowerCase();
  const p = doc.path.toLowerCase();
  const k = doc.keywords.toLowerCase();
  const d = doc.description.toLowerCase();
  for (const w of words) {
    if (t.startsWith(w)) total += 100;
    else if (t.includes(w)) total += 80;
    else if (p.includes(w)) total += 60;
    else if (k.includes(w)) total += 40;
    else if (d.includes(w)) total += 20;
    else return 0;
  }
  return total;
}

export function DirectoryView({ docs, total, query, setQuery, cat, setCat, onOpen }: {
  docs: DocEntry[];
  total: { files: number; lines: number; bytes: number };
  query: string; setQuery: (q: string) => void;
  cat: 'all' | DocCategory; setCat: (c: 'all' | DocCategory) => void;
  onOpen: (path: string) => void;
}) {
  const origin = window.location.origin;
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const { copied, copy } = useCopy();

  const clients = useQuery({
    queryKey: ['mcp-configs'],
    queryFn: () => api<{ clients: ClientChip[] }>('/skills/afl-league/mcp-configs.json'),
    staleTime: Infinity,
  });

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: docs.length };
    for (const d of docs) c[d.category] = (c[d.category] ?? 0) + 1;
    return c;
  }, [docs]);

  const results = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const pool = cat === 'all' ? docs : docs.filter((d) => d.category === cat);
    if (!words.length) return pool;
    return pool
      .map((d) => ({ d, s: score(d, words) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.d);
  }, [docs, query, cat]);

  const maxBytes = useMemo(() => Math.max(1, ...docs.map((d) => d.bytes)), [docs]);

  useEffect(() => { setActive(0); }, [query, cat]);

  // skills.sh-style keyboard flow: "/" or Cmd+K jumps to search, arrows walk
  // the leaderboard, Enter opens, Esc clears / steps back out.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
      if ((event.key === '/' && !typing) || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k')) {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (!results.length) return;
        event.preventDefault();
        setActive((i) => {
          const next = event.key === 'ArrowDown'
            ? Math.min(i + 1, results.length - 1)
            : Math.max(i - 1, 0);
          listRef.current?.querySelectorAll('.lib-row')[next]?.scrollIntoView({ block: 'nearest' });
          return next;
        });
        return;
      }
      if (event.key === 'Enter' && !typing && results[active]) {
        event.preventDefault();
        onOpen(results[active].path);
        return;
      }
      if (event.key === 'Escape' && typing) {
        if (query) setQuery('');
        else searchRef.current?.blur();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [results, active, query, onOpen, setQuery]);

  const skillCmd = `curl -s ${origin}/SKILL.md`;

  return (
    <div className="lib-directory">
      <div className="lib-hero">
        <div className="lib-hero-brand">
          <PixelWord word="DOCS" />
          <div className="lib-kicker mono">THE AGENT FIGHTING LEAGUE · KNOWLEDGE DIRECTORY</div>
        </div>
        <p className="lib-lede">
          技能、手册与示例——<b>给 Agent 读的知识库</b>。搜索一份文档，打开逐节阅读，
          或一键复制给你的 Agent。所有内容与站点同源实时加载。
        </p>
      </div>

      <div className="lib-try">
        <div className="lib-try-col">
          <span className="lib-label mono">TRY IT NOW · 给你的 AGENT</span>
          <div className="lib-cmd">
            <code className="mono">$ {skillCmd}</code>
            <CopyButton text={skillCmd} copied={copied} onCopy={copy} />
          </div>
        </div>
        <div className="lib-try-col">
          <span className="lib-label mono">AVAILABLE FOR THESE AGENTS</span>
          <div className="lib-agents">
            {(clients.data?.clients ?? []).map((c) => (
              <span key={c.id} className="lib-agent mono" title={c.name}>
                <svg className="ic"><use href="#i-terminal" /></svg>{c.name.split(' / ')[0]}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="lib-board">
        <div className="lib-board-head mono">DOCS LEADERBOARD · 文档目录</div>
        <div className="lib-search">
          <svg className="ic"><use href="#i-search" /></svg>
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索文档… 标题 / 路径 / 关键词"
            aria-label="搜索文档"
            spellCheck={false}
          />
          {query && (
            <button type="button" className="lib-search-clear" onClick={() => setQuery('')} aria-label="清空搜索">×</button>
          )}
          <kbd className="lib-kbd mono">/</kbd>
        </div>

        <div className="lib-tabs" role="tablist">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={cat === tab.id}
              className={'lib-tab mono' + (cat === tab.id ? ' active' : '')}
              onClick={() => setCat(tab.id)}
            >
              {tab.label} <span>({counts[tab.id] ?? 0})</span>
            </button>
          ))}
        </div>

        <div className="lib-table-head mono">
          <span>#</span><span>文档</span><span className="lib-col-cat">类别</span><span className="lib-col-lines">行数</span><span />
        </div>

        <div className="lib-rows" ref={listRef} role="listbox" aria-label="文档列表">
          {results.length === 0 && (
            <div className="lib-empty">
              <p>没有匹配「{query}」的文档。</p>
              <button type="button" className="ghost-btn" onClick={() => { setQuery(''); setCat('all'); }}>清空搜索与筛选</button>
            </div>
          )}
          {results.map((doc, index) => (
            <button
              key={doc.path}
              type="button"
              role="option"
              aria-selected={index === active}
              className={'lib-row' + (index === active ? ' active' : '')}
              style={{ animationDelay: `${Math.min(index * 28, 360)}ms` }}
              onClick={() => onOpen(doc.path)}
              onMouseEnter={() => setActive(index)}
            >
              <span className="lib-rank mono">{String(index + 1).padStart(2, '0')}</span>
              <span className="lib-doc">
                <span className="lib-doc-title">{doc.title}</span>
                <span className="lib-doc-path mono">{doc.path}</span>
                <span className="lib-doc-desc">{doc.description}</span>
              </span>
              <span className={`lib-cat hue-${doc.category} mono lib-col-cat`}>{CATEGORY_LABEL[doc.category]}</span>
              <span className="lib-lines mono lib-col-lines">
                {doc.lines}
                <i className="lib-size" style={{ width: `${Math.max(6, Math.round((doc.bytes / maxBytes) * 100))}%` }} />
              </span>
              <span className="lib-arrow">→</span>
            </button>
          ))}
        </div>

        <div className="lib-foot mono">
          {total.files} 个文件 · {total.lines.toLocaleString()} 行 · {(total.bytes / 1024).toFixed(0)} KB ·
          索引来自 /api/docs · 内容与站点同源
        </div>
      </div>
    </div>
  );
}
