// Sprite slicing — matte and cleanup primitives (split from slice.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIGHTERS } from '../../src/fighters.js';
import {
  readPNG, cropRGBA, blitRGBA, writeVariantPair, sha256, shortHash, writeAtomic, hashFile, shelfPack,
} from '../lib/imageops.mjs';
import { encodeRGBA } from '../lib/png.mjs';
import {
  GRID, CELL_COUNT, SHEETS, SHEET_IDS, facingReview, shipsFlipped, ART_ROW_ORDER, OFF_MODEL_ART,
  CROSS_ROW_SPLITS, BODY_HEAD_OVERRIDES,
} from './sheets.mjs';
import { detectBackdrop, keyOf, chokeSpill, despillRim, CHOKE_TOL } from './backdrop.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = path.join(ROOT, 'assets', 'source', 'sprites');
const OUT = path.join(ROOT, 'web', 'assets');
const VDIR = path.join(OUT, 'v', 'sprites');

export const FRAME = 256;          // nominal cell edge (px); frames ship tight ink crops
export const STANCE_H = 200;       // normalized standing height (px)
export const ANCHOR = [128, 248];  // feet baseline inside the frame
const SHEET_PX = 1024;             // raw generated sheet edge
const CELL = SHEET_PX / GRID;      // 256


/* ── matte: flood-fill near-white from the borders, prune neutral speckle ── */
/**
 * White-background matte that survives light-colored characters.
 *
 * A plain "flood-fill every near-white pixel from the border" leaks: a
 * silver/white fighter is one big near-white blob, and the pale ground
 * shadow under it is near-white too, so the fill walks straight through the
 * figure and erases it (observed: quartz's lying knockdown pose vanished).
 *
 * The fix is to flood only through THICK white — a pixel counts as
 * background only if it AND all eight neighbours are near-white. Thin bright
 * bands (the shadow, an armor highlight rim) are not walkable, so the fill
 * stops at the figure's silhouette instead of crossing it. A short dilation
 * afterwards removes the one-pixel white fringe the erosion left behind.
 */
/**
 * Some generators draw a thin border frame around the sheet. That frame is
 * not walkable white, so the border-seeded flood never starts and the whole
 * background survives as one giant component (observed: prism's kick sheet).
 * Return the smallest inset whose ring is (almost) entirely near-white.
 */
function frameInset(near, w, h, maxInset = 6) {
  for (let inset = 0; inset <= maxInset; inset += 1) {
    const pts = [];
    for (let x = inset; x < w - inset; x += 1) {
      pts.push(inset * w + x, (h - 1 - inset) * w + x);
    }
    for (let y = inset; y < h - inset; y += 1) {
      pts.push(y * w + inset, y * w + (w - 1 - inset));
    }
    let ok = 0;
    for (const i of pts) if (near[i]) ok += 1;
    if (ok / pts.length > 0.98) return inset;
  }
  return 0;
}

/**
 * The sheet background is one flat colour the generator was told to leave
 * empty, so the walkable set is whatever the backdrop detection calls key. See
 * backdrop.mjs: white on the corpus as shipped, magenta on a chroma sheet.
 */
function matteCell(img, backdrop = detectBackdrop(img, { cell: CELL })) {
  const key = keyOf(backdrop);
  const { width: w, height: h, rgba } = img;
  const near = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    near[i] = key.isKey(r, g, b) ? 1 : 0;
  }
  const inset = frameInset(near, w, h);
  const x0 = inset, y0 = inset, x1 = w - inset, y1 = h - inset;
  // Erode by one: walkable white needs a full 3x3 neighbourhood of white.
  // Outside the matte region counts as white so its edge stays walkable.
  //
  // The erosion stays on for a chroma key too, and for a reason that only shows
  // up on the stage: a soft effect (a dash trail, a shockwave) is painted as the
  // art colour thinned out over the ground, so its faint core lands INSIDE
  // KEY_TOL and is the same colour as the backdrop. Those cores are long and
  // thin, so eroding the walk is what keeps the fill from travelling along a
  // streak and deleting the effect. Measured on quartz react: with the erosion
  // lifted for chroma the kept near-backdrop pixels in the trail cells fell
  // 103->57 and 127->64 — that is lost effect, not lost ground.
  const solid = new Uint8Array(w * h);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = y * w + x;
      if (!near[i]) continue;
      let ok = true;
      for (let dy = -1; dy <= 1 && ok; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const yy = y + dy, xx = x + dx;
          if (yy < y0 || yy >= y1 || xx < x0 || xx >= x1) continue;
          if (!near[yy * w + xx]) { ok = false; break; }
        }
      }
      if (ok) solid[i] = 1;
    }
  }
  const bg = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let qh = 0, qt = 0;
  const push = (idx) => {
    if (solid[idx] && !bg[idx]) { bg[idx] = 1; queue[qt++] = idx; }
  };
  for (let x = x0; x < x1; x += 1) { push(y0 * w + x); push((y1 - 1) * w + x); }
  for (let y = y0; y < y1; y += 1) { push(y * w + x0); push(y * w + x1 - 1); }
  while (qh < qt) {
    const idx = queue[qh++], x = idx % w, y = (idx / w) | 0;
    if (x > x0) push(idx - 1);
    if (x < x1 - 1) push(idx + 1);
    if (y > y0) push(idx - w);
    if (y < y1 - 1) push(idx + w);
  }
  // Dilate the background by two pixels to reclaim the eroded fringe.
  let clear = bg;
  for (let r = 0; r < 2; r += 1) {
    const next = new Uint8Array(w * h);
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (!clear[i]) continue;
      next[i] = 1;
      if (x > 0) next[i - 1] = 1;
      if (x < w - 1) next[i + 1] = 1;
      if (y > 0) next[i - w] = 1;
      if (y < h - 1) next[i + w] = 1;
    }
    clear = next;
  }
  const alpha = new Uint8Array(w * h).fill(255);
  for (let i = 0; i < w * h; i += 1) if (clear[i] && near[i]) alpha[i] = 0;
  // The peeled frame is a generator artifact, not art.
  if (inset > 0) {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (x >= x0 && x < x1 && y >= y0 && y < y1) continue;
        alpha[y * w + x] = 0;
      }
    }
  }
  // The chroma seam: where the generator blended the backdrop into the figure
  // the result is neither key nor art, and left in it draws a pink outline on
  // the stage. One rim pass, and only for a keyed backdrop.
  const spill = chokeSpill(rgba, alpha, w, h, key);
  // Drop small neutral connected components (stray checker speckle), keep art.
  const label = new Int32Array(w * h);
  const q2 = new Int32Array(w * h);
  const comps = [];
  let compId = 0, largest = 0;
  for (let seed = 0; seed < w * h; seed += 1) {
    if (!alpha[seed] || label[seed]) continue;
    compId += 1;
    let head = 0, tail = 0, count = 0, neutral = 0;
    q2[tail++] = seed; label[seed] = compId;
    while (head < tail) {
      const idx = q2[head++]; count += 1;
      const r = rgba[idx * 4], g = rgba[idx * 4 + 1], b = rgba[idx * 4 + 2];
      if (Math.min(r, g, b) > 185 && Math.max(r, g, b) - Math.min(r, g, b) < 40) neutral += 1;
      const x = idx % w, y = (idx / w) | 0;
      if (x > 0 && alpha[idx - 1] && !label[idx - 1]) { label[idx - 1] = compId; q2[tail++] = idx - 1; }
      if (x < w - 1 && alpha[idx + 1] && !label[idx + 1]) { label[idx + 1] = compId; q2[tail++] = idx + 1; }
      if (y > 0 && alpha[idx - w] && !label[idx - w]) { label[idx - w] = compId; q2[tail++] = idx - w; }
      if (y < h - 1 && alpha[idx + w] && !label[idx + w]) { label[idx + w] = compId; q2[tail++] = idx + w; }
    }
    comps.push({ id: compId, count, neutral });
    if (count > largest) largest = count;
  }
  const kill = new Set();
  for (const c of comps) {
    if (c.count < Math.max(120, largest * 0.01) && c.neutral / c.count > 0.45) kill.add(c.id);
  }
  const out = Buffer.from(rgba);
  for (let i = 0; i < w * h; i += 1) {
    out[i * 4 + 3] = (alpha[i] && !kill.has(label[i])) ? 255 : 0;
  }
  // The pale half of the seam: a blended edge pixel is the backdrop mixed with
  // the art under it, so its colour carries a component along the backdrop's
  // own chroma axis. Projecting that component off the outer rings is what
  // stops white armour from drawing itself a pink outline.
  const despill = despillRim(out, w, h, backdrop);
  return { width: w, height: h, rgba: out, matte: { key: backdrop.kind, spill, despill } };
}

/**
 * The generators draw a contact shadow: a wide, flat, neutral-grey smear under
 * the boots. Because it touches the feet it survives the white matte and joins
 * the body's connected component, so the component-level filters can't see it.
 * It has to go, for two reasons:
 *   - it is a grey bar up to 250px wide (wider than the body) that appears on
 *     some sheets and not others, so it pops in and out as clips change;
 *   - the frame is anchored on its bottom row, so the shadow, not the feet,
 *     lands on the ground line and the fighter floats above the stage.
 *
 * Removal is pixel-level but shape-tested: only neutral-grey pixels inside a
 * component that is wide, flat and touching the bottom of its cell are cut.
 * Legs and boots fail the flatness test, so they survive.
 */
function isNeutralGrey(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max - min > 26) return false;
  const l = (max + min) / 2;
  return l >= 55 && l <= 205;
}

/**
 * Cut the ground line the generators draw under the feet.
 *
 * The contact shadow is not one thing: it is a dark grey slab under some
 * fighters, a pale streak under others, and it is welded to the soles, so the
 * component tests above cannot see it separately. What it always is, is a
 * line: achromatic, spread across most of the pose's width, and only a few
 * pixels tall wherever it touches a column. A boot fails the last test, the
 * leg above it is the same grey and the column run is long, so boots keep
 * their soles and the frame stops anchoring on the shadow.
 */
const SEAL_THICKNESS = 5;      // px of vertical grey a seal column may have
const SEAL_SPAN = 0.4;         // fraction of the pose width the seal must cover

function stripSealFade(img) {
  const { width: sheetW, rgba } = img;
  for (let gy = 0; gy < GRID; gy += 1) {
    for (let gx = 0; gx < GRID; gx += 1) {
      const ox = gx * CELL, oy = gy * CELL;
      const at = (x, y) => ((oy + y) * sheetW + ox + x) * 4;
      const grey = new Uint8Array(CELL * CELL);
      const floor = new Int32Array(CELL).fill(-1);
      let minX = CELL, maxX = -1;
      for (let y = 0; y < CELL; y += 1) {
        for (let x = 0; x < CELL; x += 1) {
          const i = at(x, y);
          if (rgba[i + 3] <= 8) continue;
          if (x > maxX) maxX = x;
          if (x < minX) minX = x;
          if (y > floor[x]) floor[x] = y;
          const max = Math.max(rgba[i], rgba[i + 1], rgba[i + 2]);
          const min = Math.min(rgba[i], rgba[i + 1], rgba[i + 2]);
          if (max - min < 26 && max < 246) grey[y * CELL + x] = 1;
        }
      }
      if (maxX < 0) continue;
      const need = (maxX - minX + 1) * SEAL_SPAN;
      const thin = new Uint8Array(CELL * CELL);
      let covered = 0;
      for (let x = minX; x <= maxX; x += 1) {
        const yb = floor[x];
        if (yb < 0) continue;
        let run = 0;
        while (yb - run >= 0 && grey[(yb - run) * CELL + x]) run += 1;
        // Only the columns whose grey stops quickly are ground line; a column
        // that stays grey from its sole upward is a leg.
        if (!run || run > SEAL_THICKNESS) continue;
        covered += 1;
        for (let k = 0; k < run; k += 1) thin[(yb - k) * CELL + x] = 1;
      }
      if (covered < need) continue;
      for (let y = 0; y < CELL; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          if (thin[y * CELL + x]) rgba[at(x, y) + 3] = 0;
        }
      }
    }
  }
}

function stripGroundShadows(img) {
  const { width: sheetW, height: sheetH, rgba } = img;
  for (let gy = 0; gy < GRID; gy += 1) {
    for (let gx = 0; gx < GRID; gx += 1) {
      const ox = gx * CELL, oy = gy * CELL;
      const inRegion = (x, y) => x >= 0 && x < CELL && y >= 0 && y < CELL;
      let minX = CELL, maxX = -1, minY = CELL, maxY = -1;
      for (let y = 0; y < CELL; y += 1) {
        for (let x = 0; x < CELL; x += 1) {
          if (rgba[((oy + y) * sheetW + ox + x) * 4 + 3] <= 8) continue;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
      if (maxX < 0) continue;
      const bw = maxX - minX + 1, bh = maxY - minY + 1;
      const bandTop = Math.max(minY, maxY - Math.min(26, Math.round(bh * 0.18)));
      const grey = new Uint8Array(CELL * CELL);
      for (let y = bandTop; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) {
        const i = ((oy + y) * sheetW + ox + x) * 4;
        if (rgba[i + 3] <= 8) continue;
        if (isNeutralGrey(rgba[i], rgba[i + 1], rgba[i + 2])) grey[y * CELL + x] = 1;
      }
      const seen = new Uint8Array(CELL * CELL);
      const queue = new Int32Array(CELL * CELL);
      for (let seed = 0; seed < CELL * CELL; seed += 1) {
        if (!grey[seed] || seen[seed]) continue;
        let head = 0, tail = 0, area = 0;
        let cMinX = CELL, cMaxX = -1, cMinY = CELL, cMaxY = -1;
        const px = [];
        seen[seed] = 1; queue[tail++] = seed;
        while (head < tail) {
          const idx = queue[head++];
          const x = idx % CELL, y = (idx / CELL) | 0;
          area += 1; px.push(idx);
          if (x < cMinX) cMinX = x; if (x > cMaxX) cMaxX = x;
          if (y < cMinY) cMinY = y; if (y > cMaxY) cMaxY = y;
          const nb = [x > 0 ? idx - 1 : -1, x < CELL - 1 ? idx + 1 : -1,
            y > bandTop ? idx - CELL : -1, y < CELL - 1 ? idx + CELL : -1];
          for (const n of nb) if (n >= 0 && grey[n] && !seen[n]) { seen[n] = 1; queue[tail++] = n; }
        }
        const cw = cMaxX - cMinX + 1, ch = cMaxY - cMinY + 1;
        const isSlab = area >= 180 && cw >= bw * 0.45 && ch <= 18 && cw >= ch * 2.6
          && cMaxY >= maxY - 2;
        if (!isSlab) continue;
        for (const idx of px) {
          const x = idx % CELL, y = (idx / CELL) | 0;
          if (!inRegion(x, y)) continue;
          rgba[((oy + y) * sheetW + ox + x) * 4 + 3] = 0;
        }
      }
    }
  }
}

export { ROOT, SOURCE, OUT, VDIR, SHEET_PX, CELL, frameInset, matteCell, isNeutralGrey, stripSealFade, stripGroundShadows };
