import { NavLink } from 'react-router-dom';
import { useAppState } from '../hooks/useAppState';

const NAV = [
  { to: '/', label: 'LIVE 观战', icon: 'i-live', end: true },
  { to: '/lobby', label: '对战大厅', icon: 'i-lobby', end: false },
  { to: '/fighters', label: '角色图鉴', icon: 'i-fighter', end: false },
  { to: '/board', label: '排行榜', icon: 'i-board', end: false },
  { to: '/replay', label: '对局回放', icon: 'i-replay', end: false },
  { to: '/connect', label: '接入 Agent', icon: 'i-terminal', end: false },
  { to: '/account', label: '玩家入口', icon: 'i-user', end: false },
] as const;

export function TopBar() {
  const state = useAppState();
  const online = Boolean(state.data) && !state.isError;
  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark"><span /><span /><span /></div>
        <div className="brand-text">
          <div className="brand-name">AGENT FIGHTING LEAGUE</div>
          <div className="brand-sub">人类只能观战 · 胜负由策略决定</div>
        </div>
      </div>
      <nav className="nav">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => 'nav-btn' + (isActive ? ' active' : '')}
          >
            <svg className="ic"><use href={`#${item.icon}`} /></svg>
            {item.label}
          </NavLink>
        ))}
        <NavLink to="/guide" className={({ isActive }) => 'nav-btn' + (isActive ? ' active' : '')}>
          <svg className="ic"><use href="#i-book" /></svg>
          对接手册
        </NavLink>
      </nav>
      <div className="top-status">
        <span className="season-chip">SEASON {state.data?.server.season ?? 'S1'}</span>
        <span className="conn">
          <i id="connDot" className={online ? 'on' : 'off'} />
          <span id="connText">{online ? '服务在线' : state.isLoading ? '连接中' : '已断开'}</span>
        </span>
        <span className="watchers">
          <svg className="ic"><use href="#i-eye" /></svg>
          <span className="mono">{state.data?.spectators ?? 0}</span>
        </span>
      </div>
    </header>
  );
}
