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
  'evade', 'parry',
]);

const SOUND_TYPES = new Set([
  'hit', 'block', 'cancel', 'armor', 'counter', 'super_start', 'ko', 'wakeup', 'evade', 'parry',
]);

/**
 * Directional cues as SVG path data, authored in prototype space: origin at
 * the impact point, +x pointing where the hit travels, a shape that spans
 * about one unit. Path2D takes the string verbatim, so the geometry stays
 * readable as path grammar instead of as arithmetic inside the draw loop.
 *
 * The prototype is the left fighter's drawing. The right fighter is the same
 * path under a mirrored transform (see drawMirrored), which is what makes the
 * effects read as coming off the correct body: a guard that opens toward its
 * attacker, a spark that sprays along the punch, dust kicked behind a rising
 * head. Any of these drawn to screen coordinates would point one way for both
 * fighters, and the fighter on the right would look like it was blocking and
 * getting hit backwards.
 */
const FX_PATHS = {
  // Shield crescent bulging forward, plus a shorter inner echo.
  guard: [
    'M -0.24 -1 C 0.62 -0.86 1 -0.36 1 0 C 1 0.36 0.62 0.86 -0.24 1',
    'M 0 0.52 C 0.4 0.42 0.62 0.2 0.62 0 C 0.62 -0.2 0.4 -0.42 0 -0.52',
  ],
  // Two chevrons opening along the direction of travel.
  spark: ['M 0.14 -0.8 L 0.94 0 L 0.14 0.8', 'M 0.04 -0.44 L 0.52 0 L 0.04 0.44'],
  // Braced plate: a flat front edge with the body mass behind it.
  armor: ['M 0.74 -1 L 0.74 1', 'M 0.74 -0.62 L -0.1 -0.34 M 0.74 0.62 L -0.1 0.34'],
  // Comma-shaped puff that trails away from the direction of travel.
  dust: 'M 0.1 -0.18 C -0.52 -0.4 -1 -0.14 -0.86 0.2 C -0.74 0.5 -0.1 0.42 0.18 0.18 Z',
  // Four-point flash: the flat plane of a parry catching the attack head-on.
  parry: ['M 0 -1 L 0.34 -0.28 L 1 0 L 0.34 0.28 L 0 1 L -0.34 0.28 L -1 0 L -0.34 -0.28 Z'],
};

/** Which body a cue belongs to, and therefore which way it should face. */
const CUE_OWNER = {
  hit: 'by',        // the spark sprays along the attacker's punch
  block: 'on',      // the guard belongs to whoever blocked
  armor: 'on',      // armor absorbs on the defender's body
  wakeup: 'by',     // the fighter standing back up
  evade: 'by',      // by = whoever just moved out of the way
  parry: 'by',      // by = whoever caught the attack
};

const paths = new Map();
function fxPath(d) {
  let p = paths.get(d);
  if (!p) {
    p = new Path2D(d);
    paths.set(d, p);
  }
  return p;
}

/**
 * Draw unit-space paths mirrored for a fighter's facing. The scale is the cue
 * size, so a path never needs a second copy for the other side; lineWidth is
 * divided back out because the transform would otherwise thicken it with the
 * shape. Text stays outside this transform — mirrored glyphs are unreadable.
 */
function drawMirrored(c, x, y, facing, size, strokes) {
  c.save();
  c.translate(x, y);
  c.scale(facing * size, size);
  c.lineCap = 'round';
  c.lineJoin = 'round';
  for (const [pathData, color, width] of strokes) {
    c.strokeStyle = color;
    c.lineWidth = width / size;
    c.stroke(fxPath(pathData));
  }
  c.restore();
}

function fillMirrored(c, x, y, facing, size, pathData, color) {
  c.save();
  c.translate(x, y);
  c.scale(facing * size, size);
  c.fillStyle = color;
  c.fill(fxPath(pathData));
  c.restore();
}

export function createImpactFx({
  labelFor = () => '',
  plainLabel = (moveId) => moveId,
  onSound = null,
  enabled = () => true,
  ground = 440,
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
    // The cue's own event names whose body it belongs to (`by`/`on` carry the
    // side letters 'a'/'b', not the sides themselves), and that fighter's facing
    // says which way the shape has to open. Replay frames carry the same
    // facing, so scrubbing backwards mirrors the way the live stage did.
    const facingOf = (p, role) => {
      const f = frame[p[role]];
      return f ? (f.facing || 1) : 1;
    };
    c.save();
    for (const p of parts) {
      const age = now - p.born;
      // A part born in a later frame belongs to a later moment: the replay
      // can be scrubbed backwards, so it must not be drawn here.
      if (age < 0) continue;
      const k = Math.max(0, 1 - age / LIFE);
      const x = p.x !== undefined ? p.x : w / 2;
      const y = p.y !== undefined ? ground + p.y : h * 0.45;
      const dir = facingOf(p, CUE_OWNER[p.type] || 'by');
      c.textAlign = 'center';
      if (p.type === 'hit') {
        const r = 8 + age * 2.6;
        c.strokeStyle = 'rgba(255,196,110,' + (k * 0.9).toFixed(2) + ')';
        c.lineWidth = 3 * k + 0.6;
        c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.stroke();
        for (let i = 0; i < 8; i += 1) {
          // The star's spin has to reverse with the facing as well: a regular
          // eight-spoke figure is mirror-symmetric, so reflecting the drawing
          // is exactly negating the rotation. Spinning both sides the same way
          // is what made the right fighter's impact look like a different effect.
          const a = (i / 8) * Math.PI * 2 + dir * age * 0.05;
          c.beginPath();
          c.moveTo(x + Math.cos(a) * 6, y + Math.sin(a) * 6);
          c.lineTo(x + Math.cos(a) * (16 + age), y + Math.sin(a) * (16 + age));
          c.stroke();
        }
        drawMirrored(c, x, y, dir, 20 + age * 2.1, [
          [FX_PATHS.spark[0], 'rgba(255,236,196,' + (k * 0.95).toFixed(2) + ')', 3.4],
          [FX_PATHS.spark[1], 'rgba(255,178,96,' + (k * 0.7).toFixed(2) + ')', 2.2],
        ]);
        c.font = '700 ' + (18 + Math.min(8, age * 0.4)) + 'px ui-monospace, monospace';
        c.lineWidth = 3; c.strokeStyle = 'rgba(8,14,22,.9)';
        const txt = '-' + p.damage + (p.combo > 1 ? '  ' + p.combo + ' HIT' : '');
        c.strokeText(txt, x, y - 24 - age * 0.6);
        c.fillStyle = p.knockdown ? '#ff8a6b' : '#ffd166';
        c.fillText(txt, x, y - 24 - age * 0.6);
      } else if (p.type === 'block') {
        drawMirrored(c, x, y, dir, 22 + age * 0.8, [
          [FX_PATHS.guard[0], 'rgba(130,205,255,' + k.toFixed(2) + ')', 3],
          [FX_PATHS.guard[1], 'rgba(196,232,255,' + (k * 0.55).toFixed(2) + ')', 2],
        ]);
        c.font = '600 11px ui-monospace, monospace';
        c.fillStyle = 'rgba(170,220,255,' + k.toFixed(2) + ')';
        c.fillText('GUARD', x, y - 28 - age * 0.4);
      } else if (p.type === 'armor') {
        c.strokeStyle = 'rgba(255,200,90,' + k.toFixed(2) + ')';
        c.lineWidth = 3;
        c.beginPath(); c.arc(x, y, 30 + age, 0, Math.PI * 2); c.stroke();
        drawMirrored(c, x, y, dir, 26 + age * 0.6, [
          [FX_PATHS.armor[0], 'rgba(255,226,150,' + (k * 0.9).toFixed(2) + ')', 4],
          [FX_PATHS.armor[1], 'rgba(255,200,90,' + (k * 0.55).toFixed(2) + ')', 2.4],
        ]);
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
      } else if (p.type === 'parry') {
        // The read itself is invisible, so draw what the kernel just cancelled:
        // a flat flash where the attack was, plus the meter it bought.
        const grow = 26 + age * 1.5;
        c.strokeStyle = 'rgba(150,240,255,' + k.toFixed(2) + ')';
        c.lineWidth = 2.5 * k + 0.5;
        c.beginPath(); c.arc(x, y, grow * 0.7, 0, Math.PI * 2); c.stroke();
        drawMirrored(c, x, y, dir, grow, [
          [FX_PATHS.parry[0], 'rgba(220,250,255,' + (k * 0.95).toFixed(2) + ')', 3],
        ]);
        c.font = '700 ' + (15 + Math.min(6, age * 0.4)) + 'px ui-monospace, monospace';
        c.lineWidth = 3; c.strokeStyle = 'rgba(8,14,22,.9)';
        const txt = 'PARRY +' + (p.meterGain || 0);
        c.strokeText(txt, x, y - 30 - age * 0.5);
        c.fillStyle = '#9ef2ff';
        c.fillText(txt, x, y - 30 - age * 0.5);
      } else if (p.type === 'evade') {
        // Streaks left behind at the spot the body used to occupy, so the cue
        // reads as "it was not there any more" rather than as a weak guard.
        c.strokeStyle = 'rgba(190,225,255,' + (k * 0.75).toFixed(2) + ')';
        c.lineWidth = 2;
        for (let i = 0; i < 3; i += 1) {
          const sy = y - 16 + i * 16;
          const len = 26 + age * 1.2 - i * 5;
          c.beginPath();
          c.moveTo(x - dir * len, sy);
          c.lineTo(x - dir * len * 0.35, sy + 3);
          c.stroke();
        }
        c.font = '700 13px ui-monospace, monospace';
        c.fillStyle = 'rgba(200,235,255,' + k.toFixed(2) + ')';
        c.fillText('DODGE +' + (p.meterGain || 0), x, y - 30 - age * 0.4);
      } else if (p.type === 'wakeup') {
        // Dust kicked off the shoulder that was on the floor, so it trails
        // behind the way the fighter is facing rather than spreading evenly.
        const puff = 10 + age * 0.7;
        for (let i = 0; i < 3; i += 1) {
          const size = puff * (1 - i * 0.22);
          fillMirrored(
            c,
            x - dir * size * 0.9,
            ground - 2 - age * 0.4 - i * 3,
            dir,
            size,
            FX_PATHS.dust,
            'rgba(180,200,220,' + (k * 0.36 * (1 - i * 0.22)).toFixed(2) + ')',
          );
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
