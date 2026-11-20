import { Navigate } from 'react-router-dom';
import { useAccount } from './AccountLayout';
import { AdminPanel } from '../../components/account/AdminPanel';

export function AdminPage() {
  const { me } = useAccount();
  if (me.player.role !== 'admin') return <Navigate to="/me" replace />;
  return <AdminPanel />;
}
