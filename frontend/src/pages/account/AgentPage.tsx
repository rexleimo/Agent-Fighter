import { AgentStatusCard } from '../../components/account/AgentStatusCard';
import { StrategyCard } from '../../components/account/StrategyCard';

export function AgentPage() {
  return (
    <>
      <AgentStatusCard enabled />
      <StrategyCard />
    </>
  );
}
