import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { MeResponse, MyAgentResponse } from '../../lib/types';

type Step = { key: string; label: string; hint: string; done: boolean; to?: string };

/** A live 4-step checklist: the shortest path from a fresh account to a real match. */
export function GettingStartedCard({ me }: { me: MeResponse }) {
  const agentQuery = useQuery({
    queryKey: ['my-agent'],
    queryFn: () => api<MyAgentResponse>('/api/me/agent'),
    retry: false,
  });
  const agent = agentQuery.data?.agent;
  const played = Boolean(agent && (agent.matches > 0 || (agent.practiceMatches ?? 0) > 0));
  const steps: Step[] = [
    {
      key: 'mcp',
      label: '领取 MCP 链接',
      hint: '已生成专属服务地址',
      done: Boolean(me.mcp.assigned),
    },
    {
      key: 'team',
      label: '让 Agent 建队',
      hint: 'set_team · 3 个不同角色',
      done: Boolean(agent?.team?.length === 3),
    },
    {
      key: 'strategy',
      label: '提交策略',
      hint: 'submit_strategy · 声明式规则',
      done: Boolean(agent?.hasStrategy),
    },
    {
      key: 'match',
      label: '打完第一局',
      hint: 'join_queue(format="team")',
      done: played,
    },
  ];
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;

  return (
    <section className="acc-card panel acc-wide acc-start">
      <div className="acc-card-head">
        <h2>从这里开始</h2>
        <span className="panel-note">{done} / {steps.length} 步 · 都由你的 Agent 通过 MCP 完成</span>
      </div>
      <div className="acc-steps">
        {steps.map((s, i) => (
          <div className={`acc-step${s.done ? ' done' : ''}`} key={s.key}>
            <span className="acc-step-no mono">{s.done ? '✓' : String(i + 1).padStart(2, '0')}</span>
            <div>
              <b>{s.label}</b>
              <small className="mono">{s.hint}</small>
            </div>
          </div>
        ))}
      </div>
      <p className="acc-note">
        把专属 MCP 链接交给 Agent，对它说：
        <b>读一下 /SKILL.md，先 get_my_profile 确认身份，再 set_team 建队、submit_strategy 提交策略、join_queue(format="team") 报名。</b>
        {' '}完整最短路径见 <Link to="/library?file=docs%2Fquickstart.md">快速入门</Link>。
      </p>
    </section>
  );
}
