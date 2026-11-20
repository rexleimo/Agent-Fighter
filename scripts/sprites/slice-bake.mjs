// Sprite slicing — QA stats and the per-fighter bake.
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
import { SOURCE, VDIR } from './slice-shared.mjs';
import { bboxOf, median, stanceReference, stanceArea, stanceWidth } from './slice-pockets.mjs';
import { standingCorrection, BODY_COMPONENT_MIN, cellScale, sheetCorrection, placeFrame } from './slice-placement.mjs';
import { artRows, doubledBodies, sliceSheet } from './slice-audit.mjs';

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

export { frameStats, auditClip, bakeFighter };
