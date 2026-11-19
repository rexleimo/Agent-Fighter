import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { MyMatch, MyMatchesResponse } from '../../lib/types';

const REASON_LABEL: Record<string, string> = { ko: 'KO', time_up: '时间到', elimination: '全队淘汰' };
const PAIRING_LABEL: Record<string, string> = {
  rating: '排位', sparring: '官方陪练', code: '私房', showcase: '演示',
};

function MatchRow({ match }: { match: MyMatch }) {
  const when = match.endedAt && !Number.isNaN(Date.parse(match.endedAt))
    ? new Date(match.endedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '—';
  const label = match.result === 'win' ? '胜' : match.result === 'loss' ? '负' : '平';
  return (
    <Link className="acc-my-match" to={`/replay?match=${encodeURIComponent(match.matchId)}`}>
      <span className={`acc-my-result ${match.result}`}>{label}</span>
      <span className="acc-my-opponent">
        <b>{match.opponent}</b>
        <small className="mono">
          {match.format === 'team' ? '3v3 · ' : '1v1 · '}
          {PAIRING_LABEL[match.pairing ?? ''] ?? match.mode}
          {match.practice ? ' · 陪练不计榜' : ''}
          {` · ${REASON_LABEL[match.reason ?? ''] ?? match.reason ?? '—'}`}
        </small>
      </span>
      <span className={`acc-my-delta${match.ratingDelta > 0 ? ' up' : match.ratingDelta < 0 ? ' down' : ''}`}>
        {match.ratingDelta > 0 ? '+' : ''}{match.ratingDelta || 0}
      </span>
      <span className="acc-my-when mono">{when}</span>
      <span className="acc-my-go">回放 ↗</span>
    </Link>
  );
}

/** The player's own real matches — server-filtered by session, not a demo feed. */
export function MyMatchesCard() {
  const [limit, setLimit] = useState(10);
  const [filter, setFilter] = useState<'all' | 'win' | 'loss' | 'draw'>('all');
  const [seen, setSeen] = useState<string | null>(() => window.localStorage.getItem('afl-last-match'));
  const query = useQuery({
    queryKey: ['my-matches', limit],
    queryFn: () => api<MyMatchesResponse>(`/api/me/matches?limit=${limit}`),
    refetchInterval: 15000,
  });
  const matches = query.data?.matches ?? [];
  const filtered = filter === 'all' ? matches : matches.filter((m) => m.result === filter);
  const latest = matches[0]?.matchId;
  const hasNew = Boolean(latest && seen && latest !== seen);
  const acknowledge = () => {
    if (latest) window.localStorage.setItem('afl-last-match', latest);
    setSeen(latest ?? null);
  };
  const counts = {
    all: matches.length,
    win: matches.filter((m) => m.result === 'win').length,
    loss: matches.filter((m) => m.result === 'loss').length,
    draw: matches.filter((m) => m.result === 'draw').length,
  };
  return (
    <section className="acc-card panel acc-wide">
      <div className="acc-card-head">
        <h2>我的对战 {hasNew && <span className="acc-badge wait acc-new-badge">有新对局</span>}</h2>
        <span className="panel-note">只含你自己的 Agent 打过的真实对局，点任意一行看逐拍回放</span>
      </div>
      <div className="acc-filters" role="tablist" aria-label="按结果筛选">
        {(['all', 'win', 'loss', 'draw'] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={filter === key}
            className={`acc-filter${filter === key ? ' active' : ''}`}
            onClick={() => setFilter(key)}
          >
            {{ all: '全部', win: '胜', loss: '负', draw: '平' }[key]} <span className="mono">{counts[key]}</span>
          </button>
        ))}
      </div>
      {query.isLoading && <div className="acc-muted">正在读取对战记录…</div>}
      {query.isError && <div className="acc-error">{query.error instanceof Error ? query.error.message : '读取失败'}</div>}
      {!query.isLoading && !query.isError && matches.length === 0 && (
        <div className="acc-muted acc-my-empty">
          还没有对战记录。按 <Link to="/connect">接入 Agent</Link> 的说明让 Agent 建队报名，真打一局后就会出现在这里。
        </div>
      )}
      {matches.length > 0 && filtered.length === 0 && <div className="acc-muted acc-my-empty">该筛选下没有对局。</div>}
      {filtered.length > 0 && (
        <div className="acc-my-list" onClick={acknowledge}>
          {filtered.map((m) => <MatchRow key={m.matchId} match={m} />)}
        </div>
      )}
      {matches.length >= limit && limit < 50 && (
        <button className="ghost-btn acc-my-more" type="button" onClick={() => setLimit((n) => Math.min(50, n + 10))}>
          显示更多
        </button>
      )}
    </section>
  );
}
