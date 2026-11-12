import type { Fighter } from '../../lib/types';

type Slot = { fighterId: string; hp: number; meter?: number };
type Side = { alive: number; current: string | null; order: Slot[]; fallen: string[] };
type Team = {
  format: 'team';
  round: number;
  maxRounds: number;
  over?: boolean;
  winner?: string;
  a: Side;
  b: Side;
};

function SlotView({ slot, status, fighters }: { slot: Slot; status: 'active' | 'bench' | 'fallen'; fighters: Fighter[] }) {
  const fighter = fighters.find((f) => f.id === slot.fighterId);
  const hp = status === 'fallen' ? 0 : slot.hp;
  const color = fighter?.palette?.base ?? '#8ea3b8';
  return (
    <div className={`ts-slot ${status}`} style={{ ['--slot-color' as string]: color }}>
      <span className="ts-code mono">{fighter?.code ?? slot.fighterId.toUpperCase()}</span>
      <span className="ts-name">{fighter?.name ?? slot.fighterId}</span>
      <div className="ts-hp"><i style={{ width: `${Math.max(0, Math.min(100, hp / 10))}%` }} /></div>
      <span className="ts-hp-num mono">{hp}</span>
      <span className="ts-state">{status === 'active' ? '在场' : status === 'bench' ? '替补' : '阵亡'}</span>
    </div>
  );
}

function SideView({ side, label, tone, fighters }: { side: Side; label: string; tone: 'a' | 'b'; fighters: Fighter[] }) {
  return (
    <div className={`ts-side ts-${tone}`}>
      <div className="ts-side-head">
        <span className="ts-side-tag">{label}</span>
        <span className="ts-alive">存活 <b>{side.alive}</b> / 3</span>
      </div>
      <div className="ts-slots">
        {side.order.map((slot, index) => (
          <SlotView key={slot.fighterId} slot={slot} status={index === 0 ? 'active' : 'bench'} fighters={fighters} />
        ))}
        {side.fallen.map((id) => (
          <SlotView key={id} slot={{ fighterId: id, hp: 0 }} status="fallen" fighters={fighters} />
        ))}
      </div>
    </div>
  );
}

export function TeamStrip({ team, fighters }: { team: Team | null; fighters: Fighter[] }) {
  if (!team) return null;
  return (
    <div className="team-strip">
      <div className="ts-title">
        <span className="ts-format">TEAM ELIMINATION · 3v3 组队淘汰赛</span>
        <span className="ts-rule">全队阵亡即败 · 胜者回血 15% · 回合间各一次换人</span>
      </div>
      <div className="ts-sides">
        <SideView side={team.a} label="SIDE A" tone="a" fighters={fighters} />
        <div className="ts-vs mono">VS</div>
        <SideView side={team.b} label="SIDE B" tone="b" fighters={fighters} />
      </div>
      <div className="acc-muted mono" style={{ marginTop: 8, fontSize: 10 }}>
        {team.over ? '完赛' : `回合 ${team.round} / ${team.maxRounds}`}
      </div>
    </div>
  );
}
