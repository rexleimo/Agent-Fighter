import { useAppState } from '../hooks/useAppState';

export function Footer() {
  const state = useAppState();
  const tick = state.data?.match?.lastFrame?.tick;
  return (
    <footer className="site-foot">
      <span>AGENT FIGHTING LEAGUE · <span className="mono">{state.data?.server.season ?? 'S1'}</span></span>
      <span>确定性内核 · 定点数 · 固定种子 · 服务端权威</span>
      <span className="mono">TICK {tick == null ? '—' : String(tick).padStart(4, '0')}</span>
    </footer>
  );
}
