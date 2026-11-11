/**
 * Sheet backdrop: what the generator painted behind the fighter.
 *
 * The pipeline asked for a plain white sheet and keyed it with one rule
 * (near-white means background). That rule is the whole mattes' foundation, and
 * it has a cost: white-on-white. A pale suit, a smoke plume or a bone highlight
 * sits inside the key class, so the matte cannot tell art from ground and the
 * generator answers by shading the figure harder to keep it readable.
 *
 * The alternative is a flat chroma backdrop — magenta here — which no fighter
 * in the corpus wears. Keying it is a distance test, so the whole sheet falls on
 * one side of it or the other. Measured on the quartz react trial, the backdrop
 * is (250,3,251) and 77.0% of all pixels lie within 12 steps of it, while the
 * next bucket out holds 1.0% and the art itself starts beyond ~200: a cliff, not
 * a gradient. Constants below sit inside that cliff.
 *
 * Two numbers, because the anti-aliased seam between figure and ground is a
 * third thing. KEY_TOL cuts the backdrop. CHOKE_TOL then cuts one pixel deeper,
 * but only where the pixel touches already-cut ground: that is where the
 * generator blends magenta into the art, and the fringe it leaves is a pink
 * outline on the stage. Limiting the wider tolerance to that rim is what keeps a
 * genuinely magenta costume whole in the interior.
 */

export const KEY_TOL = 24;      // distance to the backdrop that is still backdrop
export const CHOKE_TOL = 96;    // wider, but only on the rim that touches ground
export const MARGIN = 12;       // px of cell border the prompt reserves for ground
const WHITE_MIN = 218;          // the original rule, kept for white sheets
const WHITE_CHROMA = 24;

export function isSheetWhite(r, g, b) {
  return Math.min(r, g, b) > WHITE_MIN && Math.max(r, g, b) - Math.min(r, g, b) < WHITE_CHROMA;
}

const dist2 = (r, g, b, k) => (r - k[0]) ** 2 + (g - k[1]) ** 2 + (b - k[2]) ** 2;

/**
 * Read the backdrop off the reserved margins of every cell.
 *
 * The median per channel, not the mean: one cell whose figure leans into its
 * margin must not move the key. Flatness is then the 95th percentile of the
 * per-pixel distance to that median — a backdrop is printed flat, so it is
 * small, and a margin crossed by an arm is not.
 */
export function detectBackdrop(img, { cell = 256 } = {}) {
  const { width: w, height: h, rgba } = img;
  const px = [];
  for (let gy = 0; gy * cell < h; gy += 1) {
    for (let gx = 0; gx * cell < w; gx += 1) {
      const x0 = gx * cell, y0 = gy * cell;
      const x1 = Math.min(x0 + cell, w), y1 = Math.min(y0 + cell, h);
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          if (x - x0 >= MARGIN && x1 - x > MARGIN && y - y0 >= MARGIN && y1 - y > MARGIN) continue;
          const i = (y * w + x) * 4;
          px.push([rgba[i], rgba[i + 1], rgba[i + 2]]);
        }
      }
    }
  }
  if (px.length < 1000) throw new Error('backdrop: too few margin pixels to read');
  const channel = (k) => {
    const v = px.map((p) => p[k]).sort((a, b) => a - b);
    return v[v.length >> 1];
  };
  const rgb = [channel(0), channel(1), channel(2)];
  const ds = px.map((p) => Math.sqrt(dist2(p[0], p[1], p[2], rgb))).sort((a, b) => a - b);
  const flat = ds[Math.floor(ds.length * 0.95)];
  if (isSheetWhite(rgb[0], rgb[1], rgb[2])) return { kind: 'white', rgb, flat };
  return {
    kind: flat <= KEY_TOL * 2 ? 'chroma' : 'mixed',
    rgb,
    flat,
  };
}

/** The classification the mattes key by, derived from a detection. */
export function keyOf(backdrop) {
  if (backdrop.kind === 'white') return { isKey: isSheetWhite, isSpill: null };
  const { rgb } = backdrop;
  return {
    isKey: (r, g, b) => dist2(r, g, b, rgb) < KEY_TOL * KEY_TOL,
    isSpill: (r, g, b) => dist2(r, g, b, rgb) < CHOKE_TOL * CHOKE_TOL,
  };
}

/**
 * Remove the blended seam: one pass, rim-only, wider tolerance.
 *
 * Runs after the flood fill has marked the ground, on the alpha mask, so it can
 * only ever eat pixels that already touch a cleared neighbour. Returns the
 * count eaten, which the QA line reports; a white sheet returns 0 because it has
 * no spill class to chase.
 */
export function chokeSpill(rgba, alpha, w, h, key) {
  if (!key.isSpill) return 0;
  const eaten = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (!alpha[i]) continue;
      const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
      if (!key.isSpill(r, g, b)) continue;
      let rim = false;
      for (let dy = -1; dy <= 1 && !rim; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) { rim = true; break; }
          if (!alpha[yy * w + xx]) { rim = true; break; }
        }
      }
      if (rim) eaten.push(i);
    }
  }
  for (const i of eaten) alpha[i] = 0;
  return eaten.length;
}

/**
 * Neutralise the pale key tint the distance test cannot reach.
 *
 * A blended edge pixel is the backdrop mixed with whatever it covers, so it
 * sits *between* the key and the art: its colour has a component along the
 * backdrop's own chroma axis. Project that component out and the pixel is what
 * the art underneath was — white armour stops wearing a pink outline.
 *
 * Only a weak component is removed. A pixel whose key-axis tint is strong is
 * not a blend of two colours, it is the colour: a magenta energy effect, which
 * has to stay magenta. That is also the honest limit of this route — a
 * character whose own effects are the key colour has no separable edge, so the
 * rim of those effects is left alone rather than guessed at.
 */
export const DESPILL_MAX = 130;   // key-axis tint that is still a blend, not a colour
export const DESPILL_RIM = 2;     // px inside the silhouette a blend can reach

export function despillRim(rgba, w, h, backdrop) {
  if (backdrop.kind !== 'chroma') return 0;
  const { rgb } = backdrop;
  const kl = (Math.max(...rgb) + Math.min(...rgb)) / 2;
  const kv = [rgb[0] - kl, rgb[1] - kl, rgb[2] - kl];
  const len = Math.hypot(kv[0], kv[1], kv[2]) || 1;
  const ax = [kv[0] / len, kv[1] / len, kv[2] / len];
  const tint = (r, g, b) => {
    const l = (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
    return (r - l) * ax[0] + (g - l) * ax[1] + (b - l) * ax[2];
  };
  const kept = (i) => rgba[i * 4 + 3] > 8;
  // Depth of every kept pixel from the nearest cleared one, up to DESPILL_RIM.
  const depth = new Int16Array(w * h).fill(-1);
  let frontier = [];
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const i = y * w + x;
    if (!kept(i)) continue;
    const nb = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
    if (nb.some(([a, b]) => a < 0 || b < 0 || a >= w || b >= h || !kept(b * w + a))) {
      depth[i] = 0; frontier.push(i);
    }
  }
  let fixed = 0;
  for (let d = 0; d < DESPILL_RIM; d += 1) {
    for (const i of frontier) {
      const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
      const t = tint(r, g, b);
      if (t > 0 && t <= DESPILL_MAX) {
        rgba[i * 4] = Math.max(0, Math.min(255, Math.round(r - t * ax[0])));
        rgba[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(g - t * ax[1])));
        rgba[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(b - t * ax[2])));
        fixed += 1;
      }
    }
    const next = [];
    for (const i of frontier) {
      const x = i % w, y = (i / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const ni = yy * w + xx;
        if (kept(ni) && depth[ni] < 0) { depth[ni] = d + 1; next.push(ni); }
      }
    }
    frontier = next;
  }
  return fixed;
}
