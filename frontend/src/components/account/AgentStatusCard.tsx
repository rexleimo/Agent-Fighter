import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import type { MyAgentResponse } from '../../lib/types';
import { useAppState } from '../../hooks/useAppState';

function FighterChip({ id, index }: { id: string; index: number }) {
  const state = useAppState();
  const fighter = state.data?.fighters.find((f) => f.id === id);
  return (
    <span className="acc-chip">
      <b>{index + 1}</b>
      {fighter ? `${fighter.code} ${fighter.name}` : id}
    </span>
  );
}

/** Rating trend from the agent's own counted-match history. */
function RatingSpark({ history }: { history: Array<{ result: string; rating: number }> }) {
  if (history.length < 2) return null;
  const values = history.map((h) => h.rating);
  const min = Math.min(...values), max = Math.max(...values);
  const span = Math.max(1, max - min);
  const points = values.map((v, i) => `${(i / (values.length - 1)) * 120},${30 - ((v - min) / span) * 26}`).join(' ');
  const up = values[values.length - 1] >= values[0];
  return (
    <div className="acc-spark" title={`评分趋势：${values[0]} → ${values[values.length - 1]}`}>
      <span className="acc-label">评分趋势</span>
      <svg viewBox="0 0 120 32" preserveAspectRatio="none" aria-hidden="true">
        <polyline points={points} fill="none" stroke={up ? 'var(--accent)' : 'var(--red)'} strokeWidth="2" />
      </svg>
      <span className="mono">{values[0]} → {values[values.length - 1]}</span>
    </div>
  );
}

export function AgentStatusCard({ enabled }: { enabled: boolean }) {
  const query = useQuery({
    queryKey: ['my-agent'],
    queryFn: () => api<MyAgentResponse>('/api/me/agent'),
    enabled,
    refetchInterval: 4000,
  });
  // All hooks must run before the early returns below (React hook-order rule).
  const boardQuery = useQuery({
    queryKey: ['leaderboard', 'all'],
    queryFn: () => api<{ rows: Array<{ id: string; rank: number }> }>('/api/leaderboard'),
    staleTime: 10_000,
  });

  if (!enabled) return null;
  if (query.isLoading) {
    return <section className="acc-card panel acc-wide"><div className="acc-muted">Agent 状态读取中…</div></section>;
  }
  if (query.isError) {
    return (
      <section className="acc-card panel acc-wide">
        <div className="acc-error">{query.error instanceof Error ? query.error.message : 'Agent 状态读取失败'}</div>
      </section>
    );
  }
  const data = query.data;
  if (!data) return null;
  const agent = data.agent;
  const myRank = boardQuery.data?.rows.find((r) => r.id === agent.id)?.rank ?? null;
  return (
    <section className="acc-card panel acc-wide">
      <div className="acc-card-head">
        <h2>Agent 状态</h2>
        <span className="panel-note">身份由 MCP 服务绑定，不需要人建队</span>
      </div>

      <div className="acc-agent">
        <div className="acc-agent-top">
          <div>
            <div className="acc-agent-name">{agent.name}</div>
            <div className="acc-muted mono">{agent.id} · {agent.source}</div>
          </div>
          <div className="acc-record">
            <b>{agent.wins}</b> 胜 <b>{agent.losses}</b> 负 · 评分 {agent.rating}
            {' · '}{agent.matches > 0 && myRank ? <b>第 {myRank} 名</b> : <span className="acc-muted">未上榜</span>}
          </div>
        </div>

        {/* Cost is disclosed from server-observed counters, never from a bill. */}
        <div className="acc-cost">
          <span className="acc-label">成本</span>
          {data.cost ? (
            <>
              <span>自报模型调用 <b>{data.cost.declaredModelCalls}</b> / 每局预算 {data.cost.budgetLimit}</span>
              <span>超时回落 <b>{data.cost.timeouts}</b></span>
              <span>超预算被回落 <b>{data.cost.budgetExceeded}</b></span>
              {data.cost.hosted && <span>平台逐拍求值 <b>{data.cost.hostedTicksEvaluated}</b> 拍</span>}
              <Link className="acc-cost-link" to="/training">训练场（免费 · 零模型调用 · 不计榜）</Link>
            </>
          ) : <span className="acc-muted">成本数据读取中…</span>}
          {agent.practiceMatches ? <span className="acc-tag-warn">陪练 {agent.practiceMatches} 局不计榜</span> : null}
        </div>

        <RatingSpark history={agent.ratingHistory ?? []} />

        <div className="acc-team">
          <div>
            <div className="acc-label">战队</div>
            <div className="acc-team-name">{agent.teamName || <span className="acc-muted">未命名</span>}</div>
          </div>
          <div className="acc-roster">
            {agent.team?.length
              ? agent.team.map((id, i) => <FighterChip key={id} id={id} index={i} />)
              : <span className="acc-muted">未建队 — 让 Agent 调 set_team</span>}
          </div>
        </div>

        <div className="acc-queue">
          {data.room ? (
            <>
              <span className="acc-badge live">比赛中</span>
              <code>{data.room.roomId}</code>
              <Link className="mini-btn" to={`/?view=live&room=${encodeURIComponent(data.room.roomId)}`}>观战</Link>
            </>
          ) : data.queue ? (
            <span className="acc-badge wait">排队中 {Math.round((data.queue.waitingMs || 0) / 1000)}s</span>
          ) : (
            <span className="acc-badge">未排队</span>
          )}
        </div>

        {data.recentMatches.length > 0 && (
          <>
            <div className="acc-label">最近对局</div>
            <div className="acc-matches">
              {data.recentMatches.slice(0, 4).map((m) => (
                <div className="acc-match" key={m.matchId}>
                  <span className={m.result === 'win' ? 'win' : m.result === 'loss' ? 'loss' : ''}>
                    {(m as any).reason === 'time_up_stall' ? '双方消极判负' : m.result === 'win' ? '胜' : m.result === 'loss' ? '负' : '平'}
                  </span>
                  <span>{m.opponent}</span>
                  {m.practice && <span className="acc-tag-warn">陪练不计榜</span>}
                  <span className="mono">{m.matchId}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {(data.training?.runs?.length ?? 0) > 0 && (
          <>
            <div className="acc-label">训练记录（免费 · 不计榜）</div>
            <div className="acc-training">
              {(data.training?.runs ?? []).slice(0, 3).map((run: any) => (
                <div className="acc-training-row" key={run.at + run.versionHash}>
                  <span className="mono">{new Date(run.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                  <span>{run.wins} 胜 / {run.games} 局</span>
                  <span>强度 <b>{run.strengthIndex ?? '—'}</b></span>
                  <span className="mono">{(run.versionHash || '').slice(0, 10)}</span>
                </div>
              ))}
            </div>
            <Link className="mini-btn" to="/training">去训练场 ↗</Link>
          </>
        )}
      </div>

      <p className="acc-note">
        把 MCP 链接交给 Agent 后，对它说：
        <b>读一下 /SKILL.md，调用 get_my_profile，然后 set_team 建队、submit_strategy 提交策略、join_queue(format=&quot;team&quot;) 报名。</b>
      </p>
    </section>
  );
}
