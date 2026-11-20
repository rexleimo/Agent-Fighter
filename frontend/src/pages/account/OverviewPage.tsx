import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { MeProfileResponse } from '../../lib/types';
import { AgentStatusCard } from '../../components/account/AgentStatusCard';
import { GettingStartedCard } from '../../components/account/GettingStartedCard';
import { useAccount } from './AccountLayout';

export function OverviewPage() {
  const { me } = useAccount();
  const profileQuery = useQuery({
    queryKey: ['me-profile'],
    queryFn: () => api<MeProfileResponse>('/api/me/profile'),
    retry: false,
  });

  return (
    <>
      <section className="acc-card panel acc-overview-profile">
        <div className="acc-card-head"><h2>我的资料</h2><span className="panel-note">概览</span></div>
        <div className="acc-overview-user">
          <div className="acc-profile-avatar">
            {profileQuery.data?.image
              ? <img src={profileQuery.data.image} alt="头像" onError={(e) => { (e.currentTarget.parentElement as HTMLElement).classList.add('fallback'); }} />
              : null}
            <span>{me.player.displayName.slice(0, 1)}</span>
          </div>
          <div className="acc-overview-meta">
            <div className="acc-player-name">{me.player.displayName}</div>
            <div className="acc-muted mono">@{me.player.username} · {me.player.id}</div>
            <div className="acc-muted">{profileQuery.data?.email || '读取中…'}</div>
          </div>
          <Link className="ghost-btn" to="/me/security">编辑资料</Link>
        </div>
      </section>

      <GettingStartedCard me={me} />
      <AgentStatusCard enabled />
    </>
  );
}
