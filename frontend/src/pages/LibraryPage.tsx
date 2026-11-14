import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { DirectoryView } from './library/DirectoryView';
import { ReaderView } from './library/ReaderView';
import type { DocCategory, DocsManifest } from './library/types';

const CATS = new Set(['all', 'skill', 'doc', 'example', 'config']);

/**
 * The skills.sh-style document directory. List and reader share one route:
 * ?file=<path> opens the reader, ?q= / ?cat= survive the round trip so Esc
 * lands back on the exact search the visitor left.
 */
export function LibraryPage() {
  const [params, setParams] = useSearchParams();
  const manifest = useQuery({
    queryKey: ['docs-manifest'],
    queryFn: () => api<DocsManifest>('/api/docs'),
    staleTime: 60_000,
  });

  const file = params.get('file');
  const query = params.get('q') ?? '';
  const rawCat = params.get('cat') ?? 'all';
  const cat = (CATS.has(rawCat) ? rawCat : 'all') as 'all' | DocCategory;

  const setQuery = useCallback((q: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (q) next.set('q', q); else next.delete('q');
      return next;
    }, { replace: true });
  }, [setParams]);

  const setCat = useCallback((c: 'all' | DocCategory) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (c !== 'all') next.set('cat', c); else next.delete('cat');
      return next;
    }, { replace: true });
  }, [setParams]);

  const open = useCallback((path: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('file', path);
      return next;
    });
  }, [setParams]);

  const back = useCallback(() => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('file');
      return next;
    });
  }, [setParams]);

  if (manifest.isLoading) {
    return (
      <div className="lib-directory">
        <div className="lib-skeleton-hero" />
        {Array.from({ length: 8 }).map((_, i) => <div key={i} className="lib-skeleton-row" style={{ animationDelay: `${i * 60}ms` }} />)}
      </div>
    );
  }

  if (manifest.isError || !manifest.data) {
    return (
      <div className="lib-directory">
        <div className="m-note warn">
          文档索引载入失败。
          <button type="button" className="ghost-btn" onClick={() => manifest.refetch()}>重试</button>
        </div>
      </div>
    );
  }

  const doc = file ? manifest.data.docs.find((d) => d.path === file) : undefined;
  if (file && !doc) {
    return (
      <div className="lib-directory">
        <div className="m-note warn">
          未收录的文件：{file}
          <button type="button" className="ghost-btn" onClick={back}>返回目录</button>
        </div>
      </div>
    );
  }

  if (doc) return <ReaderView doc={doc} onBack={back} />;

  return (
    <DirectoryView
      docs={manifest.data.docs}
      total={manifest.data.total}
      query={query}
      setQuery={setQuery}
      cat={cat}
      setCat={setCat}
      onOpen={open}
    />
  );
}
