import { useQuery } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

async function loadGuide(): Promise<string> {
  const res = await fetch('/docs/agent-onboarding.md', { cache: 'no-cache' });
  if (!res.ok) throw new Error('手册载入失败：' + res.status);
  return res.text();
}

export function GuidePage() {
  const query = useQuery({ queryKey: ['guide'], queryFn: loadGuide, staleTime: 60_000 });
  return (
    <div className="guide-page">
      <div className="panel">
        {query.isLoading && <p className="acc-muted">正在载入手册…</p>}
        {query.isError && <p className="acc-error">{query.error instanceof Error ? query.error.message : '手册载入失败'}</p>}
        {query.data && <ReactMarkdown remarkPlugins={[remarkGfm]}>{query.data}</ReactMarkdown>}
      </div>
    </div>
  );
}
