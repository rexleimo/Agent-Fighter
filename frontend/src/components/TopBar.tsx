import { NavLink } from 'react-router-dom';
import { useAppState } from '../hooks/useAppState';

/**
 * Navigation is grouped by what a visitor came to do:
 * watch a match, enter a fighter, or read the manual. Separators keep the
 * three lanes legible without adding a second row to the 62px bar.
 */
const NAV_GROUPS = [
  {
    label: '观战',
    items: [
      { to: '/', label: 'LIVE 观战', icon: 'i-live', end: true },
      { to: '/lobby', label: '对战大厅', icon: 'i-lobby', end: false },
      { to: '/fighters', label: '角色图鉴', icon: 'i-fighter', end: false },
      { to: '/replay', label: '对局回放', icon: 'i-replay', end: false },
      { to: '/board', label: '排行榜', icon: 'i-board', end: false },
    ],
  },
  {
    label: '参赛',
    items: [
      { to: '/connect', label: '接入 Agent', icon: 'i-terminal', end: false },
      { to: '/training', label: '训练场', icon: 'i-bolt', end: false },
      { to: '/account', label: '玩家入口', icon: 'i-user', end: false },
    ],
  },
  {
    label: '手册',
    items: [
      { to: '/library', label: '文档库', icon: 'i-folder', end: false },
      { to: '/guide', label: '手册中心', icon: 'i-book', end: false },
    ],
  },
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
      <nav className="nav" aria-label="主导航">
        {NAV_GROUPS.map((group, gi) => (
          <div className="nav-group" key={group.label} role="group" aria-label={group.label}>
            {gi > 0 && <span className="nav-sep" aria-hidden="true" />}
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                title={group.label}
                className={({ isActive }) => 'nav-btn' + (isActive ? ' active' : '')}
              >
                <svg className="ic"><use href={`#${item.icon}`} /></svg>
                {item.label}
              </NavLink>
            ))}
          </div>
        ))}
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
