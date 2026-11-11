/**
 * Combo presentation layer: impact shake, the hit counter and the chain
 * ribbon that names every link of a string.
 *
 * The kernel already counts the chain; this module only makes it legible.
 * It is a factory so the stage canvas and the replay canvas can each own one
 * instance — they show different matches, and a shared instance would leak
 * one match's impacts into the other's screen.
 *
 * The counter reads its numbers straight off the frame (combo, comboDamage,
 * comboChain), so the live view and the replay view always agree.
 */

const COMBO_MIN = 2;
const FLICK_LIFE = 42;

function noise(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

function comboColor(n) {
  if (n >= 9) return '#ff6b6b';
  if (n >= 5) return '#ffb340';
  return '#f2f7ff';
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

export function createFx({ labelFor, colors = {} } = {}) {
  const seen = new Set();
  const impulses = [];
  const pop = { a: { born: -999, count: 0 }, b: { born: -999, count: 0 } };
  const seenCombo = { a: 0, b: 0 };
  let flash = null;
  let lastFrame = -1;

  const sideColor = (s) => colors[s] || (s === 'a' ? '#35d6a4' : '#5b8cff');
  const nameOf = (s, moveId, match) => (labelFor ? labelFor(s, moveId, match) : moveId);

  function ingest(events) {
    for (const e of events || []) {
      const key = e.frame + '|' + e.type + '|' + (e.by || '') + '|' + (e.on || '') + '|' + (e.move || '');
      if (seen.has(key)) continue;
      seen.add(key);
      if (seen.size > 400) seen.clear();
      if (e.type === 'ko') impulses.push({ born: e.frame, amp: 9, life: 38 });
      else if (e.type === 'super_start') impulses.push({ born: e.frame, amp: 6, life: 24 });
      else if (e.type === 'hit' && (e.combo || 0) >= COMBO_MIN) {
        impulses.push({ born: e.frame, amp: 1.4 + Math.min(2.6, (e.damage || 0) / 45), life: 12 });
      } else if (e.type === 'combo_end') {
        flash = { born: e.frame, count: e.count, damage: e.damage, chain: e.chain || [], by: e.by };
      }
    }
  }

  function observe(frame, extraEvents) {
    if (!frame) return;
    const f = frame.frame;
    ingest(extraEvents);
    if (f === lastFrame) return;
    lastFrame = f;
    ingest(frame.events);
    for (const s of ['a', 'b']) {
      const count = (frame[s] && frame[s].combo) || 0;
      if (count > seenCombo[s]) pop[s] = { born: f, count };
      if (count === 0 && seenCombo[s] > 0) pop[s] = { born: -999, count: 0 };
      seenCombo[s] = count;
    }
    for (let i = impulses.length - 1; i >= 0; i -= 1) {
      if (f - impulses[i].born > impulses[i].life) impulses.splice(i, 1);
    }
  }

  /**
   * Screen shake for the current frame. Deterministic: same frame, same jolt.
   *
   * The envelope is returned next to the offset on purpose. A caller that
   * reads the jolt's magnitude off |x|+|y| is reading a noise *sample*, which
   * lands anywhere between nothing and the full envelope on consecutive
   * frames — good for the jolt, wrong for anything scaled, because it makes a
   * zoom breathe at frame rate instead of easing back from the impact.
   */
  function shake(frame) {
    if (!frame) return { x: 0, y: 0, amp: 0 };
    const f = frame.frame;
    let amp = 0;
    // Hitstop freezes the simulation but not the clock: shaking during those
    // frames is what sells the impact.
    if (frame.hitstop > 0) amp += Math.min(4, frame.hitstop * 0.5);
    if (frame.superFlash > 0) amp += Math.min(6, frame.superFlash * 0.22);
    for (const im of impulses) {
      const age = f - im.born;
      if (age < 0 || age > im.life) continue;
      amp += im.amp * Math.pow(0.82, age);
    }
    if (amp <= 0.01) return { x: 0, y: 0, amp: 0 };
    amp = Math.min(amp, 11);
    return { x: noise(f * 1.7) * amp, y: noise(f * 2.3 + 411) * amp * 0.55, amp };
  }

  const CHAIN_MAX = 6;
  const CHAIN_GAP = 8;

  function chainLayout(c, s, chain, match) {
    const items = chain.slice(-CHAIN_MAX);
    if (!items.length) return null;
    c.save();
    c.font = '600 10px ui-monospace, monospace';
    const widths = items.map((m) => c.measureText(nameOf(s, m, match)).width + 14);
    c.restore();
    const total = widths.reduce((a, b) => a + b, 0) + CHAIN_GAP * (items.length - 1);
    return { items, widths, total };
  }

  /**
   * The readout lands on top of the fighters. A scrim that fades out from the
   * screen edge keeps the number and the chain legible without putting a
   * hard panel over the action.
   */
  function drawScrim(c, s, width, w) {
    const top = 108;
    const height = 94;
    const g = s === 'a'
      ? c.createLinearGradient(0, 0, width, 0)
      : c.createLinearGradient(w, 0, w - width, 0);
    g.addColorStop(0, 'rgba(5,10,17,.62)');
    g.addColorStop(0.55, 'rgba(5,10,17,.30)');
    g.addColorStop(1, 'rgba(5,10,17,0)');
    c.save();
    c.fillStyle = g;
    c.fillRect(s === 'a' ? 0 : w - width, top, width, height);
    c.restore();
  }

  function drawChain(c, s, layout, match, right, w) {
    if (!layout) return;
    const { items, widths } = layout;
    const gap = CHAIN_GAP;
    let cx = right ? w - 44 - layout.total : 44;
    for (let i = 0; i < items.length; i += 1) {
      const label = nameOf(s, items[i], match);
      const last = i === items.length - 1;
      c.fillStyle = last ? 'rgba(255,214,130,.92)' : 'rgba(10,18,28,.72)';
      roundRect(c, cx, 0, widths[i], 17, 4);
      c.fill();
      c.strokeStyle = last ? 'rgba(255,236,190,.95)' : sideColor(s) + '88';
      c.lineWidth = 1;
      c.stroke();
      c.fillStyle = last ? '#2a1a06' : 'rgba(226,238,250,.86)';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(label, cx + widths[i] / 2, 8.5);
      cx += widths[i] + gap;
      if (!last) {
        c.fillStyle = 'rgba(200,220,240,.45)';
        c.font = '700 10px ui-monospace, monospace';
        c.fillText('›', cx - gap / 2, 8.5);
        c.font = '600 10px ui-monospace, monospace';
      }
    }
    c.restore();
  }

  function drawCounter(c, s, f, frame, match, w) {
    const count = f.combo || 0;
    if (count < COMBO_MIN) return;
    const age = Math.max(0, frame.frame - pop[s].born);
    const scale = 1 + 0.34 * Math.exp(-age / 5);
    const align = s === 'a' ? 'left' : 'right';
    const x = s === 'a' ? 44 : w - 44;
    const y = 152;
    const col = sideColor(s);
    const layout = chainLayout(c, s, f.comboChain || [], match);

    // Measure the readout first, then scrim exactly as much as it needs.
    c.save();
    c.font = '800 46px ui-monospace, monospace';
    const numW = c.measureText(String(count)).width;
    c.font = '700 14px ui-monospace, monospace';
    const hitsW = c.measureText('HITS').width;
    c.restore();
    const readW = numW + 10 + hitsW;
    const scrimW = Math.max(readW, layout ? layout.total : 0) + 56;
    drawScrim(c, s, scrimW, w);

    c.save();
    c.translate(x, y);
    c.scale(scale, scale);
    c.textAlign = align;
    c.textBaseline = 'alphabetic';
    c.font = '800 46px ui-monospace, monospace';
    c.lineWidth = 6;
    c.strokeStyle = 'rgba(6,11,18,.9)';
    c.strokeText(String(count), 0, 0);
    c.fillStyle = comboColor(count);
    c.fillText(String(count), 0, 0);
    const hitsText = 'HITS';
    c.font = '700 14px ui-monospace, monospace';
    c.lineWidth = 4;
    c.strokeStyle = 'rgba(6,11,18,.85)';
    const hitsX = align === 'left' ? numW + 10 : -numW - 10 - hitsW;
    c.strokeText(hitsText, hitsX, -6);
    c.fillStyle = 'rgba(240,246,252,.92)';
    c.fillText(hitsText, hitsX, -6);
    c.font = '600 11px ui-monospace, monospace';
    c.lineWidth = 3;
    const dmg = (f.comboDamage || 0) + ' DMG';
    const dmgX = align === 'left' ? 2 : -2 - c.measureText(dmg).width;
    c.strokeText(dmg, dmgX, 18);
    c.fillStyle = col;
    c.fillText(dmg, dmgX, 18);
    c.restore();
    c.save();
    c.translate(0, y + 26);
    drawChain(c, s, layout, match, s === 'b', w);
    c.restore();
  }

  function draw(c, frame, match, w) {
    if (!frame) return;
    for (const s of ['a', 'b']) {
      if (frame[s]) drawCounter(c, s, frame[s], frame, match, w);
    }
    if (!flash) return;
    const age = frame.frame - flash.born;
    if (age > FLICK_LIFE) {
      flash = null;
      return;
    }
    if (age < 0) return;
    const k = 1 - age / FLICK_LIFE;
    c.save();
    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';
    c.globalAlpha = Math.min(1, k * 1.6);
    c.font = '800 26px ui-monospace, monospace';
    c.lineWidth = 5;
    c.strokeStyle = 'rgba(6,11,18,.9)';
    const title = 'COMBO ' + flash.count + ' · ' + (flash.damage || 0) + ' DMG';
    c.strokeText(title, w / 2, 74);
    c.fillStyle = comboColor(flash.count || 0);
    c.fillText(title, w / 2, 74);
    c.restore();
  }

  function reset() {
    seen.clear();
    impulses.length = 0;
    flash = null;
    lastFrame = -1;
    seenCombo.a = 0;
    seenCombo.b = 0;
    pop.a = { born: -999, count: 0 };
    pop.b = { born: -999, count: 0 };
  }

  return { observe, ingest, shake, draw, reset };
}
