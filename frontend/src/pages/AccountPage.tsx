import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, post } from '../lib/api';
import type { McpService, MeResponse } from '../lib/types';
import { AuthCard } from '../components/account/AuthCard';
import { McpCard } from '../components/account/McpCard';
import { AgentStatusCard } from '../components/account/AgentStatusCard';
import { AdminPanel } from '../components/account/AdminPanel';

type Credentials = { username: string; password: string; displayName?: string };

export function AccountPage() {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'login' | 'register'>('login');

  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => api<MeResponse>('/api/me'),
    retry: false,
  });
  const unauthorized = meQuery.error instanceof ApiError && meQuery.error.status === 401;
  const me = unauthorized ? null : meQuery.data;

  const login = useMutation({
    mutationFn: (values: Credentials) => post('/api/auth/sign-in/username', {
      username: values.username,
      password: values.password,
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
  });
  const register = useMutation({
    mutationFn: (values: Credentials) => post('/api/auth/sign-up/email', {
      email: `${values.username}@players.local`,
      password: values.password,
      name: values.displayName || values.username,
      username: values.username,
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
  });
  const logout = useMutation({
    mutationFn: () => post('/api/auth/sign-out'),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ['me'] });
      queryClient.removeQueries({ queryKey: ['my-agent'] });
      queryClient.removeQueries({ queryKey: ['admin-players'] });
    },
  });
  const issue = useMutation({
    mutationFn: () => post<{ mcp: McpService }>('/api/me/mcp'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
  });

  function changeMode(next: 'login' | 'register') {
    login.reset();
    register.reset();
    setMode(next);
  }

  if (meQuery.isLoading) {
    return <div className="acc-loading panel">正在读取玩家状态…</div>;
  }

  if (!me) {
    if (meQuery.isError && !unauthorized) {
      return (
        <div className="acc-loading panel">
          玩家状态读取失败：{meQuery.error instanceof Error ? meQuery.error.message : '未知错误'}
          <button className="ghost-btn" type="button" onClick={() => meQuery.refetch()}>重试</button>
        </div>
      );
    }
    return (
      <AuthCard
        key={mode}
        mode={mode}
        onModeChange={changeMode}
        busy={login.isPending || register.isPending}
        serverError={(login.error ?? register.error)?.message ?? ''}
        onSubmit={(values) => {
          if (mode === 'register') register.mutate(values);
          else login.mutate(values);
        }}
      />
    );
  }

  return (
    <div className="acc-grid">
      {issue.error && <div className="acc-error acc-wide">{issue.error.message}</div>}

      <section className="acc-card panel acc-profile">
        <div className="acc-card-head">
          <h2>玩家</h2>
          <span className={`acc-badge ${me.player.role === 'admin' ? 'admin' : 'ok'}`}>{me.player.role}</span>
        </div>
        <div className="acc-player-name">{me.player.displayName}</div>
        <div className="acc-muted mono">@{me.player.username} · {me.player.id}</div>
        <div className="acc-actions">
          <button className="ghost-btn" type="button" disabled={logout.isPending} onClick={() => logout.mutate()}>
            {logout.isPending ? '退出中…' : '退出登录'}
          </button>
        </div>
      </section>

      <McpCard me={me} busy={issue.isPending} onIssue={() => issue.mutate()} error="" />
      <AgentStatusCard enabled />
      {me.player.role === 'admin' && <AdminPanel />}
    </div>
  );
}
