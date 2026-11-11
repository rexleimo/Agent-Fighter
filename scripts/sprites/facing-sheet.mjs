/**
 * Facing review sheet — the instrument behind the FACING ledger.
 *
 * The generator was told to draw every frame facing LEFT and disobeyed sheet by
 * sheet and sometimes frame by frame, so the bake mirrors what came back the
 * other way. That makes one judgement per sheet (plus per-cell overrides)
 * load-bearing, and a wrong one renders a fighter backwards to his own
 * opponent. Automated cues cannot be trusted here: mass skew, limb reach, skin
 * lean, foot pressure and silhouette mirror-matching all scored under 70%
 * against a full-resolution human read, because a cape, an all-warm body, a
 * faceless helmet and a twisted leg answer "pose" instead of "orientation".
 *
 * So a person reads the drawings. This script produces what that person looks
 * at: one image per sheet, a row per fighter, a column per clip, and each tile
 * rendered in the ORIENTATION THE GAME ACTUALLY SHIPS (the ledger's flip
 * applied). Reviewing the shipped result is a weaker question than classifying
 * raw art — you are no longer deciding which way a drawing faces, you are
 * spotting the frame that shows a back.
 *
 * Rows are fighters in the order printed on stdout; columns are the clips in
 * declaration order. Every tile in a row has to face left; a tile that faces
 * right is a frame the ledger does not cover.
 *
 * Usage: node scripts/sprites/facing-sheet.mjs [--out DIR] [--sheet base]
 *                                               [--fighters ember,volt]
 *        node scripts/sprites/facing-sheet.mjs --full --fighters abyss --sheet base
 *              full-resolution strips of one raw sheet, for the read that
 *              decides a ledger entry; prints the sha to paste into FACING.
 */
import fs from 'node:fs';
import path from 'node:path';
import { FIGHTERS } from '../../src/fighters.js';
import { cropRGBA, blitRGBA, resizeRGBA, writePNG, hashFile, shortHash } from '../lib/imageops.mjs';
import { sliceSheet } from './slice.mjs';
import { SHEETS, SHEET_IDS, GRID, ART_ROW_ORDER, FACING, facingReview, shipsFlipped } from './sheets.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SOURCE = path.join(ROOT, 'assets', 'source', 'sprites');
const TILE = 208;
const GAP = 4;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Nearest-free bilinear fit that, unlike resizeRGBA, may also enlarge. */
function fit(img, box) {
  const s = Math.min(box / img.width, box / img.height);
  const dw = Math.max(1, Math.round(img.width * s));
  const dh = Math.max(1, Math.round(img.height * s));
  if (s < 1) return resizeRGBA(img, dw, dh);
  if (dw === img.width && dh === img.height) return img;
  const out = Buffer.alloc(dw * dh * 4);
  const sx = img.width / dw;
  const sy = img.height / dh;
  for (let y = 0; y < dh; y += 1) {
    const gy = Math.min(img.height - 1, y * sy);
    const y0 = Math.floor(gy);
    const y1 = Math.min(img.height - 1, y0 + 1);
    const fy = gy - y0;
    for (let x = 0; x < dw; x += 1) {
      const gx = Math.min(img.width - 1, x * sx);
      const x0 = Math.floor(gx);
      const x1 = Math.min(img.width - 1, x0 + 1);
      const fx = gx - x0;
      const o = (y * dw + x) * 4;
      for (let c = 0; c < 4; c += 1) {
        const p = (a, b) => img.rgba[((a * img.width) + b) * 4 + c];
        const top = p(y0, x0) * (1 - fx) + p(y0, x1) * fx;
        const bot = p(y1, x0) * (1 - fx) + p(y1, x1) * fx;
        out[o + c] = Math.round(top * (1 - fy) + bot * fy);
      }
    }
  }
  return { width: dw, height: dh, rgba: out };
}

function mirrorX(img) {
  const out = { width: img.width, height: img.height, rgba: Buffer.alloc(img.rgba.length) };
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      const s = (y * img.width + x) * 4;
      const d = (y * img.width + (img.width - 1 - x)) * 4;
      out.rgba[d] = img.rgba[s];
      out.rgba[d + 1] = img.rgba[s + 1];
      out.rgba[d + 2] = img.rgba[s + 2];
      out.rgba[d + 3] = img.rgba[s + 3];
    }
  }
  return out;
}

function tileFor(cell, flip, size = TILE) {
  const tile = { width: size, height: size, rgba: Buffer.alloc(size * size * 4) };
  // Dark backing: the sprites are matted off white, so they are invisible on
  // the transparent canvas a browser would composite against white.
  for (let i = 0; i < tile.rgba.length; i += 4) {
    tile.rgba[i] = 26; tile.rgba[i + 1] = 28; tile.rgba[i + 2] = 34; tile.rgba[i + 3] = 255;
  }
  if (cell && cell.bbox) {
    let crop = cropRGBA(cell.matted, cell.bbox.minX, cell.bbox.minY, cell.bbox.w, cell.bbox.h);
    if (flip) crop = mirrorX(crop);
    const src = fit(crop, size - GAP);
    blitRGBA(tile, { x: Math.round((size - src.width) / 2), y: Math.round((size - src.height) / 2) }, src);
  }
  return tile;
}

/**
 * Full-resolution review strips for one sheet: every cell of one grid row at
 * native size, never mirrored. The survey page above answers "does the game
 * ship this frame the right way"; this answers the harder question the ledger
 * entry is built from — "which way is this drawing actually facing". A viewer
 * sees 384px per figure here against ~190px inside a shrunken 1024px sheet,
 * which is the difference between reading a visor and guessing at a blob.
 */
function fullStrips(id, sheetId, outDir, size) {
  const file = path.join(SOURCE, id, sheetId + '.png');
  const cells = sliceSheet(file, { rowOrder: (ART_ROW_ORDER[id] || {})[sheetId] || null });
  const rows = Math.max(1, Math.ceil(cells.length / GRID));
  const out = [];
  for (let r = 0; r < rows; r += 1) {
    const row = cells.slice(r * GRID, r * GRID + GRID);
    const width = row.length * size, height = size;
    const band = { width, height, rgba: Buffer.alloc(width * height * 4) };
    row.forEach((cell, c) => blitRGBA(band, { x: c * size, y: 0 }, tileFor(cell, false, size)));
    const strip = `${outDir}/full-${id}-${sheetId}-r${r}.png`;
    writePNG(strip, width, height, band.rgba);
    out.push({ strip, width, height, cells: row.map((cell) => cell.index).join(',') });
  }
  return { sha: shortHash(hashFile(file)), rows: out };
}

function build(sheetId, ids, outDir, chunk) {
  const clips = Object.entries(SHEETS[sheetId].clips);
  const cols = clips.map(([, c]) => c.cells[Math.floor((c.cells.length - 1) / 2)]);
  const width = cols.length * TILE + (cols.length + 1) * GAP;
  const pages = [];
  for (let start = 0; start < ids.length; start += chunk) {
    const rows = ids.slice(start, start + chunk);
    const height = rows.length * TILE + (rows.length + 1) * GAP;
    const canvas = { width, height, rgba: Buffer.alloc(width * height * 4) };
    for (let i = 0; i < canvas.rgba.length; i += 4) canvas.rgba[i + 3] = 255;
    rows.forEach((id, r) => {
      const file = path.join(SOURCE, id, sheetId + '.png');
      const cells = sliceSheet(file, { rowOrder: (ART_ROW_ORDER[id] || {})[sheetId] || null });
      const review = FACING[id + '/' + sheetId];
      cols.forEach((ci, c) => {
        blitRGBA(canvas, {
          x: GAP + c * (TILE + GAP),
          y: GAP + r * (TILE + GAP),
        }, tileFor(cells[ci], review ? shipsFlipped(review, ci) : false));
      });
    });
    const file = path.join(outDir, 'facing-' + sheetId + '-' + rows[0] + '_' + rows[rows.length - 1] + '.png');
    writePNG(file, width, height, canvas.rgba);
    pages.push({
      file, width, height, rows,
      clips: clips.map(([clipId], i) => clipId + '@cell' + cols[i]),
      // Anything the reviewer should know before trusting this page: a sheet
      // whose file changed since it was read, or whose shipped frames disagree
      // with the sheet-level flip.
      notes: rows.flatMap((id) => {
        const review = FACING[id + '/' + sheetId];
        if (!review) return [`${id}: no ledger entry`];
        const here = path.join(SOURCE, id, sheetId + '.png');
        const out = [];
        if (shortHash(hashFile(here)) !== review.sha) {
          out.push(`${id}: sheet changed since it was read (${review.sha} -> ${shortHash(hashFile(here))})`);
        }
        const overridden = cols.filter((ci) => shipsFlipped(review, ci) !== (review.faces > 0));
        if (overridden.length) out.push(`${id}: per-cell flip on ${overridden.join(',')}`);
        return out;
      }),
    });
  }
  return pages;
}

function main() {
  const outDir = path.resolve(arg('--out', '/tmp/af-facing'));
  fs.mkdirSync(outDir, { recursive: true });
  const wanted = arg('--sheet', '').split(',').map((s) => s.trim()).filter(Boolean);
  const sheetIds = wanted.length ? wanted.filter((s) => SHEET_IDS.includes(s)) : SHEET_IDS;
  const only = arg('--fighters', '').split(',').map((s) => s.trim()).filter(Boolean);
  const chunk = Number(arg('--chunk', '8'));
  const ids = (only.length ? FIGHTERS.filter((f) => only.includes(f.id)) : FIGHTERS)
    .map((f) => f.id).sort();

  if (process.argv.includes('--full')) {
    if (!only.length || !wanted.length) {
      throw new Error('--full reviews one sheet of one fighter: --full --fighters abyss --sheet base');
    }
    const size = Number(arg('--size', '384'));
    for (const id of ids) {
      for (const sheetId of sheetIds) {
        const { sha, rows } = fullStrips(id, sheetId, outDir, size);
        console.log(`${id}/${sheetId} sha=${sha}  <- paste into FACING as sha`);
        for (const r of rows) console.log(`    ${r.strip} ${r.width}x${r.height} cells=${r.cells}`);
      }
    }
    return;
  }

  console.log('fighter order: ' + ids.join(' | '));
  for (const sheetId of sheetIds) {
    for (const r of build(sheetId, ids, outDir, chunk)) {
      console.log(`${r.file} ${r.width}x${r.height} rows=${r.rows.join(',')} cols=${r.clips.join(' ')}`);
      for (const note of r.notes) console.log('    ' + note);
    }
  }
}

main();
