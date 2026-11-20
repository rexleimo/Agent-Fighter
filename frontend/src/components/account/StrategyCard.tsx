import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { parseJson } from '../../lib/json';
import type { MyStrategyResponse } from '../../lib/types';
import { JsonEditor } from './JsonEditor';

const TEMPLATE = {
  name: 'my-strategy',
  defaultAction: 'block',
  rules: [{ when: { 'derived.threat': 'jump_in', 'derived.inRange.dp': true }, action: 'dp' }, { action: 'block' }],
};

/** Session-authenticated view/editor for the submitted hosted strategy. */
export function StrategyCard() {
  const client = useQueryClient();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const query = useQuery({
    queryKey: ['my-strategy'],
    queryFn: () => api<MyStrategyResponse>('/api/me/strategy'),
    retry: false,
  });

  useEffect(() => {
    if (query.data) setText(query.data.strategy ? JSON.stringify(query.data.strategy, null, 2) : JSON.stringify(TEMPLATE, null, 2));
  }, [query.data]);

  const save = async () => {
    setError(''); setSaved(false); setBusy(true);
    const parsed = await parseJson(text);
    if (!parsed.ok) {
      setError(parsed.error);
      setBusy(false);
      return;
    }
    await Promise.resolve()
      .then(() => api('/api/me/strategy', { method: 'PUT', body: JSON.stringify({ strategy: parsed.value }) }))
      .then(() => { setSaved(true); return client.invalidateQueries({ queryKey: ['my-strategy'] }); })
      .then(() => client.invalidateQueries({ queryKey: ['my-agent'] }))
      .catch((e: unknown) => {
        setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : '保存失败');
      });
    setBusy(false);
  };

  return (
    <section className="acc-card panel acc-wide">
      <div className="acc-card-head">
        <h2>托管策略</h2>
        <span className="panel-note">
          {query.data?.strategy ? `已提交 · ${query.data.ruleCount} 条规则 · ${query.data.versionHash}` : '尚未提交 · 服务端代打需要先有策略'}
        </span>
      </div>
      <p className="acc-muted acc-copy">这是服务端解释执行的声明式 JSON（不是代码）。保存后对局中会被锁定；同一份数据也可以由 Agent 通过 MCP <code>submit_strategy</code> 提交。</p>
      <JsonEditor value={text} onChange={(v) => { setText(v); setSaved(false); }} rows={18} ariaLabel="策略 JSON" />
      {error && <div className="acc-error">{error}</div>}
      <div className="acc-actions">
        <button className="ghost-btn" type="button" disabled={busy} onClick={save}>{busy ? '校验并保存…' : '校验并保存'}</button>
        {saved && <span className="acc-badge ok">已保存，版本指纹已更新</span>}
        <a className="ghost-btn" href="/examples/hosted-agent/strategy.json" target="_blank" rel="noreferrer">示例策略 ↗</a>
        <a className="ghost-btn" href="/library?file=docs%2Fadvanced.md" target="_blank" rel="noreferrer">DSL 文档 ↗</a>
      </div>
    </section>
  );
}
