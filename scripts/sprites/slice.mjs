/**
 * Sprite sheet slicer / baker.
 *
 * Turns a raw 4x4 generated sheet into game-ready frames:
 *   split 16 cells -> matte (flood-fill white) -> strip the baked contact
 *   shadow -> key out the enclosed background pockets -> measure head-to-feet per
 *   cell -> one scale per fighter -> feet-baseline alignment -> pack a 4x4
 *   atlas -> emit per-fighter anim JSON.
 *
 * The runtime contract (web/sprite.js) is: every frame is FRAME x FRAME px,
 * the fighter's feet sit at ANCHOR [x, y] inside the frame, and clips map
 * server move phases to frame indices. Nothing here knows about combat.
 *
 * Output (content-addressed, served under /assets/v/sprites/):
 *   web/assets/v/sprites/<id>/<sheet>.<hash>.png|webp   (atlas)
 *   web/assets/v/sprites/<id>/anim.<hash>.json          (clips + frames)
 *   web/assets/sprites.json                             (index)
 *
 * Usage: node scripts/sprites/slice.mjs [--only ember,tide] [--check]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIGHTERS } from '../../src/fighters.js';
import {
  readPNG, cropRGBA, blitRGBA, writeVariantPair, sha256, shortHash, writeAtomic,
} from '../lib/imageops.mjs';
import { encodeRGBA } from '../lib/png.mjs';
import { GRID, CELL_COUNT, SHEETS, SHEET_IDS, NATIVE_FACING } from './sheets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = path.join(ROOT, 'assets', 'source', 'sprites');
const OUT = path.join(ROOT, 'web', 'assets');
const VDIR = path.join(OUT, 'v', 'sprites');

export const FRAME = 256;          // normalized frame edge (px)
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

function isSheetWhite(r, g, b) {
  return Math.min(r, g, b) > 218 && Math.max(r, g, b) - Math.min(r, g, b) < 24;
}

function matteCell(img) {
  const { width: w, height: h, rgba } = img;
  const near = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    near[i] = isSheetWhite(r, g, b) ? 1 : 0;
  }
  const inset = frameInset(near, w, h);
  const x0 = inset, y0 = inset, x1 = w - inset, y1 = h - inset;
  // Erode by one: walkable white needs a full 3x3 neighbourhood of white.
  // Outside the matte region counts as white so its edge stays walkable.
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
  return { width: w, height: h, rgba: out };
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

/**
 * Drop the background pockets the border flood cannot reach.
 *
 * The generators seal the ground with a hairline shadow, and that line cuts
 * the sheet background into pockets: the wedge between two boots, the gap
 * under a spread coat, the triangle between an arm and the ribs. A pocket is
 * the same white as the outer background but is no longer connected to it, so
 * matteCell leaves it as an opaque slab inside the silhouette and the fighter
 * arrives on stage with a blank hole where his legs should be.
 *
 * Flooding is the wrong tool here: any barrier thin enough to step across is
 * also thin enough to step into shaded armour, and measured that way a drain
 * took 86% of a cell's white. A pocket is instead recognised for what it is,
 * an island of flat pixels sitting on this sheet's own background value. Art
 * never looks like that, every plate, fold and rim light carries shading, so
 * the test is exact on the samples: basalt's wedge sits at 252.0 +/- 2.9 with
 * the background at 252.7, while quartz's white armour breaks into islands
 * under 500 px because its shading pushes it out of the near-white class.
 *
 * The cap is the safety valve: a fighter drawn as one flat white shape would
 * match the key, so no cell may lose more than half of its ink this way.
 *
 * Small islands need a second opinion, because at that size the backdrop and
 * a white-hot effect core are the same flat white. What separates them is
 * what they touch. A gap is cut out by the figure itself, so its rim is the
 * character's own achromatic outline; a flame or a water jet fades into its
 * own colour, so its rim is chromatic all the way round. Measured on the
 * corpus: basalt's arm gap has 6% of its rim chromatic and forge's leg gap
 * 93% (it does open onto fire), while cinder's flame cores run 90-100% and
 * tide's water cores 64-95%. Only the low-chroma class is therefore trusted
 * below the ground size, which keeps every effect whole.
 */
const POCKET_MIN_AREA = 500;   // px; smaller islands are gaps, not ground
const POCKET_SD = 8;           // the sheet background is flat, shaded art is not
const POCKET_DEV = 3;          // island mean must sit on the sheet background value
const POCKET_INK_SHARE = 0.5;  // max fraction of a cell's ink one key may take
const GAP_MIN_AREA = 120;      // px; the smallest gap worth cutting
const GAP_RIM_CHROMA = 0.35;   // a rim this colourful belongs to an effect

function isChromatic(r, g, b) {
  return Math.max(r, g, b) - Math.min(r, g, b) >= 24;
}

function dropBackgroundPockets(img) {
  const { width: sheetW, height: sheetH, rgba } = img;
  const dropped = [];
  for (let gy = 0; gy < GRID; gy += 1) {
    for (let gx = 0; gx < GRID; gx += 1) {
      const ox = gx * CELL, oy = gy * CELL;
      const at = (x, y) => ((oy + y) * sheetW + ox + x) * 4;
      const near = new Uint8Array(CELL * CELL);
      const opaque = new Uint8Array(CELL * CELL);
      let ink = 0, bgSum = 0, bgN = 0;
      for (let y = 0; y < CELL; y += 1) {
        for (let x = 0; x < CELL; x += 1) {
          const i = at(x, y), idx = y * CELL + x;
          if (rgba[i + 3] <= 8) {
            bgSum += (Math.max(rgba[i], rgba[i + 1], rgba[i + 2])
              + Math.min(rgba[i], rgba[i + 1], rgba[i + 2])) / 2;
            bgN += 1;
            continue;
          }
          opaque[idx] = 1; ink += 1;
          if (isSheetWhite(rgba[i], rgba[i + 1], rgba[i + 2])) near[idx] = 1;
        }
      }
      if (ink < 500 || !bgN) continue;
      const bgMean = bgSum / bgN;
      const seen = new Uint8Array(CELL * CELL);
      let taken = 0;
      for (let seed = 0; seed < CELL * CELL; seed += 1) {
        if (!near[seed] || seen[seed]) continue;
        const queue = [seed];
        seen[seed] = 1;
        let n = 0, sum = 0, sq = 0;
        for (let head = 0; head < queue.length; head += 1) {
          const idx = queue[head];
          const x = idx % CELL, y = (idx / CELL) | 0, i = at(x, y);
          const l = (Math.max(rgba[i], rgba[i + 1], rgba[i + 2])
            + Math.min(rgba[i], rgba[i + 1], rgba[i + 2])) / 2;
          n += 1; sum += l; sq += l * l;
          const nb = [x > 0 ? idx - 1 : -1, x < CELL - 1 ? idx + 1 : -1,
            y > 0 ? idx - CELL : -1, y < CELL - 1 ? idx + CELL : -1];
          for (const k of nb) {
            if (k < 0 || !near[k] || seen[k]) continue;
            seen[k] = 1; queue.push(k);
          }
        }
        const mean = sum / n;
        const sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
        if (sd > POCKET_SD || Math.abs(mean - bgMean) > POCKET_DEV) continue;
        if (n < POCKET_MIN_AREA) {
          if (n < GAP_MIN_AREA) continue;
          let rim = 0, colourful = 0;
          for (const idx of queue) {
            const x = idx % CELL, y = (idx / CELL) | 0;
            const nb = [x > 0 ? idx - 1 : -1, x < CELL - 1 ? idx + 1 : -1,
              y > 0 ? idx - CELL : -1, y < CELL - 1 ? idx + CELL : -1];
            for (const k of nb) {
              if (k < 0 || near[k] || !opaque[k]) continue;
              const i = at(k % CELL, (k / CELL) | 0);
              rim += 1;
              if (isChromatic(rgba[i], rgba[i + 1], rgba[i + 2])) colourful += 1;
            }
          }
          if (!rim || colourful / rim >= GAP_RIM_CHROMA) continue;
        }
        if (taken + n > ink * POCKET_INK_SHARE) continue;
        for (const idx of queue) {
          rgba[at(idx % CELL, (idx / CELL) | 0) + 3] = 0;
        }
        taken += n;
        dropped.push({ n, cell: gy * GRID + gx });
      }
    }
  }
  return dropped;
}

function bboxOf(img) {
  const { width: w, height: h, rgba } = img;
  let minX = w, minY = h, maxX = -1, maxY = -1, opaque = 0;
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    if (rgba[(y * w + x) * 4 + 3] <= 8) continue;
    opaque += 1;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (maxX < 0) return null;
  return { minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1, opaque };
}

/** Alpha-weighted horizontal centroid of the bottom fraction (the feet). */
function feetCenterX(img, bbox, frac = 0.25) {
  const { width: w, rgba } = img;
  const y0 = bbox.maxY - Math.floor(bbox.h * frac);
  let sum = 0, weight = 0;
  for (let y = y0; y <= bbox.maxY; y += 1) for (let x = bbox.minX; x <= bbox.maxX; x += 1) {
    const a = rgba[(y * w + x) * 4 + 3];
    if (a > 8) { sum += x * a; weight += a; }
  }
  return weight ? sum / weight : (bbox.minX + bbox.maxX) / 2;
}

/** Bilinear resample supporting both up- and downscale, premultiplied alpha. */
function resizeBilinear(src, dw, dh) {
  const { width: sw, height: sh, rgba } = src;
  if (dw === sw && dh === sh) return src;
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y += 1) {
    const gy = ((y + 0.5) * sh) / dh - 0.5;
    const y0 = Math.max(0, Math.floor(gy)), y1 = Math.min(sh - 1, y0 + 1);
    const fy = Math.min(1, Math.max(0, gy - y0));
    for (let x = 0; x < dw; x += 1) {
      const gx = ((x + 0.5) * sw) / dw - 0.5;
      const x0 = Math.max(0, Math.floor(gx)), x1 = Math.min(sw - 1, x0 + 1);
      const fx = Math.min(1, Math.max(0, gx - x0));
      let r = 0, g = 0, b = 0, a = 0;
      for (const [sx, sy, wgt] of [
        [x0, y0, (1 - fx) * (1 - fy)], [x1, y0, fx * (1 - fy)],
        [x0, y1, (1 - fx) * fy], [x1, y1, fx * fy],
      ]) {
        const si = (sy * sw + sx) * 4, al = rgba[si + 3];
        r += rgba[si] * al * wgt; g += rgba[si + 1] * al * wgt; b += rgba[si + 2] * al * wgt;
        a += al * wgt;
      }
      const di = (y * dw + x) * 4;
      if (a > 0) {
        out[di] = Math.round(r / a); out[di + 1] = Math.round(g / a); out[di + 2] = Math.round(b / a);
        out[di + 3] = Math.round(a);
      }
    }
  }
  return { width: dw, height: dh, rgba: out };
}

/**
 * Head-top to feet line, measured where the body is rather than where the art
 * is. The opaque bbox is useless as a scale reference because a flame geyser,
 * a swept cape or an extended trail can double it, and scaling on it resizes
 * the fighter itself. The head sits above the body's centre of mass, so the
 * measurement looks in a narrow strip around that centre and takes the first
 * sustained run of ink: thin VFX wisps above the head are skipped, the skull
 * is not. Returns null when no sustained head is found.
 */
function bodyExtent(img) {
  const { width: w, height: h, rgba } = img;
  let sx = 0, sw = 0, feet = -1;
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const a = rgba[(y * w + x) * 4 + 3];
    if (a <= 8) continue;
    sx += x * a; sw += a;
    if (y > feet) feet = y;
  }
  if (!sw) return null;
  const cx = sx / sw;
  const half = Math.max(6, Math.round(w * 0.16));
  const x0 = Math.max(0, Math.round(cx - half));
  const x1 = Math.min(w - 1, Math.round(cx + half));
  const need = Math.max(2, Math.round((x1 - x0 + 1) * 0.15));
  const inked = new Uint8Array(h);
  for (let y = 0; y < h; y += 1) {
    let n = 0;
    for (let x = x0; x <= x1; x += 1) if (rgba[(y * w + x) * 4 + 3] > 8) n += 1;
    inked[y] = n >= need ? 1 : 0;
  }
  for (let y = 0; y + 5 < h; y += 1) {
    let sustained = true;
    for (let k = 0; k < 6; k += 1) if (!inked[y + k]) { sustained = false; break; }
    if (sustained) return { headTop: y, feet, h: feet - y + 1, cx: Math.round(cx) };
  }
  return null;
}

/**
 * One scale per fighter, anchored on the idle stance.
 *
 * Calibrating on the first cells of each sheet (what this used to do) made the
 * same character five different sizes: the react sheet is mostly crouches and
 * falls, so its "standing reference" is a 70%-height pose, and every hit
 * animation came out shrunk or enlarged. The idle stance is the one pose that
 * is upright, effect-free and present for every fighter, so it defines
 * STANCE_H and everything else is measured against it.
 */
function median(values) {
  const s = values.slice().sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
}

function stanceReference(baseCells) {
  const hs = SHEETS.base.clips.idle.cells
    .map((i) => (baseCells[i] && baseCells[i].body ? baseCells[i].body.h : 0))
    .filter((h) => h > 0);
  if (hs.length) return median(hs);
  return median(baseCells.filter((c) => c.bbox).map((c) => c.bbox.h));
}

/**
 * The generator draws each sheet at its own art scale (measured: ember's skill
 * sheet is ~7% smaller than his base sheet), so a fighter-global scale alone
 * still pops between clips. Each sheet gets a correction, but a bounded one:
 * an unbounded correction would "fix" the react sheet's crouch-heavy pose mix
 * by inflating it.
 */
function sheetCorrection(cells, refH) {
  if (!refH) return 1;
  const tall = cells
    .filter((c) => c.body && c.body.h >= refH * 0.85)
    .map((c) => c.body.h);
  if (tall.length < 3) return 1;
  return Math.min(1.06, Math.max(0.94, refH / median(tall)));
}

/** Horizontal mirror, applied before anchoring so feet stay on ANCHOR. */
function mirrorX(img) {
  const out = Buffer.alloc(img.rgba.length);
  for (let y = 0; y < img.height; y += 1) {
    const row = y * img.width;
    for (let x = 0; x < img.width; x += 1) {
      const s = (row + x) * 4;
      img.rgba.copy(out, (row + img.width - 1 - x) * 4, s, s + 4);
    }
  }
  return { width: img.width, height: img.height, rgba: out };
}

/** Place a cropped cell into a FRAME so the measured feet land on ANCHOR. */
function placeFrame(cropped, scale, body, flip = false) {
  const bodyH = body ? body.h : cropped.height;
  // Effects are allowed to overflow and clip; the body is not. So the only
  // resize allowed is the one that keeps head-to-feet inside the frame.
  const room = ANCHOR[1] - 6;
  const fit = Math.min(scale, room / bodyH);
  const dw = Math.max(1, Math.round(cropped.width * fit));
  const dh = Math.max(1, Math.round(cropped.height * fit));
  const scaled = flip ? mirrorX(resizeBilinear(cropped, dw, dh)) : resizeBilinear(cropped, dw, dh);
  const scaledBbox = { minX: 0, minY: 0, maxX: dw - 1, maxY: dh - 1, w: dw, h: dh };
  const fx = feetCenterX(scaled, scaledBbox);
  const frame = { width: FRAME, height: FRAME, rgba: Buffer.alloc(FRAME * FRAME * 4) };
  const dx = Math.round(ANCHOR[0] - fx);
  const footRow = body ? Math.round((body.feet + 1) * (dh / cropped.height)) : dh;
  const dy = ANCHOR[1] - footRow;
  // Clip blit to the frame bounds (a wide punch may overflow the cell).
  for (let row = 0; row < dh; row += 1) {
    const ty = dy + row;
    if (ty < 0 || ty >= FRAME) continue;
    for (let col = 0; col < dw; col += 1) {
      const tx = dx + col;
      if (tx < 0 || tx >= FRAME) continue;
      const si = (row * dw + col) * 4, di = (ty * FRAME + tx) * 4;
      scaled.rgba.copy(frame.rgba, di, si, si + 4);
    }
  }
  return frame;
}

/** Label opaque connected components; return per-comp area, centroid, bbox. */
function labelComponents(img) {
  const { width: w, height: h, rgba } = img;
  const label = new Int32Array(w * h);
  const queue = new Int32Array(w * h);
  const comps = [];
  let compId = 0;
  for (let seed = 0; seed < w * h; seed += 1) {
    if (rgba[seed * 4 + 3] <= 8 || label[seed]) continue;
    compId += 1;
    let head = 0, tail = 0, area = 0, sx = 0, sy = 0, chroma = 0;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    queue[tail++] = seed; label[seed] = compId;
    while (head < tail) {
      const idx = queue[head++];
      const x = idx % w, y = (idx / w) | 0;
      area += 1; sx += x; sy += y;
      const r = rgba[idx * 4], g = rgba[idx * 4 + 1], b = rgba[idx * 4 + 2];
      chroma += Math.max(r, g, b) - Math.min(r, g, b);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && rgba[(idx - 1) * 4 + 3] > 8 && !label[idx - 1]) { label[idx - 1] = compId; queue[tail++] = idx - 1; }
      if (x < w - 1 && rgba[(idx + 1) * 4 + 3] > 8 && !label[idx + 1]) { label[idx + 1] = compId; queue[tail++] = idx + 1; }
      if (y > 0 && rgba[(idx - w) * 4 + 3] > 8 && !label[idx - w]) { label[idx - w] = compId; queue[tail++] = idx - w; }
      if (y < h - 1 && rgba[(idx + w) * 4 + 3] > 8 && !label[idx + w]) { label[idx + w] = compId; queue[tail++] = idx + w; }
    }
    comps.push({ id: compId, area, cx: sx / area, cy: sy / area, minX, minY, maxX, maxY, chroma: chroma / area });
  }
  return { label, comps };
}
/**
 * The AI grid drifts: a pose can overflow its 256px cell (head above the top
 * edge) while a neighbour's head/fist intrudes at the bottom. Fixed-cell crops
 * therefore cut heads and capture stray limbs. Instead we matte the whole
 * sheet and assign each connected component to the cell holding its CENTROID:
 * a pose's overflow head stays connected to its own body (kept), while an
 * intruding neighbour fragment is a separate component centred elsewhere
 * (dropped). The union bbox of a cell's components is the true pose extent.
 */
function sliceSheet(file) {
  const src = readPNG(file);
  if (src.width !== SHEET_PX || src.height !== SHEET_PX) {
    throw new Error(`${file}: expected ${SHEET_PX}x${SHEET_PX}, got ${src.width}x${src.height}`);
  }
  const matted = matteCell(src);
  stripGroundShadows(matted);
  dropBackgroundPockets(matted);
  stripSealFade(matted);
  const { label, comps } = labelComponents(matted);
  const byCell = Array.from({ length: CELL_COUNT }, () => []);
  // A pose belongs to the cell holding its dense CORE. Centroid anchoring
  // breaks on long horizontal VFX trails (a flame stream drags the centroid
  // into the next column), so the column is taken from the mass-concentrated
  // band instead: the columns covering the first 40% of the ink. The row
  // keeps the centroid, which stays near the body's vertical middle.
  const coreColumn = (c) => {
    const w = c.maxX - c.minX + 1;
    const mass = new Float64Array(w);
    let total = 0;
    for (let y = c.minY; y <= c.maxY; y += 1) for (let x = c.minX; x <= c.maxX; x += 1) {
      const gi = y * SHEET_PX + x;
      if (label[gi] !== c.id) continue;
      const a = matted.rgba[gi * 4 + 3];
      if (a <= 8) continue;
      mass[x - c.minX] += a; total += a;
    }
    if (!total) return c.cx;
    let lo = -1, last = 0, cum = 0;
    for (let k = 0; k < w; k += 1) {
      cum += mass[k];
      if (lo < 0 && mass[k] > 0) lo = k;
      if (cum <= total * 0.4) last = k;
    }
    if (lo < 0) return c.cx;
    return c.minX + (lo + last) / 2;
  };

  for (const c of comps) {
    if (c.area < 60) continue; // speckle
    // Drop the soft ground shadow some generators draw: wide, flat, grey AND
    // thin. A knocked-down fighter is also wide and flat, so the height cut
    // has to stay under the lying pose's own thickness or it eats the pose.
    const cw = c.maxX - c.minX + 1, ch = c.maxY - c.minY + 1;
    if (ch <= 24 && cw > ch * 2.2 && c.chroma < 30 && c.area < cw * 20) continue;
    // A component spanning the whole sheet is a leftover frame, not a pose.
    if (cw >= SHEET_PX * 0.98 && ch >= SHEET_PX * 0.98) continue;
    const ax = coreColumn(c);
    const gx = Math.min(GRID - 1, Math.max(0, Math.floor(ax / CELL)));
    const gy = Math.min(GRID - 1, Math.max(0, Math.floor(c.cy / CELL)));
    byCell[gy * GRID + gx].push(c);
  }
  const cells = [];
  for (let i = 0; i < CELL_COUNT; i += 1) {
    const mine = byCell[i];
    if (!mine.length) {
      cells.push({ index: i, matted: null, bbox: null, components: 0 });
      continue;
    }
    const keep = new Set(mine.map((c) => c.id));
    const minX = Math.min(...mine.map((c) => c.minX));
    const minY = Math.min(...mine.map((c) => c.minY));
    const maxX = Math.max(...mine.map((c) => c.maxX));
    const maxY = Math.max(...mine.map((c) => c.maxY));
    const w = maxX - minX + 1, h = maxY - minY + 1;
    const clean = { width: w, height: h, rgba: Buffer.alloc(w * h * 4) };
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
      const gi = (minY + y) * SHEET_PX + (minX + x);
      if (!keep.has(label[gi])) continue;
      matted.rgba.copy(clean.rgba, (y * w + x) * 4, gi * 4, gi * 4 + 4);
    }
    cells.push({
      index: i, matted: clean, components: mine.length,
      parts: mine.map((c) => `a${c.area}[${c.minX},${c.minY} ${c.maxX - c.minX + 1}x${c.maxY - c.minY + 1}]`),
      bbox: { minX: 0, minY: 0, maxX: w - 1, maxY: h - 1, w, h, opaque: mine.reduce((a, c) => a + c.area, 0) },
      body: bodyExtent(clean),
    });
  }
  return cells;
}

function bakeFighter(id, { write = true } = {}) {
  const sheets = {};
  const qa = [];
  const sliced = SHEET_IDS.map((sheetId) => {
    const file = path.join(SOURCE, id, sheetId + '.png');
    if (!fs.existsSync(file)) throw new Error(`missing raw sheet: ${file}`);
    return sliceSheet(file);
  });
  const baseIndex = SHEET_IDS.indexOf('base');
  const refH = stanceReference(sliced[baseIndex] || []);
  const globalScale = refH ? STANCE_H / refH : 1;
  SHEET_IDS.forEach((sheetId, s) => {
    const cells = sliced[s];
    const scale = globalScale * sheetCorrection(cells, refH);
    // Pack the 16 normalized frames into a 4x4 atlas.
    const atlas = { width: FRAME * GRID, height: FRAME * GRID, rgba: Buffer.alloc(FRAME * GRID * FRAME * GRID * 4) };
    const frames = [];
    cells.forEach((cell, i) => {
      if (!cell.bbox) {
        qa.push({ sheet: sheetId, cell: i, problem: 'empty' });
        frames.push(null);
        return;
      }
      if (cell.bbox.h < 40 && cell.bbox.w < 120) qa.push({ sheet: sheetId, cell: i, problem: 'pose-too-small', h: cell.bbox.h });
      if (!cell.body) qa.push({ sheet: sheetId, cell: i, problem: 'no-head-landmark', h: cell.bbox.h });
      const cropped = cropRGBA(cell.matted, cell.bbox.minX, cell.bbox.minY, cell.bbox.w, cell.bbox.h);
      const frame = placeFrame(cropped, scale, cell.body, NATIVE_FACING[id][sheetId] > 0);
      const ax = (i % GRID) * FRAME, ay = Math.floor(i / GRID) * FRAME;
      blitRGBA(atlas, { x: ax, y: ay }, frame);
      frames.push({ x: ax, y: ay, w: FRAME, h: FRAME });
    });
    sheets[sheetId] = { atlas, frames, scale };
  });

  // Write atlases + build the clip table.
  const dir = path.join(VDIR, id);
  const sheetRefs = {};
  let atlasBytes = 0;
  for (const sheetId of SHEET_IDS) {
    const { atlas } = sheets[sheetId];
    const hash = sha256(encodeRGBA(atlas.width, atlas.height, atlas.rgba));
    const pair = writeVariantPair({ dir, name: sheetId, image: atlas, hash, alpha: true, quality: 85, write, keepPng: false });
    const url = '/assets/v/sprites/' + id + '/' + path.basename(pair.webpPath || pair.pngPath);
    sheetRefs[sheetId] = { atlas: url, width: atlas.width, height: atlas.height, bytes: pair.webpBytes || pair.pngBytes };
    atlasBytes += pair.webpBytes || pair.pngBytes;
  }

  const clips = {};
  for (const sheetId of SHEET_IDS) {
    for (const [clipId, spec] of Object.entries(SHEETS[sheetId].clips)) {
      clips[clipId] = {
        sheet: sheetId,
        frames: spec.cells.map((c) => sheets[sheetId].frames[c]).filter(Boolean),
        loop: Boolean(spec.loop),
        fps: spec.fps || 0,
        phases: spec.phases || null,
      };
    }
  }
  const anim = {
    schemaVersion: 1, fighterId: id, frame: FRAME, anchor: ANCHOR, stanceHeight: STANCE_H,
    sheets: sheetRefs, clips,
  };
  const animBuf = Buffer.from(JSON.stringify(anim));
  const animName = 'anim.' + shortHash(sha256(animBuf)) + '.json';
  if (write) {
    writeAtomic(path.join(dir, animName), animBuf);
    // Prune superseded hashes: content-addressed names mean every re-bake
    // leaves an orphan behind, and the client only ever loads the newest.
    const keep = new Set([animName]);
    for (const sheetId of SHEET_IDS) keep.add(path.basename(sheetRefs[sheetId].atlas));
    for (const name of fs.readdirSync(dir)) {
      if (!keep.has(name)) fs.unlinkSync(path.join(dir, name));
    }
  }
  return {
    id, anim: '/assets/v/sprites/' + id + '/' + animName,
    atlasBytes, animBytes: animBuf.length, qa,
    clipCount: Object.keys(clips).length,
  };
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function main() {
  const only = arg('--only', '').split(',').map((s) => s.trim()).filter(Boolean);
  const ids = only.length ? only : FIGHTERS.map((f) => f.id);
  const check = process.argv.includes('--check');
  const probe = arg('--probe', '');

  if (probe) {
    const cells = sliceSheet(path.resolve(probe));
    for (const c of cells) {
      console.log(`cell ${String(c.index).padStart(2)}: comps=${c.components}`
        + ` bbox=${c.bbox ? c.bbox.w + 'x' + c.bbox.h : 'none'} area=${c.bbox ? c.bbox.opaque : 0}`
        + ` body=${c.body ? c.body.h + '@' + c.body.headTop : 'none'}`
        + (c.parts ? '  ' + c.parts.join(' | ') : ''));
    }
    return;
  }

  const entries = [];
  let bad = 0;
  for (const id of ids) {
    try {
      const entry = bakeFighter(id, { write: !check });
      entries.push(entry);
      const problems = entry.qa.length;
      if (problems) bad += 1;
      console.log(`[slice] ${id}: clips=${entry.clipCount} atlas=${entry.atlasBytes}B qa=${problems}`
        + (problems ? ' ' + JSON.stringify(entry.qa.slice(0, 4)) : ''));
    } catch (err) {
      bad += 1;
      console.error(`[slice] ${id}: ${err.message}`);
    }
  }

  if (!check) {
    // Merge with the existing index: a partial run (--only) must not drop the
    // fighters that were baked earlier.
    const indexPath = path.join(OUT, 'sprites.json');
    let previous = { fighters: [] };
    if (fs.existsSync(indexPath)) {
      try {
        previous = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      } catch {
        previous = { fighters: [] };
      }
    }
    const merged = new Map((previous.fighters || []).map((f) => [f.id, f]));
    for (const { id, anim, atlasBytes, clipCount } of entries) {
      merged.set(id, { id, anim, atlasBytes, clipCount });
    }
    const index = {
      schemaVersion: 1, frame: FRAME, anchor: ANCHOR,
      generatedAt: new Date().toISOString(),
      fighters: [...merged.values()].sort((a, b) => a.id.localeCompare(b.id)),
    };
    writeAtomic(indexPath, Buffer.from(JSON.stringify(index, null, 2) + '\n'));
    console.log(`[slice] index written: ${index.fighters.length} fighter(s), ${bad} with QA flags`);
  }
  if (bad) process.exitCode = 1;
}

export {
  matteCell, stripGroundShadows, dropBackgroundPockets, stripSealFade, sliceSheet,
  bodyExtent,
  median, stanceReference, sheetCorrection, placeFrame, bakeFighter,
};

// Importable so the bake can be audited frame by frame; the CLI only runs when
// this file is executed directly.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
