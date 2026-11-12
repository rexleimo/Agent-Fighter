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

export function AgentStatusCard({ enabled }: { enabled: boolean }) {
  const query = useQuery({
    queryKey: ['my-agent'],
    queryFn: () => api<MyAgentResponse>('/api/me/agent'),
    enabled,
    refetchInterval: 4000,
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
              <Link className="mini-btn" to={`/live?room=${encodeURIComponent(data.room.roomId)}`}>观战</Link>
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
                    {m.result === 'win' ? '胜' : m.result === 'loss' ? '负' : '平'}
                  </span>
                  <span>{m.opponent}</span>
                  {m.practice && <span className="acc-tag-warn">陪练不计榜</span>}
                  <span className="mono">{m.matchId}</span>
                </div>
              ))}
            </div>
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
