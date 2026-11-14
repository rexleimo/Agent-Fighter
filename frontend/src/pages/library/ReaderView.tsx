import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MarkdownReader, Toc, buildToc, stripFrontmatter, useScrollSpy } from './MarkdownReader';
import { CopyButton, useCopy } from './useCopy';
import { CATEGORY_LABEL, type DocEntry } from './types';

async function loadDoc(url: string): Promise<string> {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error('文档载入失败：' + res.status);
  return res.text();
}

export function ReaderView({ doc, onBack }: { doc: DocEntry; onBack: () => void }) {
  const origin = window.location.origin;
  const { copied, copy } = useCopy();
  const query = useQuery({
    queryKey: ['doc-content', doc.path],
    queryFn: () => loadDoc(doc.url),
    staleTime: 60_000,
  });
  const raw = query.data ?? '';
  const isJson = doc.path.endsWith('.json');
  const pretty = useMemo(() => {
    if (!isJson || !raw) return '';
    try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
  }, [isJson, raw]);

  const toc = useMemo(() => (isJson ? [] : buildToc(stripFrontmatter(raw))), [raw, isJson]);
  const active = useScrollSpy(toc.map((t) => t.id));

  useEffect(() => {
    window.scrollTo({ top: 0 });
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key === 'Escape' && target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA') {
        event.preventDefault();
        onBack();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doc.path, onBack]);

  const prompt = doc.category === 'skill'
    ? `读一下 ${origin}/${doc.path}，按里面的说明用我给你的玩家 MCP 服务接上，先 get_my_profile 确认身份。`
    : `读一下 ${origin}/${doc.path}，把和我当前任务相关的关键口径总结给我，引用原文小节。`;

  const kb = (doc.bytes / 1024).toFixed(1);

  return (
    <div className="lib-reader">
      <div className="lib-reader-top">
        <button type="button" className="lib-back ghost-btn" onClick={onBack}>
          ← 返回目录 <kbd className="lib-kbd mono">Esc</kbd>
        </button>
        <div className="lib-reader-head">
          <h1>{doc.title}</h1>
          <div className="lib-reader-path mono">
            <span>{doc.path}</span>
            <CopyButton text={`${origin}/${doc.path}`} copyKey="path" copied={copied} onCopy={copy} />
          </div>
          <div className="lib-reader-chips">
            <span className={`lib-cat hue-${doc.category} mono`}>{CATEGORY_LABEL[doc.category]}</span>
            <span className="lib-chip mono">{doc.audience}</span>
            <span className="lib-chip mono">{doc.lines} 行</span>
            <span className="lib-chip mono">{kb} KB</span>
          </div>
        </div>
      </div>

      <div className="lib-reader-layout">
        <div className="lib-content">
          {query.isLoading && <p className="m-loading">正在载入文档…</p>}
          {query.isError && (
            <div className="m-note warn">
              {query.error instanceof Error ? query.error.message : '文档载入失败'}
              <button type="button" className="ghost-btn" onClick={() => query.refetch()}>重试</button>
            </div>
          )}
          {raw && (isJson
            ? <div className="m-code lib-json"><div className="m-code-label mono">{doc.path} · JSON</div><pre>{pretty}</pre></div>
            : <MarkdownReader md={stripFrontmatter(raw)} />)}
        </div>

        <aside className="lib-side">
          <div className="lib-side-block">
            <div className="lib-side-label mono">给 AGENT · 一键复制</div>
            <div className="lib-prompt mono">{prompt}</div>
            <CopyButton text={prompt} copyKey="prompt" copied={copied} onCopy={copy} label="复制提示词" className="lib-side-copy" />
          </div>

          <div className="lib-side-block">
            <div className="lib-side-label mono">操作</div>
            <div className="lib-actions">
              <CopyButton text={raw} copyKey="raw" copied={copied} onCopy={copy} label={query.isLoading ? '载入中…' : '复制全文'} className="lib-action" />
              <a className="lib-action ghost-btn" href={doc.url} download>
                <svg className="ic"><use href="#i-download" /></svg><span>下载文件</span>
              </a>
              <a className="lib-action ghost-btn" href={doc.url} target="_blank" rel="noreferrer">
                <svg className="ic"><use href="#i-eye" /></svg><span>原始文件 ↗</span>
              </a>
            </div>
          </div>

          {toc.length > 0 && (
            <div className="lib-side-block">
              <div className="lib-side-label mono">ON THIS PAGE · 目录</div>
              <Toc entries={toc} active={active} />
            </div>
          )}

          <div className="lib-side-block">
            <div className="lib-side-label mono">文件信息</div>
            <div className="lib-meta">
              <span>类别</span><b>{CATEGORY_LABEL[doc.category]}</b>
              <span>面向</span><b>{doc.audience}</b>
              <span>行数</span><b className="mono">{doc.lines}</b>
              <span>大小</span><b className="mono">{kb} KB</b>
            </div>
            <p className="lib-meta-desc">{doc.description}</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
