import { Link } from 'react-router-dom';
import { IntermissionDetail, type IntermissionState } from './Intermission';

const SOURCE_LABEL: Record<string, string> = {
  builtin: '官方基线（内置）', hosted: '服务端托管', external: '外部实时进程',
};
const MODE_LABEL: Record<string, string> = {
  demo: 'DEMO · 演示场', ranked: 'RANKED · 排位场', scrim: 'SCRIM · 私房',
};
const PAIRING_LABEL: Record<string, string> = {
  showcase: '官方基线轮转', rating: '评分就近', code: '房间码', sparring: '官方陪练',
};

function Metric({ value, label, alert = false }: { value: number; label: string; alert?: boolean }) {
  return (
    <div className={`sr-metric${alert ? ' alert' : ''}`}>
      <b className="mono">{value}</b>
      <span>{label}</span>
    </div>
  );
}

/**
 * The single phase-aware status rail above the stage.
 *
 * Replaces the three stacked strips (room / presence / intermission) with one
 * card that changes with match state: a large obvious phase label, a compact
 * row of numeric metric tiles, and — during a roster window — a countdown ring
 * with per-side lock chips. The explanatory copy collapses to one short line.
 */
export function BroadcastStatus({ state }: { state: any }) {
  const presence = state.presence ?? {};
  const online = Number(presence.onlineAgents ?? 0);
  const waiting = Number(presence.waiting ?? 0);
  const spectators = Number(presence.spectators ?? 0);
  const match = state.match;
  const intermission = state.intermission as IntermissionState | null;
  const sides: any[] = [match?.a, match?.b].filter(Boolean);
  const external = sides.filter((s) => s.source === 'external');

  const team = match?.format === 'team';
  const mode: string = match?.mode ?? 'demo';
  const sparring = mode === 'ranked' && match?.pairing === 'sparring';
  const tone = intermission ? 'intermission' : mode === 'ranked' ? 'ranked' : mode === 'scrim' ? 'scrim' : 'demo';

  const badge = intermission
    ? 'INTERMISSION'
    : team
      ? `TEAM · ${match.ranked ? '组队排位' : '组队淘汰赛'}`
      : (MODE_LABEL[mode] ?? mode.toUpperCase());
  const sourceTag = sides.length === 0
    ? '等待双方'
    : external.length > 0
      ? `外部进程 ${external.length}`
      : sides.every((s) => s.source === 'builtin') ? '官方基线' : '服务端托管';

  let title: string;
  let note: string;
  if (intermission) {
    title = `第 ${intermission.round} 回合结束 · 换人窗口`;
    note = '双方 Agent 各一次换人机会，超时保持原序。';
  } else if (team) {
    title = match.ranked ? '3v3 组队排位' : '3v3 组队淘汰赛';
    note = match.ranked
      ? '两名已注册玩家 Agent 对打才计胜场 · 胜者回血 15% · 回合间各一次换人。'
      : '不计分 · 胜者回血 15% · 回合间各一次换人机会。';
  } else if (mode === 'scrim') {
    title = '私房约战';
    note = '房间码配对 · 真实对局可回放 · 不计入胜场榜。';
  } else if (sparring) {
    title = '官方基线陪练局';
    note = '真实对局、可回放，但不计胜场；上榜需另一名已注册 Agent 同时报名。';
  } else if (mode === 'ranked') {
    title = '玩家排位局';
    note = `计入胜场榜 · ${PAIRING_LABEL[match?.pairing] ?? '评分就近'} · 双方镜像角色。`;
  } else {
    title = '官方基线演示局';
    note = '引擎真实打完、可逐拍回放，但不计分；到「对战大厅」看玩家对局。';
  }
  if (!intermission && match?.code) note = `${note} · 房间码 ${match.code}`;

  const sourceList = sides.length
    ? sides.map((s) => SOURCE_LABEL[s.source] ?? s.source).join(' / ')
    : '本场暂无双方数据';

  return (
    <section className={`status-rail sr-${tone}`} aria-label="当前对局状态">
      <div className="sr-main">
        <span className="sr-led" aria-hidden="true"><i /></span>
        <div className="sr-identity">
          <div className="sr-kicker">
            <span className="sr-badge mono">{badge}</span>
            <span className="sr-source-tag mono" title={sourceList}>{sourceTag}</span>
          </div>
          <h2 className="sr-title">{title}</h2>
          <p className="sr-note">{note}</p>
        </div>
        {intermission && <IntermissionDetail value={intermission} />}
      </div>
      <div className="sr-side">
        <div className="sr-metrics">
          <Metric value={online} label="在线 Agent" />
          <Metric value={waiting} label="排队" />
          <Metric value={spectators} label="观众" />
          <Metric value={external.length} label="外部进程" alert={external.length === 0} />
        </div>
        <Link className="ghost-btn sr-action" to="/lobby">
          <svg className="ic"><use href="#i-lobby" /></svg>切换房间
        </Link>
      </div>
    </section>
  );
}
