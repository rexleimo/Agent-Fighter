/**
 * Impact effects: hit rings, damage popups, guard flashes, armor rings,
 * cancel callouts, skill announcements, wakeup dust and the super flash.
 *
 * The stage canvas and the replay canvas each own one instance. They show
 * different matches, so a shared instance would age one screen's hits against
 * the other screen's frame counter — and the canvas refuses a negative radius,
 * which is exactly what a replay frame drawn against live parts produced.
 *
 * A part is born at the frame index its event carries, not at the frame that
 * happens to be on screen. The impact therefore appears on the frame where it
 * happened and ages from there, which is what lets the replay rebuild a
 * window of past ticks and still show every hit in the right place.
 */

const LIFE = 46;

const PART_TYPES = new Set([
  'hit', 'block', 'cancel', 'armor', 'counter', 'wakeup', 'super_start', 'ko', 'move_start',
]);

const SOUND_TYPES = new Set([
  'hit', 'block', 'cancel', 'armor', 'counter', 'super_start', 'ko', 'wakeup',
]);

export function createImpactFx({
  labelFor = () => '',
  plainLabel = (moveId) => moveId,
  onSound = null,
  enabled = () => true,
  ground = 330,
  framesPerTick = 6,
} = {}) {
  const seen = new Set();
  let parts = [];
  // How many ticks back an impact can still be alive: one full life, rounded
  // up, because the engine advances six frames per tick.
  const windowTicks = Math.ceil(LIFE / framesPerTick) + 1;

  function ingest(events) {
    for (const e of events || []) {
      const key = e.frame + '|' + e.type + '|' + (e.by || '') + '|' + (e.on || '') + '|' + (e.move || '');
      if (seen.has(key)) continue;
      seen.add(key);
      if (seen.size > 400) seen.clear();
      if (!PART_TYPES.has(e.type)) continue;
      parts.push({ ...e, born: e.frame, sounded: false });
    }
  }

  /**
   * A cue fires when its impact first becomes visible, not when the event
   * arrives: the server sends a whole tick at once, and a sound that played
   * on arrival would lead the picture it belongs to.
   */
  function fireSounds(now) {
    if (!onSound) return;
    for (const p of parts) {
      if (p.sounded || p.born > now) continue;
      p.sounded = true;
      if (SOUND_TYPES.has(p.type)) onSound(p.type);
    }
  }

  function draw(c, frame, match, w, h) {
    if (!frame) return;
    const now = frame.frame;
    parts = parts.filter((p) => now - p.born < LIFE);
    fireSounds(now);
    if (!enabled()) return;
    c.save();
    for (const p of parts) {
      const age = now - p.born;
      // A part born in a later frame belongs to a later moment: the replay
      // can be scrubbed backwards, so it must not be drawn here.
      if (age < 0) continue;
      const k = Math.max(0, 1 - age / LIFE);
      const x = p.x !== undefined ? p.x : w / 2;
      const y = p.y !== undefined ? ground + p.y : h * 0.45;
      c.textAlign = 'center';
      if (p.type === 'hit') {
        const r = 8 + age * 2.6;
        c.strokeStyle = 'rgba(255,196,110,' + (k * 0.9).toFixed(2) + ')';
        c.lineWidth = 3 * k + 0.6;
        c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.stroke();
        for (let i = 0; i < 8; i += 1) {
          const a = (i / 8) * Math.PI * 2 + age * 0.05;
          c.beginPath();
          c.moveTo(x + Math.cos(a) * 6, y + Math.sin(a) * 6);
          c.lineTo(x + Math.cos(a) * (16 + age), y + Math.sin(a) * (16 + age));
          c.stroke();
        }
        c.font = '700 ' + (18 + Math.min(8, age * 0.4)) + 'px ui-monospace, monospace';
        c.lineWidth = 3; c.strokeStyle = 'rgba(8,14,22,.9)';
        const txt = '-' + p.damage + (p.combo > 1 ? '  ' + p.combo + ' HIT' : '');
        c.strokeText(txt, x, y - 24 - age * 0.6);
        c.fillStyle = p.knockdown ? '#ff8a6b' : '#ffd166';
        c.fillText(txt, x, y - 24 - age * 0.6);
      } else if (p.type === 'block') {
        c.strokeStyle = 'rgba(130,205,255,' + k.toFixed(2) + ')';
        c.lineWidth = 3;
        c.beginPath(); c.arc(x, y, 22 + age * 0.8, -1.2, 1.2); c.stroke();
        c.font = '600 11px ui-monospace, monospace';
        c.fillStyle = 'rgba(170,220,255,' + k.toFixed(2) + ')';
        c.fillText('GUARD', x, y - 28 - age * 0.4);
      } else if (p.type === 'armor') {
        c.strokeStyle = 'rgba(255,200,90,' + k.toFixed(2) + ')';
        c.lineWidth = 3;
        c.beginPath(); c.arc(x, y, 30 + age, 0, Math.PI * 2); c.stroke();
        c.font = '600 11px ui-monospace, monospace';
        c.fillStyle = '#ffd166';
        c.fillText('ARMOR', x, y - 36);
      } else if (p.type === 'cancel') {
        c.font = '700 13px ui-monospace, monospace';
        c.fillStyle = 'rgba(120,255,205,' + k.toFixed(2) + ')';
        c.fillText('CANCEL → ' + plainLabel(p.into), w / 2, 118 - age * 0.5);
      } else if (p.type === 'move_start' && ['special', 'ex', 'super'].includes(p.move)) {
        const side = p.by;
        c.font = '700 14px ui-monospace, monospace';
        c.fillStyle = 'rgba(255,225,160,' + k.toFixed(2) + ')';
        c.fillText(labelFor(side, p.move, match), side === 'a' ? w * 0.27 : w * 0.73, 104 - age * 0.35);
      } else if (p.type === 'wakeup') {
        c.fillStyle = 'rgba(180,200,220,' + (k * 0.4).toFixed(2) + ')';
        for (let i = 0; i < 5; i += 1) {
          c.beginPath();
          c.arc(x + (i - 2) * 14, ground - 2 - age * 0.4, 5 + age * 0.5, 0, Math.PI * 2);
          c.fill();
        }
      }
    }

    if (frame.superFlash > 0) {
      const k = Math.min(1, frame.superFlash / 30);
      c.fillStyle = 'rgba(255,238,205,' + (0.16 * k).toFixed(3) + ')';
      c.fillRect(0, 0, w, h);
      c.save();
      c.translate(w / 2, 190);
      c.rotate(now * 0.012);
      c.strokeStyle = 'rgba(255,214,130,' + (0.32 * k).toFixed(2) + ')';
      c.lineWidth = 2;
      for (let i = 0; i < 18; i += 1) {
        const a = (i / 18) * Math.PI * 2;
        c.beginPath();
        c.moveTo(Math.cos(a) * 90, Math.sin(a) * 90);
        c.lineTo(Math.cos(a) * 620, Math.sin(a) * 620);
        c.stroke();
      }
      c.restore();
      if (frame.superFlash > 8) {
        const cast = frame.a.moveId === 'super' ? 'a' : frame.b.moveId === 'super' ? 'b' : null;
        c.textAlign = 'center';
        c.font = '800 44px ui-monospace, monospace';
        c.lineWidth = 5; c.strokeStyle = 'rgba(9,15,24,.9)';
        const title = cast ? labelFor(cast, 'super', match) : '超必杀';
        c.strokeText(title, w / 2, 196);
        c.fillStyle = '#ffe3a6';
        c.fillText(title, w / 2, 196);
        c.font = '600 11px ui-monospace, monospace';
        c.fillStyle = 'rgba(255,220,170,.75)';
        c.fillText('SUPER · 3 HIT · 100 METER', w / 2, 216);
      }
    }
    c.restore();
  }

  /**
   * Rebuild the list from scratch. The replay can be scrubbed to any tick, so
   * its impact history has to be recomputed from the ticks leading to the
   * displayed frame instead of accumulated in arrival order.
   */
  function replace(eventLists) {
    seen.clear();
    parts = [];
    for (const events of eventLists || []) ingest(events);
  }

  function reset() {
    seen.clear();
    parts = [];
  }

  return { ingest, replace, draw, reset, windowTicks };
}
