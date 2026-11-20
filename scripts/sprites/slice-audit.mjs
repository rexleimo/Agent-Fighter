// Sprite slicing — component labelling, cross-row splits and sheet slicing.
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
import { SHEET_PX, CELL, matteCell, stripSealFade, stripGroundShadows } from './slice-shared.mjs';
import { dropBackgroundPockets, bodyExtent } from './slice-pockets.mjs';

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

export { labelComponents, artRows, doubledBodies, splitCrossRowComponents, sliceSheet };
