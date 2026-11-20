import { useAccount } from './AccountLayout';
import { SecurityCard } from '../../components/account/SecurityCard';

export function SecurityPage() {
  const { me, logout } = useAccount();
  return <SecurityCard me={me} onLogout={() => logout.mutate()} />;
}
