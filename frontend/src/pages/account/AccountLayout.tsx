import { createContext, useContext, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, post } from '../../lib/api';
import type { AccountContextValue, AccountCredentials, McpService, MeResponse } from '../../lib/types';
import { AuthCard } from '../../components/account/AuthCard';

const Ctx = createContext<AccountContextValue | null>(null);
export function useAccount() {
  const value = useContext(Ctx);
  if (!value) throw new Error('useAccount must be used inside AccountLayout');
  return value;
}

const NAV = [
  { to: '/me', label: '概览', desc: '资料与上手引导', icon: 'i-user', end: true },
  { to: '/me/agent', label: '我的 Agent', desc: '状态 · 队伍 · 策略', icon: 'i-terminal', end: false },
  { to: '/me/matches', label: '我的对战', desc: '战绩 · 逐拍回放', icon: 'i-replay', end: false },
  { to: '/me/access', label: '接入凭证', desc: '专属 MCP 服务', icon: 'i-lobby', end: false },
  { to: '/me/security', label: '账户安全', desc: '资料 · 密码 · 设备', icon: 'i-lock', end: false },
  { to: '/me/admin', label: '管理', desc: '玩家与权限', icon: 'i-board', end: false, admin: true },
] as const;

export function AccountLayout() {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [captchaNonce, setCaptchaNonce] = useState(0);
  const refreshCaptcha = () => setCaptchaNonce((n) => n + 1);
  const location = useLocation();

  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => api<MeResponse>('/api/me'),
    retry: false,
  });
  const unauthorized = meQuery.error instanceof ApiError && meQuery.error.status === 401;
  const me = unauthorized ? null : meQuery.data;

  const login = useMutation({
    mutationFn: (values: AccountCredentials) => post('/api/login', {
      username: values.username, password: values.password, captchaAnswer: values.captcha,
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
    onError: refreshCaptcha,
  });
  const register = useMutation({
    mutationFn: (values: AccountCredentials) => post('/api/register', {
      email: `${values.username}@players.local`,
      password: values.password,
      name: values.displayName || values.username,
      username: values.username,
      captchaAnswer: values.captcha,
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
    onError: refreshCaptcha,
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

  if (meQuery.isLoading) return <div className="acc-loading panel">正在读取玩家状态…</div>;

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
        onModeChange={(next) => { login.reset(); register.reset(); setMode(next); }}
        busy={login.isPending || register.isPending}
        serverError={(login.error ?? register.error)?.message ?? ''}
        captchaNonce={captchaNonce}
        onSubmit={(values) => (mode === 'register' ? register.mutate(values) : login.mutate(values))}
      />
    );
  }

  const isAdmin = me.player.role === 'admin';
  const visibleNav = NAV.filter((n) => !('admin' in n && n.admin) || isAdmin);
  const current = visibleNav.find((n) => n.to === location.pathname) ?? visibleNav[0];

  return (
    <Ctx.Provider value={{ me, issue, logout }}>
      <div className="acc-shell">
        <aside className="acc-sidebar">
          <div className="acc-side-head">
            <div className="acc-side-kicker mono">USER CENTER</div>
            <div className="acc-side-title">用户中心</div>
            <div className="acc-side-user">
              <span className="acc-side-avatar">{me.player.displayName.slice(0, 1)}</span>
              <span><b>{me.player.displayName}</b><small className="mono">@{me.player.username}</small></span>
            </div>
          </div>
          <nav className="acc-nav" aria-label="用户中心导航">
            {visibleNav.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) => 'acc-nav-item' + (isActive ? ' active' : '')}
              >
                <svg className="ic"><use href={`#${n.icon}`} /></svg>
                <span><b>{n.label}</b><small>{n.desc}</small></span>
              </NavLink>
            ))}
          </nav>
          <button className="ghost-btn acc-side-logout" type="button" disabled={logout.isPending} onClick={() => logout.mutate()}>
            {logout.isPending ? '退出中…' : '退出登录'}
          </button>
        </aside>
        <section className="acc-content">
          <header className="acc-content-head">
            <h1>{current.label}</h1>
            <p>{current.desc}</p>
          </header>
          <Outlet />
        </section>
      </div>
    </Ctx.Provider>
  );
}
