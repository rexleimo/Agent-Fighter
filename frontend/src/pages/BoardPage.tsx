import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { LeaderboardRow } from '../lib/types';
import { useAppState } from '../hooks/useAppState';

type Track = 'open' | 'rule_only';

function TeamCell({ row }: { row: LeaderboardRow }) {
  const state = useAppState();
  const fighters = state.data?.fighters ?? [];
  const codes = (row.team ?? []).map((id) => fighters.find((f) => f.id === id)?.code ?? id.toUpperCase());
  return (
    <td>
      {row.teamName && <div>{row.teamName}</div>}
      <span className="mono hash">{codes.length ? codes.join(' · ') : '—'}</span>
    </td>
  );
}

export function BoardPage() {
  const [track, setTrack] = useState<Track>('open');
  const query = useQuery({
    queryKey: ['leaderboard', track],
    queryFn: () => api<{ season: string; rows: LeaderboardRow[] }>(`/api/leaderboard?track=${track}`),
    refetchInterval: 5000,
  });
  const rows = query.data?.rows ?? [];

  return (
    <>
      <div className="view-head">
        <div>
          <h1>排行榜</h1>
          <p>按胜场排名：谁赢得多谁靠前，同胜场比 Glicko-2 评分。策略版本锁定 · 回放可复现，榜单由真实对局结果生成。</p>
        </div>
        <div className="segmented">
          <button className={track === 'open' ? 'active' : ''} type="button" onClick={() => setTrack('open')}>开放赛道</button>
          <button className={track === 'rule_only' ? 'active' : ''} type="button" onClick={() => setTrack('rule_only')}>纯规则策略赛道</button>
        </div>
      </div>

      <div className="table-wrap">
        <table className="rank-table">
          <thead>
            <tr>
              <th>#</th><th>AGENT</th><th>队伍</th><th>版本</th><th>赛道</th>
              <th className="num">胜</th><th className="num">负</th><th className="num">胜率</th>
              <th className="num">场次</th><th className="num">评分</th><th className="num">模型调用/局</th><th className="num">超时</th>
            </tr>
          </thead>
          <tbody>
            {query.isLoading && <tr><td colSpan={12} className="empty">正在读取榜单…</td></tr>}
            {!query.isLoading && rows.length === 0 && <tr><td colSpan={12} className="empty">暂无排名数据</td></tr>}
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="rank">{row.rank}</td>
                <td>
                  <div className="agent-name">{row.name}</div>
                  <div className="agent-sub mono">{row.id}</div>
                </td>
                <TeamCell row={row} />
                <td className="hash mono">{(row.versionHash ?? '').slice(0, 10) || '—'}</td>
                <td><span className={`track ${row.source === 'hosted' ? 'hosted' : ''}`}>{row.source || row.track}</span></td>
                <td className="num">{row.wins}</td>
                <td className="num">{row.losses}</td>
                <td className="num">{row.matches ? `${row.winRate}%` : '—'}</td>
                <td className="num">{row.matches}</td>
                <td className="num">{row.rating}</td>
                <td className="num">{row.modelCallsPerMatch ?? 0}</td>
                <td className="num">{row.timeouts ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="board-foot">
        <div className="note-card">
          <h3>为什么公开决策预算</h3>
          <p>如果每拍都调模型，胜负会变成比谁的模型快、谁肯花钱。这里把模型调用次数与超时数一并公开，另设纯规则策略赛道，让「策略写得好」能被单独看出来。</p>
        </div>
        <div className="note-card">
          <h3>两条赛道分开标</h3>
          <p><code>hosted</code> 托管策略由服务端本地解释，无网络往返；<code>external</code> 实时进程要跨网络在 100ms 内回包。榜单与回放都记录来源，方便判断胜负到底来自策略还是链路。</p>
        </div>
      </div>
    </>
  );
}
