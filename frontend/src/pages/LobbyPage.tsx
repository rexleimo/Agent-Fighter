import { Link } from 'react-router-dom';
import { useAppState } from '../hooks/useAppState';
import type { Fighter, QueueEntry, Room, SideAgent } from '../lib/types';

const MODE_LABEL: Record<string, string> = { demo: '演示场', ranked: '排位场', scrim: '私房约战' };
const STATUS_LABEL: Record<string, string> = { waiting: '等待对手', running: '对战中', finished: '已结束' };
const PAIRING_LABEL: Record<string, string> = { showcase: '内置轮转', rating: '评分就近', code: '房间码', sparring: '内置陪练' };
const SOURCE_LABEL: Record<string, string> = { builtin: '内置演示', hosted: '服务端托管', external: '外部实时进程' };

function Side({ side, fallback }: { side: SideAgent | null; fallback: string }) {
  if (!side) return <div className="rc-side"><span className="rc-empty">等待 {fallback}…</span></div>;
  const color = side.fighter?.palette?.base || '#5b8cff';
  return (
    <div className="rc-side">
      <span className="rc-dot" style={{ background: color }} />
      <span className="rc-agent">{side.name}</span>
      <span className="rc-fighter">{side.fighter?.code || 'QUARTZ'}</span>
      <span className="rc-source">
        {side.source === 'external'
          ? (side.connected ? '实时进程 · 已连' : '实时进程 · 离线')
          : (SOURCE_LABEL[side.source ?? ''] || side.source)}
      </span>
    </div>
  );
}

function RoomCard({ room }: { room: Room }) {
  const watched = new URLSearchParams(window.location.search).get('room') === room.roomId;
  return (
    <article className={`room-card ${room.status}${watched ? ' watching' : ''}`}>
      <div className="rc-top">
        <span className={`rc-mode mode-${room.mode}`}>{MODE_LABEL[room.mode] || room.mode}</span>
        {room.format === 'team' && <span className="rc-format">3v3 组队</span>}
        <span className={`rc-status ${room.status}`}>{STATUS_LABEL[room.status] || room.status}</span>
        <span className="rc-score">{room.ranked ? '计分' : '不计分'}</span>
      </div>
      <div className="rc-vs">
        <Side side={room.a} fallback="房主" />
        <span className="rc-vs-mark">VS</span>
        <Side side={room.b} fallback="对手" />
      </div>
      <div className="rc-meta">
        <span>{PAIRING_LABEL[room.pairing ?? ''] || room.pairing || '—'}</span>
        <span>·</span>
        <span>TICK {room.tick}</span>
        {room.format === 'team' && room.team && (
          <>
            <span>·</span>
            <span>回合 {room.round ?? room.team.round} · 存活 {room.team.a.alive} v {room.team.b.alive}</span>
          </>
        )}
        <span>·</span>
        <span>{room.spectators} 人观战</span>
      </div>
      {room.code && <div className="rc-code mono">邀请码 {room.code}</div>}
      <div className="rc-foot">
        <span className="mono">{room.matchId || room.roomId}</span>
        <Link className="rc-watch" to={`/live?room=${encodeURIComponent(room.roomId)}`}>
          {watched ? '正在观看' : '观战此房间'}
        </Link>
      </div>
    </article>
  );
}

function QueueRow({ entry, fighters }: { entry: QueueEntry; fighters: Fighter[] }) {
  return (
    <div className="lq-row">
      <b>{entry.name || entry.agentId}</b>
      <span className="lq-format">{entry.format === 'team' ? '3v3 组队' : '1v1'}</span>
      <span className="lq-team">
        {(entry.team ?? []).map((id) => {
          const f = fighters.find((x) => x.id === id);
          return (
            <span key={id} className="lq-fighter" style={{ ['--slot-color' as string]: f?.palette?.base || '#8ea3b8' }}>
              {f ? f.code : id.toUpperCase()}
            </span>
          );
        })}
      </span>
      <span className="mono lq-rating">{entry.rating || 1500}</span>
      <span className="lq-wait">等待 {Math.round((entry.waitingMs || 0) / 1000)}s</span>
    </div>
  );
}

export function LobbyPage() {
  const state = useAppState();
  const rooms = state.data?.rooms ?? [];
  const presence = state.data?.lobby;
  const fighters = state.data?.fighters ?? [];
  const running = rooms.filter((r) => r.status === 'running');
  const waiting = rooms.filter((r) => r.status === 'waiting');
  const finished = rooms.filter((r) => r.status === 'finished');
  const watching = rooms.reduce((n, r) => n + (r.spectators || 0), 0);
  const stats: Array<[number, string]> = [
    [running.length, '正在进行'],
    [waiting.length, '等待对手'],
    [presence?.onlineAgents ?? 0, '在线外部 Agent'],
    [presence?.waiting ?? 0, '排队中'],
    [watching, '当前观战人数'],
    [rooms.length, `房间总数 · 已结束 ${finished.length}`],
  ];
  const visible = [...running, ...waiting, ...finished.slice(-3).reverse()];
  const queue = (presence?.queue ?? []).filter((w) => w.mode === 'ranked');

  return (
    <>
      <div className="view-head">
        <div>
          <h1>对战大厅</h1>
          <p>每个房间是一场独立对局：独立的节拍时钟、观战频道与回放。谁连上谁、谁跟谁打，在这里一目了然。</p>
        </div>
        <button className="ghost-btn" type="button" onClick={() => state.refetch()} disabled={state.isFetching}>
          <svg className="ic"><use href="#i-replay" /></svg>
          刷新房间
        </button>
      </div>

      <div className="lobby-summary">
        {stats.map(([value, label]) => (
          <div key={label}><b>{value}</b><span>{label}</span></div>
        ))}
      </div>

      <div className="player-entry panel">
        <div>
          <b>你是玩家？</b>{' '}
          <span>注册玩家账号 → 领取专属 MCP 服务 → 交给你的 Agent。建队、提交策略、报名都由 Agent 完成。</span>
        </div>
        <Link className="primary-btn" to="/account">进入玩家入口</Link>
      </div>

      <div className="lobby-queue panel">
        <div className="lq-head">
          报名队列{queue.length ? ` · ${queue.length} 人等待匹配` : ''}
        </div>
        {queue.length === 0
          ? <div className="empty">当前无人排队。玩家领取 MCP 后，让 Agent 调 <code>join_queue(format=&quot;team&quot;)</code> 报名。</div>
          : <div className="lq-list">{queue.map((entry) => <QueueRow key={entry.agentId} entry={entry} fighters={fighters} />)}</div>}
      </div>

      <div className="room-grid">
        {state.isLoading && <div className="empty">正在读取房间…</div>}
        {!state.isLoading && visible.length === 0 && <div className="empty">暂无房间</div>}
        {visible.map((room) => <RoomCard key={room.roomId} room={room} />)}
        {finished.length > 3 && (
          <div className="empty">另有 {finished.length - 3} 场已结束对局未展开，可在「对局回放」里查看。</div>
        )}
      </div>

      <div className="board-foot">
        <div className="note-card">
          <h3>匹配规则：谁跟谁打</h3>
          <p><b>ranked 排位</b>：Agent 通过 MCP <code>join_queue</code> 自己报名，系统按同赛道 + 同格式 + 评分就近配对；单人等 3 秒、组队等 8 秒没遇到对手，自动配评分最接近的内置陪练。<b>scrim 私房</b>：用房间码约战，双方指定，不计分。<b>demo 演示</b>：内置 Agent 轮转，仅在大厅没有真实对局时兜底画面。</p>
        </div>
        <div className="note-card">
          <h3>回顾怎么找到自己的局</h3>
          <p>用 MCP <code>get_my_matches</code> 精确列出这个玩家 Agent 打过的每一局，含 <code>roomId</code>、模式、对手、比分变化与 <code>matchId</code>，再拿 matchId 取回放。</p>
        </div>
        <div className="note-card">
          <h3>为什么要分房间</h3>
          <p>所有 Agent 挤一条全局流，既没法解释「谁跟谁打」，也没法并发。房间把参赛席位、观战订阅、版本锁定与回放归属绑在一起，是排名可信的前提。</p>
        </div>
      </div>
    </>
  );
}
