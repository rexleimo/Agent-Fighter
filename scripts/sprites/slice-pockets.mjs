// Sprite slicing — background pocket removal and geometry helpers.
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
import { CELL } from './slice-shared.mjs';

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
 *
 * On a chroma sheet the walk has to reach further than the key tolerance,
 * because the backdrop seals its own pockets: the gap between an arm and the
 * ribs is flat magenta at its centre and a blended pink ring at its edge, and
 * the ring is what cuts it off from the outer ground. So the island grows
 * through the spill class but is judged only on its strict core, and the core
 * has to be most of the island. On the quartz react trial that is the whole
 * difference between a hole and a clean frame: 313 px of trapped backdrop in
 * one cell, 180 px in another, each ringed by 100 px of blend the key test
 * alone could never cross.
 */
const POCKET_MIN_AREA = 500;   // px; smaller islands are gaps, not ground
const POCKET_SD = 8;           // the sheet background is flat, shaded art is not
const POCKET_DEV = 3;          // island mean must sit on the sheet background value
const POCKET_INK_SHARE = 0.5;  // max fraction of a cell's ink one key may take
const POCKET_CORE_SHARE = 0.35; // min fraction of an island that must be pure key
// On a chroma sheet the share has to carry the whole decision, because the rim
// test it would otherwise lean on is meaningless there (see below). Measured on
// quartz react, the four visible magenta holes in body gaps are 0.80-0.86 pure
// core, while every patch carried by a real blend — the flecks between the
// shockwave shards, any faint effect core — is 0.55 or under. 0.7 cuts the
// holes and leaves the effects alone.
const CHROMA_CORE_SHARE = 0.7;
const GAP_MIN_AREA = 120;      // px; the smallest gap worth cutting
// The white floor exists so a small pale detail survives; on a chroma sheet the
// halo share above is the detail's protection instead, and it works at any size.
// An 81 px patch in the crotch gap of a kneeling pose is unmistakable on stage
// (quartz react cell 4), and 120 px was the only thing keeping it in.
const CHROMA_GAP_MIN = 24;     // px; smallest chroma gap worth cutting
const GAP_RIM_CHROMA = 0.35;   // a rim this colourful belongs to an effect

function isChromatic(r, g, b) {
  return Math.max(r, g, b) - Math.min(r, g, b) >= 24;
}

function dropBackgroundPockets(img, backdrop = detectBackdrop(img, { cell: CELL })) {
  const key = keyOf(backdrop);
  const spillish = key.isSpill || (() => false);
  const { width: sheetW, height: sheetH, rgba } = img;
  const dropped = [];
  for (let gy = 0; gy < GRID; gy += 1) {
    for (let gx = 0; gx < GRID; gx += 1) {
      const ox = gx * CELL, oy = gy * CELL;
      const at = (x, y) => ((oy + y) * sheetW + ox + x) * 4;
      const near = new Uint8Array(CELL * CELL);
      const walk = new Uint8Array(CELL * CELL);
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
          if (key.isKey(rgba[i], rgba[i + 1], rgba[i + 2])) {
            near[idx] = 1; walk[idx] = 1;
          } else if (spillish(rgba[i], rgba[i + 1], rgba[i + 2])) {
            walk[idx] = 1;
          }
        }
      }
      if (ink < 500 || !bgN) continue;
      const bgMean = bgSum / bgN;
      const seen = new Uint8Array(CELL * CELL);
      // On a white sheet an island grows through the spill class, because a
      // neutral anti-aliased rim is still ground. On a chroma sheet that growth
      // is useless: the blend is one connected seam ringing the whole silhouette,
      // so every hole rides the seam and the region measures the figure, not the
      // hole (quartz react cell 4: an 81 px crotch gap counted against a network
      // it could never be judged inside). Grow on the pure key alone and weigh
      // the blend locally instead.
      const grow = backdrop.kind === 'white' ? walk : near;
      const haloAt = (x, y, halo) => {
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= CELL || yy >= CELL) continue;
            const k = yy * CELL + xx;
            if (walk[k] && !near[k]) halo.add(k);
          }
        }
      };
      let taken = 0;
      for (let seed = 0; seed < CELL * CELL; seed += 1) {
        if (!near[seed] || seen[seed]) continue;
        const queue = [seed];
        seen[seed] = 1;
        const core = [];
        const halo = new Set();
        let n = 0, sum = 0, sq = 0;
        for (let head = 0; head < queue.length; head += 1) {
          const idx = queue[head];
          const x = idx % CELL, y = (idx / CELL) | 0, i = at(x, y);
          if (near[idx]) {
            const l = (Math.max(rgba[i], rgba[i + 1], rgba[i + 2])
              + Math.min(rgba[i], rgba[i + 1], rgba[i + 2])) / 2;
            n += 1; sum += l; sq += l * l;
            core.push(idx);
            if (grow === near) haloAt(x, y, halo);
          }
          const nb = [x > 0 ? idx - 1 : -1, x < CELL - 1 ? idx + 1 : -1,
            y > 0 ? idx - CELL : -1, y < CELL - 1 ? idx + CELL : -1];
          for (const k of nb) {
            if (k < 0 || !grow[k] || seen[k]) continue;
            seen[k] = 1; queue.push(k);
          }
        }
        const mean = sum / n;
        const sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
        if (sd > POCKET_SD || Math.abs(mean - bgMean) > POCKET_DEV) continue;
        if (n < POCKET_MIN_AREA) {
          if (n < (backdrop.kind === 'white' ? GAP_MIN_AREA : CHROMA_GAP_MIN)) continue;
          // The rim test is a white-sheet instrument. It asks whether the pixels
          // hugging the island are colourful, on the logic that a neutral rim
          // means ground and a bright rim means an effect painted over it. A
          // chroma key breaks that logic completely: the backdrop IS a bright
          // colour, so it tints every art pixel it blends into and the rim of a
          // plain hole measures 100% colourful. Measured on quartz react, the
          // islands sitting in the crotch gap, behind the knee and under the
          // elbow were flat (sd 3.4-3.6), on the backdrop value (dev under 0.3)
          // and 0.80-0.86 pure core — holes by every number except the rim.
          // There the core share below has to decide alone.
          if (backdrop.kind === 'white') {
            let rim = 0, colourful = 0;
            for (const idx of core) {
              const x = idx % CELL, y = (idx / CELL) | 0;
              const nb = [x > 0 ? idx - 1 : -1, x < CELL - 1 ? idx + 1 : -1,
                y > 0 ? idx - CELL : -1, y < CELL - 1 ? idx + CELL : -1];
              for (const k of nb) {
                if (k < 0 || walk[k] || !opaque[k]) continue;
                const i = at(k % CELL, (k / CELL) | 0);
                rim += 1;
                if (isChromatic(rgba[i], rgba[i + 1], rgba[i + 2])) colourful += 1;
              }
            }
            if (!rim || colourful / rim >= GAP_RIM_CHROMA) continue;
          }
        }
        // An island is judged by its core, so the core has to be most of it: a
        // magenta effect with a flat bright centre must not ride a thin
        // backdrop halo out of the frame.
        const size = grow === near ? n + halo.size : queue.length;
        const share = backdrop.kind === 'white' ? POCKET_CORE_SHARE : CHROMA_CORE_SHARE;
        if (size * share > n) continue;
        if (taken + queue.length > ink * POCKET_INK_SHARE) continue;
        for (const idx of queue) {
          rgba[at(idx % CELL, (idx / CELL) | 0) + 3] = 0;
        }
        taken += queue.length;
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
 *
 * A sheet may still be drawn at the wrong size, and only its own upright poses
 * can prove it — see standingCorrection, which reads a sheet's scale off the
 * clips the game plays while the fighter is on their feet, never off the first
 * cells and never off a pose that is allowed to crouch.
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
 * Ink area of the same stance cells the height reference came from.
 *
 * Height alone cannot tell a zoom from a pose: a crouched wind-up is 40%
 * shorter than the stance but still carries the whole body, while a cell the
 * generator drew too small carries fewer pixels AND is shorter. Pairing the
 * two measurements separates the two cases, which a height-only correction
 * cannot (it inflated every crouch).
 */
function stanceArea(baseCells) {
  const as = SHEETS.base.clips.idle.cells
    .map((i) => (baseCells[i] && baseCells[i].bbox ? baseCells[i].bbox.opaque : 0))
    .filter((a) => a > 0);
  return as.length ? median(as) : 0;
}

/** Width of the same stance cells, so a pose can be judged on both axes. */
function stanceWidth(baseCells) {
  const ws = SHEETS.base.clips.idle.cells
    .map((i) => (baseCells[i] && baseCells[i].bbox ? baseCells[i].bbox.w : 0))
    .filter((w) => w > 0);
  return ws.length ? median(ws) : 0;
}

export { dropBackgroundPockets, bboxOf, feetCenterX, resizeBilinear, bodyExtent, median, stanceReference, stanceArea, stanceWidth, isChromatic };
