/**
 * Sprite sheet slicer / baker.
 *
 * Turns a raw 4x4 generated sheet into game-ready frames:
 *   split 16 cells -> matte (flood-fill the sheet's own backdrop, white or
 *   chroma) -> strip the baked contact shadow -> key out the enclosed backdrop
 *   pockets -> measure head-to-feet per cell -> one scale per fighter ->
 *   feet-baseline alignment -> pack a 4x4 atlas -> emit per-fighter anim JSON.
 *
 * The runtime contract (web/sprite.js) is: every frame is a tight ink crop
 * carrying its offset (ox, oy) from ANCHOR [x, y], the fighter's feet sit on
 * that anchor, and clips map server move phases to frame indices. Nothing
 * here knows about combat.
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

/**
 * Clips that are standing in the game's own terms, not by measurement.
 *
 * A wind-up, a heavy kick or a super finisher may put the head anywhere and
 * still be correct art. A guard and a blockstun may not: the fighter is on
 * their feet bracing. Those are the only poses inside a sheet that can prove
 * the sheet was drawn at the wrong size, so they are what the sheet scale is
 * read off. The tall-cells rule this replaces let an off-model react sheet
 * through whenever its crouches happened to clear the height filter, and could
 * not tell a shrunk sheet from a hunched one at all.
 */
const STANDING_CLIPS = new Set(['idle', 'walk', 'guard', 'blockstun']);
const STANDING_SCALE_MIN = 0.8;
const STANDING_SCALE_MAX = 1.25;
// Below this drift a standing pose is simply the stance at breathing height
// and the existing sheet correction is left in charge.
const STANDING_DRIFT_MIN = 0.06;
// How far the bounded correction is allowed to fall short of the stance before
// the sheet is called off-model art. A uniform resize is the only thing this
// rule can honestly do, so when the clamp cannot reach stance height the rest
// is a drawing problem and only a redraw closes it. Mass and width per body
// height are reported as evidence but never judged: a guard is braced square-on
// with the arms folded in, so it carries more body per unit height than an open
// side stance by design, and scoring that as a defect buried the sheets that
// were simply drawn small.
const STANDING_RESIDUAL_MAX = 0.1;

function standingCells(sheetId, cells) {
  const picked = [];
  for (const [clipId, spec] of Object.entries(SHEETS[sheetId].clips)) {
    if (!STANDING_CLIPS.has(clipId)) continue;
    for (const i of spec.cells) {
      const c = cells[i];
      if (c && c.body && c.bbox && c.bbox.opaque) picked.push(c);
    }
  }
  return picked;
}

/**
 * Sheet scale read off the standing poses the sheet itself contains.
 *
 * Always `{ evidence, scale? }`, plus `defect` when the bounded correction
 * could not reach stance height:
 *  - `scale` is absent below STANDING_DRIFT_MIN — the sheet is at model and the
 *    existing sheet correction keeps the lead.
 *  - `defect` carries the same evidence with the wanted scale and the residual
 *    share left after clamping. It is not a reason to skip the correction; a
 *    25% enlargement that leaves the pose 18% short still removes most of the
 *    on-screen pop, and the residual is what gets registered as art debt.
 *  - `{}` means the sheet has no standing pose (punch/kick/skill), which is an
 *    honest "cannot judge", not a pass.
 */
function standingCorrection(sheetId, cells, ref) {
  const pool = standingCells(sheetId, cells);
  if (!pool.length || !ref.h || !ref.w || !ref.a) return {};
  const h = median(pool.map((c) => c.body.h));
  const w = median(pool.map((c) => c.bbox.w));
  const a = median(pool.map((c) => c.bbox.opaque));
  const scale = ref.h / h;
  const byWidth = (w / h) / (ref.w / ref.h);
  const byArea = (Math.sqrt(a) / h) / (Math.sqrt(ref.a) / ref.h);
  const evidence = {
    poses: pool.length,
    stanceH: ref.h,
    standingH: h,
    heightShare: +(h / ref.h).toFixed(3),
    byWidth: +byWidth.toFixed(3),
    byArea: +byArea.toFixed(3),
  };
  // Nothing to correct means nothing to judge.
  if (Math.abs(scale - 1) <= STANDING_DRIFT_MIN) return { evidence };
  const applied = Math.min(STANDING_SCALE_MAX, Math.max(STANDING_SCALE_MIN, scale));
  const residual = h * applied / ref.h;
  const out = { evidence, scale: applied };
  if (Math.abs(residual - 1) > STANDING_RESIDUAL_MAX) {
    out.defect = {
      ...evidence,
      wantedScale: +scale.toFixed(3),
      appliedScale: +applied.toFixed(3),
      residualShare: +residual.toFixed(3),
    };
  }
  return out;
}

/**
 * Per-cell scale, so consecutive frames of one clip cannot disagree in size.
 *
 * The generator draws each cell of a sheet at its own zoom: forge's heavy-kick
 * row carries 41% of the pixels his stance row carries, and slag's dash goes
 * 241px -> 113px inside one four-frame clip. A fighter-global and even a
 * sheet-global scale leave that pop, and it is what reads on screen as the
 * same character being "one big, one small".
 *
 * The correction is applied only when the two independent measurements agree:
 *  - head-to-feet height says the figure is small AND ink area says the body
 *    is smaller too -> the cell was drawn zoomed out: enlarge it.
 *  - height says small but area says the same -> it is a crouch, not a zoom:
 *    leave the sheet scale alone.
 * The smaller of the two agreeing corrections wins, and the result is bounded,
 * so no single measurement can rewrite a pose.
 */
const CELL_SCALE_MAX = 1.25;
const CELL_SCALE_MIN = 0.72;

/**
 * Smallest dominant component that can still be a fighter.
 *
 * Measured over all 1280 baked cells: the smallest real pose (a knocked-down
 * body) has a 6.3k dominant component, the worst generator miss has 366. The
 * cut sits 8x below the real minimum so it can only fire on a missing body.
 */
const BODY_COMPONENT_MIN = 3000;

function cellScale(cell, refH, refA, fallback) {
  if (!cell.body || !cell.bbox || !refH || !refA || !cell.bbox.opaque) return fallback;
  const dH = refH / cell.body.h - 1;
  const dA = Math.sqrt(refA / cell.bbox.opaque) - 1;
  if (dH * dA <= 0) return fallback;
  const c = Math.abs(dH) < Math.abs(dA) ? dH + 1 : dA + 1;
  return fallback * Math.min(CELL_SCALE_MAX, Math.max(CELL_SCALE_MIN, c));
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

/**
 * Place a cropped cell so the measured feet land on ANCHOR, and return the
 * tight ink crop with its offset from that anchor.
 *
 * The offset is the contract. A running lunge puts the head far to one side of
 * the feet centroid, and a fixed square frame used to cut it off there (the
 * decapitated dash frames). Shipping the tight crop plus (ox, oy) keeps every
 * body pixel without sliding the feet off the logical position or shrinking
 * the pose relative to its neighbours.
 */
function placeFrame(cropped, scale, body, flip = false) {
  const bodyH = body ? body.h : cropped.height;
  // Head-to-feet stays inside the nominal cell height so a pose cannot be
  // drawn taller than the stage headroom; width is no longer a constraint
  // because the frame is the ink itself, not a box around it.
  const room = ANCHOR[1] - 6;
  const fit = Math.min(scale, room / bodyH);
  const dw = Math.max(1, Math.round(cropped.width * fit));
  const dh = Math.max(1, Math.round(cropped.height * fit));
  const scaled = flip ? mirrorX(resizeBilinear(cropped, dw, dh)) : resizeBilinear(cropped, dw, dh);
  const scaledBbox = { minX: 0, minY: 0, maxX: dw - 1, maxY: dh - 1, w: dw, h: dh };
  const fx = feetCenterX(scaled, scaledBbox);
  const dx = Math.round(ANCHOR[0] - fx);
  const footRow = body ? Math.round((body.feet + 1) * (dh / cropped.height)) : dh;
  const dy = ANCHOR[1] - footRow;
  const ink = bboxOf(scaled) || { minX: 0, minY: 0, w: dw, h: dh };
  const tight = cropRGBA(scaled, ink.minX, ink.minY, ink.w, ink.h);
  return { ...tight, ox: dx + ink.minX, oy: dy + ink.minY };
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
 * The art rows actually drawn on a sheet, top to bottom.
 *
 * Only body-sized components vote: a detached flame wisp between two rows
 * would otherwise split a row that is really one.
 */
function artRows(comps) {
  const bodies = comps.filter((c) => (c.maxY - c.minY + 1) >= 60 && c.area >= 1500);
  const sorted = [...bodies].sort((a, b) => a.cy - b.cy);
  const rows = [];
  for (const c of sorted) {
    const last = rows[rows.length - 1];
    if (last && c.cy - last.cyMax <= CELL * 0.5) last.cyMax = Math.max(last.cyMax, c.cy);
    else rows.push({ cyMin: c.cy, cyMax: c.cy });
  }
  return rows;
}

/**
 * Two whole bodies stacked in one cell.
 *
 * A fighter drawn next to their own effect is one pose and measures as a
 * vertical overlap near 100%; a fighter drawn *above* another fighter because
 * the sheet's rows fell into the same grid row overlaps by nothing at all.
 * Measured over the off-grid forge sheets: every doubled cell has a second
 * body at 94-99% of the first with 0% overlap, while the nearest legitimate
 * cell (quartz skill, a figure beside a large summoned effect) is 86% share
 * but 100% overlap. The cut therefore sits on overlap, not on size.
 */
function doubledBodies(comps) {
  const bodies = comps.filter((c) => (c.maxY - c.minY + 1) >= 60 && c.area >= 1500);
  for (let i = 0; i < bodies.length; i += 1) for (let j = i + 1; j < bodies.length; j += 1) {
    const a = bodies[i], b = bodies[j];
    const big = a.area >= b.area ? a : b, small = a.area >= b.area ? b : a;
    if (small.area < big.area * 0.5) continue;
    const overlap = Math.min(big.maxY, small.maxY) - Math.max(big.minY, small.minY) + 1;
    const shorter = Math.min(big.maxY - big.minY + 1, small.maxY - small.minY + 1);
    if (overlap <= shorter * 0.25) return true;
  }
  return false;
}

/**
 * Split cross-row merged components by marker watershed.
 *
 * Two poses whose effects touch matte as one component, and centroid routing
 * then hands both bodies to a single cell. Eroding the mask kills the thin
 * petal necks before it kills a torso, so the surviving cores mark the poses;
 * flooding each core back through the un-eroded mask gives every effect pixel
 * to the pose it touches, which a straight horizontal cut cannot do (it would
 * sever legs or ring). `label` is rewritten in place; returns the replacement
 * comp list plus the ids that could not be split.
 */
function splitCrossRowComponents(label, comps, matted, markers, seedBelowY = 0, claimUpper = []) {
  const w = matted.width, h = matted.height;
  let maxId = comps.reduce((m, c) => Math.max(m, c.id), 0);
  const out = [];
  const failed = [];
  const stale = [];
  const claimed = new Set();
  for (const comp of comps) {
    const bw = comp.maxX - comp.minX + 1, bh = comp.maxY - comp.minY + 1;
    if (bh <= CELL * 1.2) { out.push(comp); continue; }
    const mask = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y += 1) for (let x = 0; x < bw; x += 1) {
      const gi = (comp.minY + y) * w + (comp.minX + x);
      if (label[gi] === comp.id && matted.rgba[gi * 4 + 3] > 8) mask[y * bw + x] = 1;
    }
    let cores = null;
    // coral's petal neck measured ~5px thick: radius 4 still left one core.
    for (const radius of [2, 3, 4, 6]) {
      let cur = mask;
      for (let pass = 0; pass < radius; pass += 1) {
        const next = new Uint8Array(bw * bh);
        for (let y = 1; y < bh - 1; y += 1) for (let x = 1; x < bw - 1; x += 1) {
          const i = y * bw + x;
          if (!cur[i]) continue;
          let all = 1;
          for (let dy = -1; dy <= 1 && all; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
            if (!cur[i + dy * bw + dx]) { all = 0; break; }
          }
          next[i] = all;
        }
        cur = next;
      }
      const seen = new Int32Array(bw * bh);
      const queue = new Int32Array(bw * bh);
      const found = [];
      let cid = 0;
      for (let seed = 0; seed < bw * bh; seed += 1) {
        if (!cur[seed] || seen[seed]) continue;
        cid += 1;
        let head = 0, tail = 0, area = 0, sy = 0;
        let minX = bw, minY = bh, maxX = -1, maxY = -1;
        queue[tail++] = seed; seen[seed] = cid;
        while (head < tail) {
          const i = queue[head++]; area += 1;
          const x = i % bw, y = (i / bw) | 0;
          sy += y;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (x > 0 && cur[i - 1] && !seen[i - 1]) { seen[i - 1] = cid; queue[tail++] = i - 1; }
          if (x < bw - 1 && cur[i + 1] && !seen[i + 1]) { seen[i + 1] = cid; queue[tail++] = i + 1; }
          if (y > 0 && cur[i - bw] && !seen[i - bw]) { seen[i - bw] = cid; queue[tail++] = i - bw; }
          if (y < bh - 1 && cur[i + bw] && !seen[i + bw]) { seen[i + bw] = cid; queue[tail++] = i + bw; }
        }
        found.push({ id: cid, area, cy: comp.minY + sy / area, minX, minY, maxX, maxY });
      }
      // Only body cores may mark: an eroded ring pocket is big but headless,
      // and a core still spanning two rows is the merge itself, not a pose.
      const bodies = [];
      for (const c of found.sort((a, b) => b.area - a.area)) {
        if (c.area < 1500 || c.maxY - c.minY + 1 > CELL * 1.2) continue;
        const cw = c.maxX - c.minX + 1, ch = c.maxY - c.minY + 1;
        const crop = { width: cw, height: ch, rgba: Buffer.alloc(cw * ch * 4) };
        for (let y = 0; y < ch; y += 1) for (let x = 0; x < cw; x += 1) {
          const i = (c.minY + y) * bw + (c.minX + x);
          if (seen[i] !== c.id) continue;
          const gi = (comp.minY + c.minY + y) * w + (comp.minX + c.minX + x);
          matted.rgba.copy(crop.rgba, (y * cw + x) * 4, gi * 4, gi * 4 + 4);
        }
        const be = bodyExtent(crop);
        if (be && be.h >= 100) bodies.push(c);
      }
      if (bodies.length >= markers) { cores = { seen, picks: bodies.slice(0, markers) }; break; }
    }
    if (!cores) { failed.push(comp.id); out.push(comp); continue; }
    const owner = new Int32Array(bw * bh);
    const queue = new Int32Array(bw * bh);
    const seeded = cores.picks.map(() => 0);
    let head = 0, tail = 0;
    cores.picks.forEach((c, k) => {
      for (let i = 0; i < bw * bh; i += 1) {
        if (cores.seen[i] !== c.id) continue;
        // The lower core seeds only below the registered row, so ink above it
        // joins whichever pose it hangs off by the short path, not the ring.
        if (seedBelowY && c.cy > seedBelowY && comp.minY + ((i / bw) | 0) < seedBelowY) continue;
        owner[i] = k + 1; queue[tail++] = i; seeded[k] += 1;
      }
    });
    if (seeded.some((n) => !n)) { failed.push(comp.id); out.push(comp); continue; }
    while (head < tail) {
      const i = queue[head++];
      const x = i % bw, y = (i / bw) | 0;
      if (x > 0 && mask[i - 1] && !owner[i - 1]) { owner[i - 1] = owner[i]; queue[tail++] = i - 1; }
      if (x < bw - 1 && mask[i + 1] && !owner[i + 1]) { owner[i + 1] = owner[i]; queue[tail++] = i + 1; }
      if (y > 0 && mask[i - bw] && !owner[i - bw]) { owner[i - bw] = owner[i]; queue[tail++] = i - bw; }
      if (y < bh - 1 && mask[i + bw] && !owner[i + bw]) { owner[i + bw] = owner[i]; queue[tail++] = i + bw; }
    }
    // Distance alone cuts a boot where a ring spike touches it: the lower
    // core's path up the spike beats the upper core's path down the leg, so
    // the boot ships as two fragments in two cells. Registered boxes hand
    // measured contact-zone ink back to the topmost pose.
    if (claimUpper.length) {
      let upperK = 0;
      cores.picks.forEach((c, k) => { if (c.cy < cores.picks[upperK].cy) upperK = k; });
      for (const box of claimUpper) {
        let touched = 0;
        const y0 = Math.max(box.y0 - comp.minY, 0), y1 = Math.min(box.y1 - comp.minY, bh - 1);
        const x0 = Math.max(box.x0 - comp.minX, 0), x1 = Math.min(box.x1 - comp.minX, bw - 1);
        for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) {
          const i = y * bw + x;
          if (!mask[i]) continue;
          touched += 1;
          owner[i] = upperK + 1;
        }
        if (touched) claimed.add(box);
      }
    }
    const pieces = cores.picks.map(() => ({
      area: 0, sx: 0, sy: 0, chroma: 0, minX: w, minY: h, maxX: -1, maxY: -1,
    }));
    for (let y = 0; y < bh; y += 1) for (let x = 0; x < bw; x += 1) {
      const i = y * bw + x;
      if (!owner[i]) continue;
      const gi = (comp.minY + y) * w + (comp.minX + x);
      const p = pieces[owner[i] - 1];
      const r = matted.rgba[gi * 4], g = matted.rgba[gi * 4 + 1], b = matted.rgba[gi * 4 + 2];
      p.area += 1; p.sx += comp.minX + x; p.sy += comp.minY + y;
      p.chroma += Math.max(r, g, b) - Math.min(r, g, b);
      if (comp.minX + x < p.minX) p.minX = comp.minX + x;
      if (comp.minX + x > p.maxX) p.maxX = comp.minX + x;
      if (comp.minY + y < p.minY) p.minY = comp.minY + y;
      if (comp.minY + y > p.maxY) p.maxY = comp.minY + y;
      label[gi] = maxId + owner[i];
    }
    pieces.forEach((p, k) => {
      out.push({
        id: maxId + k + 1, area: p.area, cx: p.sx / p.area, cy: p.sy / p.area,
        minX: p.minX, minY: p.minY, maxX: p.maxX, maxY: p.maxY, chroma: p.chroma / p.area,
      });
    });
    maxId += pieces.length;
  }
  for (const box of claimUpper) if (!claimed.has(box)) stale.push(box);
  return { comps: out, failed, stale };
}

/**
 * The AI grid drifts: a pose can overflow its 256px cell (head above the top
 * edge) while a neighbour's head/fist intrudes at the bottom. Fixed-cell crops
 * therefore cut heads and capture stray limbs. Instead we matte the whole
 * sheet and assign each connected component to the cell holding its CORE
 * COLUMN and its CENTROID ROW: a pose's overflow head stays connected to its
 * own body (kept), while an intruding neighbour fragment is a separate
 * component centred elsewhere (dropped). The union bbox of a cell's components
 * is the true pose extent.
 */
function sliceSheet(file, { rowOrder = null, splitSpec = null, headOverrides = null } = {}) {
  const src = readPNG(file);
  if (src.width !== SHEET_PX || src.height !== SHEET_PX) {
    throw new Error(`${file}: expected ${SHEET_PX}x${SHEET_PX}, got ${src.width}x${src.height}`);
  }
  const backdrop = detectBackdrop(src, { cell: CELL });
  const matted = matteCell(src, backdrop);
  stripGroundShadows(matted);
  dropBackgroundPockets(matted, backdrop);
  stripSealFade(matted);
  const labelled = labelComponents(matted);
  const label = labelled.label;
  let comps = labelled.comps;
  let splitFailed = [];
  let splitStale = [];
  if (splitSpec) {
    const split = splitCrossRowComponents(
      label, comps, matted, splitSpec.markers, splitSpec.seedBelowY || 0, splitSpec.claimUpper || [],
    );
    comps = split.comps;
    splitFailed = split.failed;
    splitStale = split.stale;
  }
  const byCell = Array.from({ length: CELL_COUNT }, () => []);
  const kept = [];
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
    kept.push(c);
  }
  // The generator does not always obey the 4x4 layout. forge came back with
  // five rows of four on react and kick; under a fixed grid, art rows two and
  // three both floor into grid row one, so a single dash cell received two
  // whole bodies stacked and the game drew a doubled fighter whose feet sat on
  // neither baseline. When the sheet's own rows disagree with GRID, the pose
  // that answers each spec row comes from ART_ROW_ORDER for that sheet.
  const rows = artRows(kept);
  const remap = rows.length !== GRID;
  const order = remap ? (rowOrder || rows.map((_, i) => i)) : null;
  const nearestRow = (c) => {
    let best = 0, bestDistance = Infinity;
    for (let i = 0; i < rows.length; i += 1) {
      const mid = (rows[i].cyMin + rows[i].cyMax) / 2;
      const d = Math.abs(c.cy - mid);
      if (d < bestDistance) { bestDistance = d; best = i; }
    }
    return best;
  };
  for (const c of kept) {
    const ax = coreColumn(c);
    const gx = Math.min(GRID - 1, Math.max(0, Math.floor(ax / CELL)));
    let gy = Math.min(GRID - 1, Math.max(0, Math.floor(c.cy / CELL)));
    if (remap) {
      gy = order.indexOf(nearestRow(c)); // -1 = an art row no clip uses
      if (gy < 0 || gy * GRID + gx >= CELL_COUNT) continue;
    }
    byCell[gy * GRID + gx].push(c);
  }
  const cells = [];
  cells.artRows = rows.length;
  cells.splitFailed = splitFailed;
  cells.splitStale = splitStale;
  cells.crossRowLeft = kept
    .filter((c) => (c.maxY - c.minY + 1) > CELL * 1.2)
    .map((c) => ({ id: c.id, h: c.maxY - c.minY + 1 }));
  for (let i = 0; i < CELL_COUNT; i += 1) {
    const mine = byCell[i];
    if (!mine.length) {
      cells.push({ index: i, matted: null, bbox: null, components: 0, doubled: false });
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
      doubled: doubledBodies(mine),
      largest: Math.max(...mine.map((c) => c.area)),
      parts: mine.map((c) => `a${c.area}[${c.minX},${c.minY} ${c.maxX - c.minX + 1}x${c.maxY - c.minY + 1}]`),
      bbox: { minX: 0, minY: 0, maxX: w - 1, maxY: h - 1, w, h, opaque: mine.reduce((a, c) => a + c.area, 0) },
      origin: { x: minX, y: minY },
      body: bodyExtent(clean),
    });
  }
  if (headOverrides) {
    cells.bodyOverrideStale = [];
    for (const [key, sheetY] of Object.entries(headOverrides)) {
      const i = Number(key);
      const c = cells[i];
      const rel = c && c.body && c.origin ? sheetY - c.origin.y : -1;
      if (!c || !c.body || rel < 0 || rel > c.body.feet) { cells.bodyOverrideStale.push(i); continue; }
      c.body = { ...c.body, headTop: rel, h: c.body.feet - rel + 1 };
    }
  }
  return cells;
}

/**
 * Ink, top edge and bottom edge of a placed frame, in anchor space (oy shifts
 * the tight crop back onto the shared baseline so clips stay comparable).
 *
 * Rows need three pixels to count as an edge: a stray effect wisp above the
 * head is not where the drawing starts.
 */
function frameStats(img, oy = 0) {
  let ink = 0, top = -1, bottom = -1;
  for (let y = 0; y < img.height; y += 1) {
    let row = 0;
    for (let x = 0; x < img.width; x += 1) {
      if (img.rgba[(y * img.width + x) * 4 + 3] > 24) row += 1;
    }
    ink += row;
    if (row >= 3) { if (top < 0) top = y; bottom = y; }
  }
  return { ink, top: top < 0 ? -1 : top + oy, bottom: bottom < 0 ? -1 : bottom + oy, span: top < 0 ? 0 : bottom - top + 1 };
}

/**
 * Geometry contract over the drawings a clip actually ships, per clip.
 *
 * Three failures the playtest reported, each measurable before anything
 * leaves the bake: a frame with no body in it (the character vanishes
 * mid-combo), a frame whose feet are not on the shared baseline (the sprite
 * reads as detached), and consecutive drawings that jump in size (一大一小).
 * Prone poses are exempt from the size check — lying flat is a real height
 * change, not a zoom.
 */
const PRONE_CLIPS = new Set(['knockdown', 'getup']);
const FRAME_THIN_SHARE = 0.4;
const BASELINE_TOLERANCE = 6;
const CLIP_SPREAD_MAX = 2.3;

function auditClip(sheetId, clipId, cells, stats) {
  const problems = [];
  const mine = cells.filter((i) => stats[i]);
  if (!mine.length) return problems;
  const inks = mine.map((i) => stats[i].ink).sort((a, b) => a - b);
  const medianInk = inks[inks.length >> 1] || 1;
  for (const i of mine) {
    const st = stats[i];
    if (st.ink < medianInk * FRAME_THIN_SHARE) {
      problems.push({ sheet: sheetId, clip: clipId, cell: i, problem: 'frame-too-thin', ink: st.ink, median: medianInk });
    }
    if (st.bottom < ANCHOR[1] - BASELINE_TOLERANCE || st.bottom > FRAME - 1) {
      problems.push({ sheet: sheetId, clip: clipId, cell: i, problem: 'off-baseline', bottom: st.bottom });
    }
  }
  if (PRONE_CLIPS.has(clipId)) return problems;
  const spans = mine.map((i) => stats[i].span);
  const min = Math.min(...spans), max = Math.max(...spans);
  if (min > 0 && max / min > CLIP_SPREAD_MAX) {
    problems.push({ sheet: sheetId, clip: clipId, problem: 'clip-scale-spread', min, max, ratio: +(max / min).toFixed(2) });
  }
  return problems;
}

function bakeFighter(id, { write = true } = {}) {
  const sheets = {};
  const qa = [];
  const repairs = [];
  const sliced = SHEET_IDS.map((sheetId) => {
    const file = path.join(SOURCE, id, sheetId + '.png');
    if (!fs.existsSync(file)) throw new Error(`missing raw sheet: ${file}`);
    return sliceSheet(file, {
      rowOrder: ART_ROW_ORDER[id]?.[sheetId] || null,
      splitSpec: CROSS_ROW_SPLITS[id + '/' + sheetId] || null,
      headOverrides: BODY_HEAD_OVERRIDES[id + '/' + sheetId] || null,
    });
  });
  const baseIndex = SHEET_IDS.indexOf('base');
  const refH = stanceReference(sliced[baseIndex] || []);
  const refA = stanceArea(sliced[baseIndex] || []);
  const refW = stanceWidth(sliced[baseIndex] || []);
  const globalScale = refH ? STANCE_H / refH : 1;
  const stance = { h: refH, w: refW, a: refA };
  const standing = {};
  const defects = [];
  SHEET_IDS.forEach((sheetId, s) => {
    const cells = sliced[s];
    // Orientation is a property a person read off these drawings: facingReview
    // throws when no read exists, so an unadjudicated sheet cannot bake at all.
    const review = facingReview(id, sheetId);
    const sha = shortHash(hashFile(path.join(SOURCE, id, sheetId + '.png')));
    if (sha !== review.sha) {
      qa.push({ sheet: sheetId, problem: 'facing-stale', adjudicatedAgainst: review.sha, now: sha });
    }
    const stray = review.flip.filter((c) => !Number.isInteger(c) || c < 0 || c >= CELL_COUNT);
    if (stray.length) qa.push({ sheet: sheetId, problem: 'facing-cell-out-of-range', cells: stray });
    // An off-contract sheet is only shippable once its row map is declared:
    // without one, the bake is guessing which pose answers which clip.
    if (cells.artRows !== GRID && !ART_ROW_ORDER[id]?.[sheetId]) {
      qa.push({ sheet: sheetId, problem: 'off-layout-sheet', artRows: cells.artRows });
    }
    // Two whole bodies in one cell is the doubled-fighter defect the renderer
    // cannot fix: whichever frame is picked, its feet are on neither baseline.
    const stacked = cells.filter((c) => c.doubled).map((c) => c.index);
    if (stacked.length) qa.push({ sheet: sheetId, problem: 'multi-body-cell', cells: stacked });
    // A component taller than a cell and a fraction holds two poses joined by
    // touching effect ink; doubledBodies cannot see it (one component), so the
    // height itself is the gate. Registered sheets split it; new drift fails.
    if (cells.crossRowLeft.length) {
      qa.push({ sheet: sheetId, problem: 'cross-row-component', comps: cells.crossRowLeft });
    }
    if (cells.splitFailed.length) {
      qa.push({ sheet: sheetId, problem: 'cross-row-split-failed', comps: cells.splitFailed });
    }
    if (cells.splitStale.length) {
      qa.push({ sheet: sheetId, problem: 'cross-row-claim-stale', boxes: cells.splitStale });
    }
    if (cells.bodyOverrideStale && cells.bodyOverrideStale.length) {
      qa.push({ sheet: sheetId, problem: 'body-head-override-stale', cells: cells.bodyOverrideStale });
    }
    const stand = standingCorrection(sheetId, cells, stance);
    const sheetScale = globalScale
      * (stand.scale !== undefined ? stand.scale : sheetCorrection(cells, refH));
    // cellScale judges a raw cell against the raw stance. When this sheet has
    // already been rescaled off its own standing pose, the reference has to
    // move with the sheet, or a cell the sheet just fixed is corrected a second
    // time and the hurt poses come out giants.
    const sheetFactor = stand.scale !== undefined ? stand.scale : 1;
    const refHs = refH ? refH / sheetFactor : refH;
    const refAs = refA ? refA / (sheetFactor * sheetFactor) : refA;
    if (stand.evidence) {
      const key = id + '/' + sheetId;
      const known = stand.defect ? OFF_MODEL_ART[key] || null : null;
      standing[sheetId] = {
        ...stand.evidence,
        appliedScale: stand.scale !== undefined ? +stand.scale.toFixed(3) : null,
        // After the applied scale, how far the standing pose still sits from
        // stance height. This is the number a renderer can check without pixels:
        // a shipped atlas whose standing pose is off-model has to say so here.
        residualShare: stand.defect ? stand.defect.residualShare : null,
        offModel: stand.defect ? { registered: !!known, reason: known ? known.reason : null } : null,
      };
    }
    if (stand.defect) {
      defects.push({ sheet: sheetId, ...stand.defect, known: OFF_MODEL_ART[id + '/' + sheetId] || null });
      // Registered sheets are art debt with a decision behind them; an
      // unregistered one is new drift and has to fail the bake.
      if (!OFF_MODEL_ART[id + '/' + sheetId]) {
        qa.push({ sheet: sheetId, problem: 'off-model-standing-pose', ...stand.defect });
      }
    }
    // Shelf-pack the tight frames. A fixed 4x4 grid of square cells is what
    // cut the wide lunges; the packer only has to keep rects disjoint.
    const placed = [];
    const frames = [];
    const stats = [];
    cells.forEach((cell, i) => {
      if (!cell.bbox) {
        qa.push({ sheet: sheetId, cell: i, problem: 'empty' });
        frames.push(null);
        stats.push(null);
        return;
      }
      if (cell.bbox.h < 40 && cell.bbox.w < 120) qa.push({ sheet: sheetId, cell: i, problem: 'pose-too-small', h: cell.bbox.h });
      if (!cell.body) qa.push({ sheet: sheetId, cell: i, problem: 'no-head-landmark', h: cell.bbox.h });
      // An effect burst with the fighter missing (coral's ex finisher came back
      // as scattered petals and nothing else) would blank the character in the
      // middle of a combo. Ship no such frame: the clip repeats a real pose.
      if (cell.largest < BODY_COMPONENT_MIN) {
        repairs.push({ sheet: sheetId, cell: i, largest: cell.largest });
        frames.push(null);
        stats.push(null);
        return;
      }
      const cropped = cropRGBA(cell.matted, cell.bbox.minX, cell.bbox.minY, cell.bbox.w, cell.bbox.h);
      const scale = cellScale(cell, refHs, refAs, sheetScale);
      placed.push({ i, frame: placeFrame(cropped, scale, cell.body, shipsFlipped(review, i)) });
    });
    const packed = shelfPack(placed.map((p) => ({ w: p.frame.width, h: p.frame.height })), { gutter: 2, maxWidth: FRAME * GRID });
    const atlasH = Math.max(FRAME, packed.height);
    const atlas = { width: packed.width, height: atlasH, rgba: Buffer.alloc(packed.width * atlasH * 4) };
    placed.forEach((p, k) => {
      const r = packed.placed[k];
      blitRGBA(atlas, { x: r.x, y: r.y }, p.frame);
      // The shipped rect must hold exactly the ink placeFrame measured: any
      // lost column or row here is a body cut back into the atlas.
      const bb = bboxOf(cropRGBA(atlas, r.x, r.y, r.w, r.h));
      if (!bb || bb.minX !== 0 || bb.minY !== 0 || bb.w !== r.w || bb.h !== r.h) {
        qa.push({ sheet: sheetId, cell: p.i, problem: 'frame-ink-lost', want: { w: r.w, h: r.h }, got: bb });
      }
      frames[p.i] = { x: r.x, y: r.y, w: r.w, h: r.h, ox: p.frame.ox, oy: p.frame.oy };
      stats[p.i] = frameStats(p.frame, p.frame.oy);
    });
    sheets[sheetId] = { atlas, frames, stats, scale: sheetScale };
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
    sheetRefs[sheetId] = {
      atlas: url, width: atlas.width, height: atlas.height,
      bytes: pair.webpBytes || pair.pngBytes,
      // The standing-pose evidence travels with the atlas so a checker can
      // assert the size contract without re-measuring a single pixel.
      standing: standing[sheetId] || null,
    };
    atlasBytes += pair.webpBytes || pair.pngBytes;
  }

  const clips = {};
  for (const sheetId of SHEET_IDS) {
    for (const [clipId, spec] of Object.entries(SHEETS[sheetId].clips)) {
      const picked = spec.cells.map((c) => sheets[sheetId].frames[c]);
      // A repaired drawing repeats the closest real one instead of dropping
      // out of the list: the phase maps index into this frame list, so
      // removing a frame would silently shift every later phase.
      for (let i = 0; i < picked.length; i += 1) {
        if (picked[i]) continue;
        picked[i] = picked.slice(0, i).reverse().find(Boolean)
          || picked.slice(i + 1).find(Boolean) || null;
      }
      clips[clipId] = {
        sheet: sheetId,
        frames: picked.filter(Boolean),
        loop: Boolean(spec.loop),
        fps: spec.fps || 0,
        phases: spec.phases || null,
      };
      qa.push(...auditClip(sheetId, clipId, spec.cells, sheets[sheetId].stats));
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
    atlasBytes, animBytes: animBuf.length, qa, repairs, defects,
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
    const src = readPNG(path.resolve(probe));
    const backdrop = detectBackdrop(src, { cell: CELL });
    console.log(`[probe] backdrop: kind=${backdrop.kind} rgb=(${backdrop.rgb.join(',')})`
      + ` flat=${backdrop.flat.toFixed(1)} chokeTol=${backdrop.kind === 'white' ? 'n/a' : CHOKE_TOL}`);
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
        + (problems ? ' ' + JSON.stringify(entry.qa.slice(0, 4)) : '')
        + (entry.repairs.length ? ` repaired=${JSON.stringify(entry.repairs)}` : '')
        + (entry.defects.length ? ` off-model=${JSON.stringify(entry.defects)}` : ''));
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
  bodyExtent, cropRGBA, labelComponents, doubledBodies, splitCrossRowComponents,
  median, stanceReference, stanceWidth, sheetCorrection, standingCorrection,
  placeFrame, bakeFighter,
  frameStats, auditClip, BODY_COMPONENT_MIN,
};

// Importable so the bake can be audited frame by frame; the CLI only runs when
// this file is executed directly.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
