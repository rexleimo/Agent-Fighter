/**
 * KO cinematic — a compact knockout beat that keeps the game picture visible.
 *
 * The earlier version dimmed the whole arena to near-black and slammed a 122px
 * "K.O." over the centre. That collided with the full-screen intermission modal:
 * two dark overlays fought over the same pixels and hid the fight. This version
 * is the calm counterpart to the info-flow 换人 window — a soft vignette, a brief
 * flash, and a small plate with the K.O. letters in the upper third. The arena
 * and both fighters stay readable throughout, and the effects clear so nothing
 * sits over the next round.
 *
 * It owns only pixels: no engine state, no sound (the `ko` event already fires
 * the KO cue through the audio layer), no React. The stage renderer decides
 * when to trigger it and keeps the canvas dirty while `isActive()` is true.
 *
 * Timing is wall-clock, taken from the same requestAnimationFrame loop that
 * paints the stage. Passing `now` is supported so a harness can step the
 * animation deterministically.
 */

const TOTAL = 2200;          // ms until the dramatic sequence settles
const FLASH = 130;           // brief impact flash length
const SLAM_AT = 90;          // when the K.O. letters start coming down
const SLAM_LEN = 300;        // overshoot duration
const NAME_AT = 520;         // winner caption entrance
const LINE_AT = 1080;        // lower strap entrance

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t) => {
  const c = 1.70158;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};

export function createKoCinematic({
  now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
} = {}) {
  let startedAt = 0;
  let result = null;
  let accent = '#ffd166';

  /** Begin a sequence. Safe to call repeatedly: it restarts from zero. */
  function trigger(nextResult, accentColor = '#ffd166') {
    result = nextResult || null;
    accent = accentColor || '#ffd166';
    startedAt = now();
  }

  function reset() {
    result = null;
    startedAt = 0;
  }

  function hasResult() {
    return Boolean(result);
  }

  /** True only while the animation still needs new frames. */
  function isActive() {
    return Boolean(result) && now() - startedAt < TOTAL;
  }

  function draw(c, w, h) {
    if (!result) return;
    const t = Math.max(0, now() - startedAt);
    const cx = w / 2;
    // Upper third: below the broadcast HUD, above the fighters' feet. Nothing
    // here covers the whole frame the way the old centre-stage blackout did.
    const cy = h * 0.36;

    const winner = result.winnerName
      || (result.winner === 'a' ? 'A' : result.winner === 'b' ? 'B' : '—');

    c.save();

    // 1. Soft vignette — never a full-screen blackout. It peaks early and
    //    clears by ~1.2s so the arena and both fighters stay readable.
    const dim = 0.3 * clamp01(t / 180) * (1 - clamp01((t - 600) / 600));
    if (dim > 0) {
      const vignette = c.createRadialGradient(cx, h * 0.5, h * 0.22, cx, h * 0.5, w * 0.62);
      vignette.addColorStop(0, 'rgba(0,0,0,0)');
      vignette.addColorStop(1, `rgba(4,7,12,${dim.toFixed(3)})`);
      c.fillStyle = vignette;
      c.fillRect(0, 0, w, h);
    }

    // 2. Brief impact flash: a light wash + a thin streak, gone in FLASH ms.
    if (t < FLASH) {
      const k = 1 - t / FLASH;
      c.fillStyle = `rgba(255,250,230,${(0.16 * k).toFixed(3)})`;
      c.fillRect(0, 0, w, h);
      const bandH = 4 + 26 * k;
      c.fillStyle = `rgba(255,255,255,${(0.42 * k).toFixed(3)})`;
      c.fillRect(0, cy - bandH / 2, w, bandH);
    }

    // 3. Short, faint speed lines behind the letters — a hint of impact, not
    //    the old screen-wide burst. They fade well before the settle.
    const lineT = t - SLAM_AT;
    if (lineT > 0 && lineT < 700) {
      const k = 1 - lineT / 700;
      const inner = 60 + lineT * 0.4;
      const outer = inner + 120 * easeOut(clamp01(lineT / 220)) + 60;
      c.save();
      c.translate(cx, cy);
      c.rotate(t * 0.00025);
      c.lineWidth = 2;
      for (let i = 0; i < 16; i += 1) {
        const a = (i / 16) * Math.PI * 2;
        c.strokeStyle = i % 4 === 0
          ? `rgba(255,236,190,${(0.28 * k).toFixed(3)})`
          : `rgba(255,255,255,${(0.1 * k).toFixed(3)})`;
        c.beginPath();
        c.moveTo(Math.cos(a) * inner, Math.sin(a) * inner * 0.7);
        c.lineTo(Math.cos(a) * outer, Math.sin(a) * outer * 0.7);
        c.stroke();
      }
      c.restore();
    }

    // 4. Compact plate behind just the K.O. letters — not a full-frame scrim.
    if (t >= SLAM_AT) {
      const p = clamp01((t - SLAM_AT) / SLAM_LEN);
      const plateA = 0.62 * clamp01(p * 2);
      const plateW = 250;
      const plateH = 88;
      c.fillStyle = `rgba(6,10,16,${plateA.toFixed(3)})`;
      c.fillRect(cx - plateW / 2, cy - plateH / 2, plateW, plateH);
      c.strokeStyle = `rgba(255,194,96,${(0.5 * plateA).toFixed(3)})`;
      c.lineWidth = 1;
      c.strokeRect(cx - plateW / 2, cy - plateH / 2, plateW, plateH);
    }

    // 5. K.O. letters — compact, slam-in with overshoot, gold on a red drop.
    if (t >= SLAM_AT) {
      const p = clamp01((t - SLAM_AT) / SLAM_LEN);
      const scale = p < 0.72
        ? 2.0 - 1.1 * easeOut(p / 0.72)
        : 0.9 + 0.1 * easeOutBack((p - 0.72) / 0.28);
      const tilt = -0.07 * (1 - p) + 0.01;
      const size = 64;
      c.save();
      c.globalAlpha = clamp01(p * 3);
      c.translate(cx, cy - 4);
      c.rotate(tilt);
      c.scale(scale, scale);
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.font = `900 ${size}px ui-monospace, "Press Start 2P", monospace`;
      c.lineJoin = 'round';
      c.strokeStyle = '#160c05';
      c.lineWidth = 9;
      c.strokeText('K.O.', 4, 5);
      c.fillStyle = '#b3121f';
      c.fillText('K.O.', 4, 5);
      const gold = c.createLinearGradient(0, -size / 2, 0, size / 2);
      gold.addColorStop(0, '#fff6cf');
      gold.addColorStop(0.45, '#ffd166');
      gold.addColorStop(1, '#ff9f1c');
      c.strokeText('K.O.', 0, 0);
      c.fillStyle = gold;
      c.fillText('K.O.', 0, 0);
      c.restore();
    }

    // 6. Short accent rule under the plate, in the winner's colour.
    if (t >= NAME_AT - 100) {
      const p = clamp01((t - (NAME_AT - 100)) / 300);
      const barW = 220 * easeOut(p);
      c.save();
      c.globalAlpha = clamp01(p * 2);
      c.fillStyle = accent;
      c.fillRect(cx - barW / 2, cy + 50, barW, 3);
      c.restore();
    }

    // 7. Winner caption — small, under the plate. Long agent names shrink to fit.
    if (t >= NAME_AT) {
      const p = clamp01((t - NAME_AT) / 320);
      const caption = `${winner} 获胜`;
      let fontPx = 18;
      c.font = `700 ${fontPx}px ui-monospace, monospace`;
      const measured = c.measureText ? c.measureText(caption).width : 0;
      if (measured > w * 0.7) {
        fontPx = Math.max(11, Math.floor(fontPx * (w * 0.7) / measured));
        c.font = `700 ${fontPx}px ui-monospace, monospace`;
      }
      c.save();
      c.globalAlpha = clamp01(p * 1.6);
      c.translate(0, (1 - easeOut(p)) * 10);
      c.textAlign = 'center';
      c.textBaseline = 'alphabetic';
      c.lineWidth = 4;
      c.strokeStyle = 'rgba(6,10,16,.9)';
      c.strokeText(caption, cx, cy + 78);
      c.fillStyle = '#f4f7fb';
      c.fillText(caption, cx, cy + 78);
      c.restore();
    }

    // 8. Lower strap. Same copy as the plain result; never covers the arena.
    if (t >= LINE_AT) {
      const p = clamp01((t - LINE_AT) / 360);
      c.save();
      c.globalAlpha = 0.62 * p;
      c.textAlign = 'center';
      c.font = '600 11px ui-monospace, monospace';
      c.fillStyle = '#b9c9dc';
      c.fillText('KO 决胜 · 可在大厅或回放中继续观看', cx, cy + 104);
      c.restore();
    }

    c.restore();
  }

  return { trigger, reset, hasResult, isActive, draw };
}
