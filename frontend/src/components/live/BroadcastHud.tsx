import { useEffect, useState } from 'react';
import type { BroadcastSide, BroadcastTeam, Fighter } from '../../lib/types';
import { loadManifest, variantFor, legacyArtUrl } from '@web/asset-store.js';

/**
 * KOF-style broadcast HUD fused onto the game stage.
 *
 * The matchup (names, HP/meter, round, timer, 3v3 roster) floats over the
 * canvas edges instead of stacking in panels above it. The roster uses each
 * fighter's `card` art cropped to the head, and the power gauge is rendered as
 * three clear stocks under each health bar. Pointer events pass through to the
 * renderer.
 */

const pct = (value: number | undefined, max: number) =>
  `${Math.max(0, Math.min(100, ((value ?? 0) / max) * 100))}%`;

/** Resolve fighter portraits from the asset manifest once; fall back to legacy art. */
function usePortraits(fighters: Fighter[]) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const ids = fighters.map((f) => f.id).join('|');
  useEffect(() => {
    let alive = true;
    loadManifest().then(
      () => {
        if (!alive) return;
        const next: Record<string, string> = {};
        for (const f of fighters) {
          const variant = variantFor(f.id, 'card');
          next[f.id] = variant?.path || legacyArtUrl(f.id);
        }
        setUrls(next);
      },
      () => {
        // Manifest unavailable: still show legacy art rather than empty frames.
        if (!alive) return;
        const next: Record<string, string> = {};
        for (const f of fighters) next[f.id] = legacyArtUrl(f.id);
        setUrls(next);
      },
    );
    return () => { alive = false; };
  }, [ids]);
  return urls;
}

/** Three 100-point stocks: 0..1 fill each. EX = half a stock, super = full. */
function PowerGauge({ meter, mirror }: { meter: number | undefined; mirror: boolean }) {
  const value = meter ?? 0;
  return (
    <div className={`bh-power ${mirror ? 'bh-power-b' : ''}`} title={`POWER ${value} / 300`}>
      <span className="bh-power-label mono">POWER</span>
      <div className="bh-power-stocks">
        {[0, 1, 2].map((i) => {
          const fill = Math.max(0, Math.min(1, (value - i * 100) / 100));
          return (
            <span className={`bh-stock ${fill >= 1 ? 'full' : ''}`} key={i}>
              <i style={{ width: pct(fill, 1) }} />
            </span>
          );
        })}
      </div>
    </div>
  );
}

function RosterPips({ side, fighters, portraits }: {
  side: BroadcastSide | undefined; fighters: Fighter[]; portraits: Record<string, string>;
}) {
  if (!side) return null;
  const slots: Array<{ id: string; hp: number; status: 'active' | 'bench' | 'fallen' }> = [
    ...side.order.map((s, i) => ({ id: s.fighterId, hp: s.hp, status: (i === 0 ? 'active' : 'bench') as 'active' | 'bench' })),
    ...side.fallen.map((id) => ({ id, hp: 0, status: 'fallen' as const })),
  ];
  return (
    <div className="bh-pips">
      {slots.map((s, i) => {
        const fighter = fighters.find((f) => f.id === s.id);
        const src = portraits[s.id];
        return (
          <div
            key={`${s.id}-${i}`}
            className={`bh-pip ${s.status}`}
            style={{ ['--pip' as string]: fighter?.palette?.base ?? 'var(--dim)' }}
            title={`${fighter?.name ?? s.id} · ${s.hp} HP`}
          >
            {src && <img className="bh-pip-face" src={src} alt="" loading="lazy" />}
            <span className="bh-pip-code mono">{fighter?.code ?? '??'}</span>
            <span className="bh-pip-bar"><i style={{ width: pct(s.hp, 1000) }} /></span>
          </div>
        );
      })}
    </div>
  );
}

function FighterSide({
  actor, frame, mirror, fighters, roster, portraits,
}: {
  actor: any; frame: any; mirror: boolean; fighters: Fighter[]; roster: BroadcastSide | undefined;
  portraits: Record<string, string>;
}) {
  const fd = frame ? (mirror ? frame.b : frame.a) : null;
  const name = actor?.name ?? '等待连接';
  const label = actor?.label ?? '—';
  const rating = actor?.rating ?? '—';
  const fighterCode = actor?.fighter?.code ?? '—';
  return (
    <div className={`bh-side ${mirror ? 'bh-b' : 'bh-a'}`}>
      <div className="bh-identity">
        <span className="bh-name">{name}</span>
        <span className="bh-elo mono">ELO {rating}</span>
      </div>
      <div className="bh-hpbar"><i style={{ width: pct(fd?.hp, 1000) }} /></div>
      <div className="bh-subline">
        <span className="bh-label">{label} · {fighterCode}</span>
      </div>
      <PowerGauge meter={fd?.meter} mirror={mirror} />
      <RosterPips side={roster} fighters={fighters} portraits={portraits} />
    </div>
  );
}

export function BroadcastHud({
  match, frame, team, fighters,
}: {
  match: any; frame: any; team: BroadcastTeam | null; fighters: Fighter[];
}) {
  const portraits = usePortraits(fighters);
  const round = match?.format === 'team'
    ? `R${team?.round ?? 1}/${team?.maxRounds ?? 3}`
    : 'R1';
  return (
    <div className="broadcast-hud" aria-hidden="true">
      <div className="bh-top">
        <FighterSide actor={match?.a} frame={frame} mirror={false} fighters={fighters} roster={team?.a} portraits={portraits} />
        <div className="bh-center">
          <div className="bh-round mono">{round}</div>
          <div className="bh-timer mono">{frame && frame.timer !== undefined ? frame.timer : '—'}</div>
          <div className="bh-vs mono">VS</div>
        </div>
        <FighterSide actor={match?.b} frame={frame} mirror fighters={fighters} roster={team?.b} portraits={portraits} />
      </div>
    </div>
  );
}
