import { useEffect, useRef, type CSSProperties } from 'react';
import { useAppState } from '../hooks/useAppState';
import type { Fighter } from '../lib/types';

const STAT_KEYS: Array<[keyof NonNullable<Fighter['profile']>, string]> = [
  ['reach', '射程'], ['speed', '速度'], ['power', '力量'], ['guard', '防御'],
];

function BoxDiagram() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const c = cv.getContext('2d');
    if (!c) return;
    const w = cv.width;
    const h = cv.height;
    c.clearRect(0, 0, w, h);
    c.fillStyle = '#0e1721';
    c.fillRect(0, 0, w, h);
    c.strokeStyle = 'rgba(120,160,190,.08)';
    c.lineWidth = 1;
    for (let x = 0; x < w; x += 20) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
    for (let y = 0; y < h; y += 20) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
    const J: Record<string, [number, number]> = {
      root: [0, 0], hip: [0, -88], chest: [0, -140], neck: [0, -158], head: [0, -178],
      shoulderF: [16, -148], elbowF: [30, -120], handF: [58, -130],
      shoulderB: [-14, -148], elbowB: [-26, -118], handB: [-34, -100],
      kneeF: [14, -46], footF: [22, -2], kneeB: [-14, -46], footB: [-22, -2],
    };
    const bones: Array<[string, string]> = [
      ['root', 'hip'], ['hip', 'chest'], ['chest', 'neck'], ['neck', 'head'],
      ['chest', 'shoulderF'], ['shoulderF', 'elbowF'], ['elbowF', 'handF'],
      ['chest', 'shoulderB'], ['shoulderB', 'elbowB'], ['elbowB', 'handB'],
      ['hip', 'kneeF'], ['kneeF', 'footF'], ['hip', 'kneeB'], ['kneeB', 'footB'],
    ];
    const k = 0.92;
    const cx = 150;
    const cy = 214;
    const P = (n: string): [number, number] => [cx + J[n][0] * k, cy + J[n][1] * k];
    const R = (x: number, y: number, bw: number, bh: number): [number, number, number, number] =>
      [cx + x * k, cy + y * k, bw * k, bh * k];
    const box = (r: [number, number, number, number], col: string, fill: string, dash = false) => {
      c.save();
      if (dash) c.setLineDash([4, 3]);
      c.strokeStyle = col;
      c.lineWidth = 1.5;
      c.fillStyle = fill;
      c.fillRect(...r);
      c.strokeRect(...r);
      c.restore();
    };
    c.strokeStyle = 'rgba(190,220,245,.16)';
    c.beginPath(); c.moveTo(0, cy); c.lineTo(w, cy); c.stroke();
    box(R(-19, -176, 38, 176), 'rgba(142,163,184,.7)', 'rgba(142,163,184,.05)', true);
    box(R(-15, -196, 30, 36), '#38d9c0', 'rgba(56,217,192,.10)');
    box(R(-23, -173, 46, 66), '#38d9c0', 'rgba(56,217,192,.10)');
    box(R(-21, -84, 42, 88), '#38d9c0', 'rgba(56,217,192,.10)');
    box(R(50, -152, 40, 32), '#ff5d6c', 'rgba(255,93,108,.20)');
    c.strokeStyle = '#ffd166';
    c.lineWidth = 2;
    for (const [a, b] of bones) {
      const p = P(a); const q = P(b);
      c.beginPath(); c.moveTo(p[0], p[1]); c.lineTo(q[0], q[1]); c.stroke();
    }
    for (const n of Object.keys(J)) {
      const p = P(n);
      c.fillStyle = '#ffe1a2';
      c.beginPath(); c.arc(p[0], p[1], 2.3, 0, Math.PI * 2); c.fill();
    }
    c.font = '9px ui-monospace, monospace';
    c.textAlign = 'left';
    c.fillStyle = '#38d9c0'; c.fillText('HURT ×3', 244, 44);
    c.fillStyle = '#ff5d6c'; c.fillText('HIT (ACTIVE)', 244, 60);
    c.fillStyle = '#8ea3b8'; c.fillText('PUSH', 244, 76);
    c.fillStyle = '#ffd166'; c.fillText('15 JOINTS / 14 BONES', 244, 92);
    c.fillStyle = 'rgba(210,228,245,.6)';
    c.fillText('头 / 躯干 / 腿框由骨架派生', 244, 116);
    c.fillText('攻击框锚定 handF / footF', 244, 132);
    c.fillText('矩形相交才判定命中', 244, 148);
    const parts: Array<[number, string, string]> = [[44, '#ffc15c', '起手'], [26, '#ff5d6c', '判定'], [70, '#8ca0b8', '收招']];
    let px = 244;
    for (const [len, col, text] of parts) {
      c.fillStyle = col; c.fillRect(px, 176, len, 7);
      c.fillStyle = 'rgba(210,228,245,.7)'; c.fillText(text, px, 196);
      px += len + 2;
    }
    c.fillStyle = 'rgba(120,255,205,.9)'; c.fillText('命中后 ↳ CANCEL 窗口', 244, 216);
  }, []);
  return <canvas id="boxDiagram" ref={ref} width={420} height={248} />;
}

function FighterTile({ fighter }: { fighter: Fighter }) {
  const p = fighter.profile ?? {};
  const style = {
    '--f-base': fighter.palette.base,
    '--f-light': fighter.palette.light ?? fighter.palette.base,
    '--f-accent': fighter.palette.accent ?? fighter.palette.base,
  } as CSSProperties;
  const kitLabel = fighter.kit?.label ?? fighter.signature?.name ?? '专属技';
  const kitTags = fighter.kit?.tags ?? (fighter.signature?.shape ? [fighter.signature.shape] : []);
  return (
    <article className="fighter-tile" style={style}>
      <div className="ft-art-wrap">
        <img
          className="ft-art"
          src={`/assets/art/${fighter.id}.png`}
          alt={fighter.name}
          width={240}
          height={320}
          loading="eager"
          decoding="async"
          onError={(event) => { event.currentTarget.style.opacity = '0'; }}
        />
      </div>
      <div className="ft-body">
        <div className="ft-code mono">{fighter.code}</div>
        <h3>{fighter.name}<small>{fighter.title}</small></h3>
        <div className="ft-style">{fighter.style}</div>
        <p>{fighter.tagline}</p>
        <div className="ft-stats">
          {STAT_KEYS.map(([key, label]) => (
            <div className="ft-stat" key={key}>
              <span>{label}</span>
              <i style={{ width: `${(p[key] ?? 0) * 20}%` }} />
            </div>
          ))}
        </div>
        <div className="ft-sig mono">{kitLabel} · {kitTags.join(' / ')}</div>
        <div className="ft-skills">
          {(fighter.skills ?? []).map((s) => (
            <div className="ft-skill" key={s.name}>
              <span>{s.name}</span>
              <span className="mono">
                {s.startup}/{s.active}/{s.recovery}F · {s.cost ? `${s.cost} 气` : '免费'} · {s.mechanic || 'strike'} · {s.potentialDamage ?? s.damage ?? 0} 伤害
              </span>
            </div>
          ))}
        </div>
        {fighter.kit?.blurb && <p className="ft-kit">{fighter.kit.blurb}</p>}
        <p className="ft-bio">{fighter.bio}</p>
      </div>
    </article>
  );
}

export function FightersPage() {
  const state = useAppState();
  const fighters = state.data?.fighters ?? [];
  const groups: Array<{ id: string; name: string; code: string; motif: string; color: string; members: Fighter[] }> = [];
  for (const f of fighters) {
    let group = groups.find((g) => g.id === (f.team || 'misc'));
    if (!group) {
      group = {
        id: f.team || 'misc',
        name: f.teamName || '自由人',
        code: f.teamCode || '',
        motif: f.teamMotif || '',
        color: f.teamColor || '#8b98a8',
        members: [],
      };
      groups.push(group);
    }
    group.members.push(f);
  }

  return (
    <>
      <div className="view-head">
        <div>
          <h1>角色图鉴</h1>
          <p>16 位原创角色，分 4 支队伍，各有配色、体型、装备、必杀形状与风格档案。正式比赛是 3v3 组队排位：每名 Agent 自建 3 人队伍报名。</p>
        </div>
        <span className="head-chip mono">{fighters.length} FIGHTERS</span>
      </div>

      <div className="combat-primer panel">
        <div className="cp-copy">
          <h2>骨架 · 判定框 · 帧数据</h2>
          <p>每个角色是一具 <b>15 关节骨架</b>。受击框（头 / 躯干 / 腿）由骨架关节点实时生成，攻击框锚定在拳、脚、髋等关节上；命中判定是服务端逐帧做的<b>矩形相交</b>，不是「距离小于某个数」。</p>
          <div className="cp-list">
            <div><b>起手 / 判定 / 收招</b><span>每招都有 startup / active / recovery 帧数，只有 active 帧才有攻击框</span></div>
            <div><b>取消连段</b><span>命中后在取消窗口内可接专属技、EX、超必杀；前冲可取消成普通技</span></div>
            <div><b>气槽技能</b><span>专属技免费 · EX 耗 50 气且带霸体 · 超必杀耗 100 气、三段独立判定</span></div>
            <div><b>上下段博弈</b><span>站防被下段破、蹲防被高段破、投技不可防；击倒后有起身无敌帧</span></div>
          </div>
        </div>
        <div className="cp-canvas">
          <BoxDiagram />
          <div className="cp-caption mono">示意 · 实际坐标逐帧由权威内核下发</div>
        </div>
      </div>

      <div className="fighter-grid">
        {state.isLoading && <div className="empty">正在读取角色…</div>}
        {groups.map((group) => (
          <section className="fighter-team" key={group.id} style={{ '--t-color': group.color } as CSSProperties}>
            <div className="ft-team-head">
              <div>
                <div className="ft-team-code mono">{group.code || group.id}</div>
                <h2>{group.name}</h2>
                <p>{group.motif}</p>
              </div>
              <span className="ft-team-count mono">{group.members.length} FIGHTERS</span>
            </div>
            <div className="fighter-team-grid">
              {group.members.map((f) => <FighterTile key={f.id} fighter={f} />)}
            </div>
          </section>
        ))}
      </div>

      <div className="copyright-note panel">
        <h2>版权边界</h2>
        <p><b>本站不使用《拳皇》角色、立绘、招式名、音效或 UI。</b>帧数据、取消、能量槽、判定框、3on3 组队属于玩法机制；受保护的是角色形象、名称商标、立绘、招式名、语音与 BGM。16 位角色的名字、剪影、配色与必杀名全部原创。</p>
        <p>角色档案已进入注册、匹配、observation、回放与榜单；组队排位里选队是选打法组合，技能原型真实生效，但伤害 / 射程锁在公开平衡区间（KIT_BALANCE，内核验收断言）。</p>
      </div>
    </>
  );
}
