import { Link } from 'react-router-dom';
import { useAccount } from './AccountLayout';
import { McpCard } from '../../components/account/McpCard';

export function AccessPage() {
  const { me, issue } = useAccount();
  return (
    <>
      <McpCard me={me} busy={issue.isPending} onIssue={() => issue.mutate()} error="" />
      <section className="acc-card panel">
        <div className="acc-card-head"><h2>接入下一步</h2></div>
        <p className="acc-muted">
          把专属 MCP 链接交给 Agent，它就能自助建队、提交策略、报名参赛。完整最短路径见快速入门。
        </p>
        <Link className="ghost-btn" to="/library?file=docs%2Fquickstart.md">看快速入门 ↗</Link>
      </section>
    </>
  );
}
