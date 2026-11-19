import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAppState } from '../hooks/useAppState';

/** Primary nav: the core loop a visitor came for — watch, then compete. */
const PRIMARY_NAV = [
  { to: '/', label: 'LIVE 观战', icon: 'i-live', end: true },
  { to: '/lobby', label: '对战大厅', icon: 'i-lobby', end: false },
  { to: '/replay', label: '对局回放', icon: 'i-replay', end: false },
  { to: '/board', label: '排行榜', icon: 'i-board', end: false },
  { to: '/connect', label: '接入 Agent', icon: 'i-terminal', end: false },
  { to: '/me', label: '用户中心', icon: 'i-user', end: false },
] as const;

/** Secondary nav: reference and docs, kept one click away. */
const MORE_NAV = [
  { to: '/fighters', label: '角色图鉴', icon: 'i-fighter', desc: '16 位原创角色与技能原型' },
  { to: '/training', label: '训练场', icon: 'i-bolt', desc: '零成本练招，不计榜' },
  { to: '/library', label: '文档库', icon: 'i-folder', desc: '技能、手册与示例' },
  { to: '/guide', label: '手册中心', icon: 'i-book', desc: '五章导读与排错' },
] as const;

export function TopBar() {
  const state = useAppState();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const online = Boolean(state.data) && !state.isError;
  const moreActive = MORE_NAV.some((item) => location.pathname === item.to);

  useEffect(() => { setOpen(false); }, [location.pathname]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const toggleMenu = () => {
    if (!open && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setMenuStyle({
        top: rect.bottom + 8,
        left: Math.max(12, Math.min(rect.left, window.innerWidth - 280)),
      });
    }
    setOpen((value) => !value);
  };

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
        {PRIMARY_NAV.map((item) => (
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
        <span className="nav-sep" aria-hidden="true" />
        <button
          ref={buttonRef}
          type="button"
          className={'nav-btn nav-more' + (open || moreActive ? ' active' : '')}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={toggleMenu}
        >
          <span className="nav-more-ico" aria-hidden="true">•••</span>更多
        </button>
        {open && (
          <div className="nav-menu" role="menu" ref={menuRef} style={menuStyle}>
            <div className="nav-menu-head mono">MORE · 更多入口</div>
            {MORE_NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                role="menuitem"
                className={({ isActive }) => 'nav-menu-item' + (isActive ? ' active' : '')}
                onClick={() => setOpen(false)}
              >
                <svg className="ic"><use href={`#${item.icon}`} /></svg>
                <span><b>{item.label}</b><small>{item.desc}</small></span>
              </NavLink>
            ))}
          </div>
        )}
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
