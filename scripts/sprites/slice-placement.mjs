// Sprite slicing — stance correction and frame placement.
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
import { bboxOf, feetCenterX, resizeBilinear, median } from './slice-pockets.mjs';

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

export { standingCells, standingCorrection, cellScale, sheetCorrection, mirrorX, placeFrame, BODY_COMPONENT_MIN };
