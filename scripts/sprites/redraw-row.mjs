/**
 * Row-level sprite sheet redraw.
 *
 * A whole 4x4 sheet is the unit the generator and the slicer speak, but a
 * single bad row is not a reason to re-roll the other twelve cells: every
 * redrawn sheet invalidates its FACING ledger entry, and a fresh drawing can
 * come back with new defects in cells that were already reviewed twice.
 *
 * So this replaces ONE row. The other cells stay byte-identical, which keeps
 * their recorded flips valid, and only the new row needs a fresh read.
 *
 * The new row is scaled and placed to match the row it replaces: the bake
 * applies one scale per fighter across the sheet, so a row drawn 15% larger
 * would make the fighter grow mid-move.
 *
 * The generation is cached outside the repository and `--from` splices an
 * existing file without calling the API again — a rejected drawing must never
 * cost a second payment.
 *
 * Usage:
 *   node scripts/sprites/redraw-row.mjs --fighter ember --sheet kick --row 3
 *   node scripts/sprites/redraw-row.mjs --fighter ember --sheet kick --row 3 --from /tmp/....png
 *   Add --write to replace the source sheet; without it the tool only reports.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  readPNG, cropRGBA, blitRGBA, writePNG, resizeRGBA, hashFile, shortHash,
} from '../lib/imageops.mjs';
import { generateImage } from './rexai.mjs';
import { promptFor, GRID } from './sheets.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SOURCE = path.join(ROOT, 'assets', 'source', 'sprites');
const PLATES = path.join(ROOT, 'assets', 'source', 'plates', 'fighters');
const CACHE = '/tmp/af-redraw';
const WHITE = { r: 250, g: 250, b: 250 };

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  const next = i >= 0 ? process.argv[i + 1] : undefined;
  return next && !next.startsWith('--') ? next : fallback;
}

const fighter = arg('fighter');
const sheet = arg('sheet');
const row = Number(arg('row'));
const model = arg('model', 'gpt-image-2-5-sunburst');
const doWrite = process.argv.includes('--write');
if (!fighter || !sheet || !Number.isInteger(row)) throw new Error('usage: --fighter ID --sheet ID --row N [--from FILE] [--write]');
if (row < 0 || row >= GRID) throw new Error('row must be 0..3');

const sheetFile = path.join(SOURCE, fighter, sheet + '.png');
if (!fs.existsSync(sheetFile)) throw new Error('no source sheet: ' + sheetFile);

/** Ink bounding box of a cell: anything that is not the sheet's white backdrop. */
function inkBox(img) {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      const i = (y * img.width + x) * 4;
      const a = img.rgba[i + 3];
      if (a < 40) continue;
      const nearWhite = WHITE.r - img.rgba[i] < 14 && WHITE.g - img.rgba[i + 1] < 14 && WHITE.b - img.rgba[i + 2] < 14;
      if (nearWhite) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** The matte keys on near-white RGB, so padding must be white, not transparent black. */
function whiteCell(w, h) {
  const out = { width: w, height: h, rgba: Buffer.alloc(w * h * 4) };
  for (let i = 0; i < out.rgba.length; i += 4) {
    out.rgba[i] = 255; out.rgba[i + 1] = 255; out.rgba[i + 2] = 255; out.rgba[i + 3] = 255;
  }
  return out;
}

/** Nearest-neighbour resize that may also enlarge, unlike resizeRGBA. */
function nnResize(img, dw, dh) {
  const out = { width: dw, height: dh, rgba: Buffer.alloc(dw * dh * 4) };
  for (let y = 0; y < dh; y += 1) {
    for (let x = 0; x < dw; x += 1) {
      const si = (Math.min(img.height - 1, Math.floor((y * img.height) / dh)) * img.width
        + Math.min(img.width - 1, Math.floor((x * img.width) / dw))) * 4;
      const di = (y * dw + x) * 4;
      for (let k = 0; k < 4; k += 1) out.rgba[di + k] = img.rgba[si + k];
    }
  }
  return out;
}

/** White cell of the target size with `ink` placed by bottom-centre at (cx, by). */
function place(ink, box, w, h, cx, by) {
  const out = whiteCell(w, h);
  if (!box) return out;
  const crop = cropRGBA(ink, box.x, box.y, box.w, box.h);
  blitRGBA(out, { x: Math.round(cx - crop.width / 2), y: Math.round(by - crop.height), w: crop.width, h: crop.height }, crop);
  return out;
}

function scaleCell(cell, box, factor) {
  if (!box) return { img: cell, box };
  const dw = Math.max(1, Math.round(box.w * factor));
  const dh = Math.max(1, Math.round(box.h * factor));
  const ink = cropRGBA(cell, box.x, box.y, box.w, box.h);
  const scaled = dw > ink.width || dh > ink.height ? nnResize(ink, dw, dh) : resizeRGBA(ink, dw, dh);
  const out = whiteCell(cell.width, cell.height);
  blitRGBA(out, { x: Math.round(box.x + box.w / 2 - dw / 2), y: Math.round(box.y + box.h - dh), w: dw, h: dh }, scaled);
  return { img: out, box: { x: Math.round(box.x + box.w / 2 - dw / 2), y: Math.round(box.y + box.h - dh), w: dw, h: dh } };
}

const old = readPNG(sheetFile);
const cellW = Math.floor(old.width / GRID);
const cellH = Math.floor(old.height / GRID);
const oldCells = [];
for (let c = 0; c < GRID; c += 1) {
  const cell = cropRGBA(old, c * cellW, row * cellH, cellW, cellH);
  oldCells.push({ cell, box: inkBox(cell) });
}
const oldHeights = oldCells.map((o) => (o.box ? o.box.h : 0)).filter(Boolean);
if (!oldHeights.length) throw new Error('existing row ' + row + ' has no ink to match');
const refHeight = Math.round(oldHeights.reduce((a, b) => a + b, 0) / oldHeights.length);

fs.mkdirSync(CACHE, { recursive: true });
let generated = arg('from');
if (!generated) {
  const outFile = path.join(CACHE, `${fighter}-${sheet}-row${row}-${Date.now()}.png`);
  console.log(`[redraw-row] generating ${fighter}/${sheet} with ${model} (one paid call)`);
  const { jobId, buffer } = await generateImage({
    model,
    prompt: promptFor(sheet, fighter),
    image: path.join(PLATES, fighter + '.png'),
    size: '1024x1024',
    timeoutMs: 540000,
    onPoll: (status, sec) => console.log(`[redraw-row] ${status} ${sec}s`),
  });
  fs.writeFileSync(outFile, buffer);
  console.log(`[redraw-row] job=${jobId} saved ${outFile} — splice with --from ${outFile}`);
  generated = outFile;
}

const fresh = readPNG(generated);
const newCells = [];
for (let c = 0; c < GRID; c += 1) {
  const cell = cropRGBA(fresh, c * cellW, row * cellH, cellW, cellH);
  const box = inkBox(cell);
  const factor = box ? Math.min(1.4, Math.max(0.7, refHeight / box.h)) : 1;
  newCells.push(scaleCell(cell, box, factor));
}

const rowBand = whiteCell(old.width, cellH);
newCells.forEach((n, c) => {
  // Both boxes are cell-local: the old row is what the placement must match.
  const oldBox = oldCells[c].box;
  const cx = oldBox ? oldBox.x + oldBox.w / 2 : cellW / 2;
  const by = oldBox ? oldBox.y + oldBox.h : cellH;
  const placed = place(n.img, inkBox(n.img), cellW, cellH, cx, by);
  blitRGBA(rowBand, { x: c * cellW, y: 0, w: placed.width, h: placed.height }, placed);
});

const spliced = { width: old.width, height: old.height, rgba: Buffer.alloc(old.width * old.height * 4) };
for (let y = 0; y < old.height; y += 1) {
  const src = y >= row * cellH && y < (row + 1) * cellH ? rowBand : old;
  const sy = y >= row * cellH && y < (row + 1) * cellH ? y - row * cellH : y;
  src.rgba.copy(spliced.rgba, y * old.width * 4, sy * src.width * 4, sy * src.width * 4 + src.width * 4);
}

const preview = path.join(CACHE, `${fighter}-${sheet}-row${row}-spliced.png`);
writePNG(preview, spliced.width, spliced.height, spliced.rgba);
console.log(`[redraw-row] preview ${preview}`);
console.log(`[redraw-row] row ${row} ink heights: was ${oldHeights.join('/')} now ${newCells.map((n) => (n.box ? n.box.h : 0)).join('/')}`);
console.log(`[redraw-row] new sheet sha would be ${shortHash(hashFile(preview))} (current ${shortHash(hashFile(sheetFile))})`);
if (!doWrite) {
  console.log('[redraw-row] dry run: source sheet untouched. Re-run with --write to replace it.');
  process.exit(0);
}
const backup = path.join(CACHE, `${fighter}-${sheet}-before-${Date.now()}.png`);
fs.copyFileSync(sheetFile, backup);
writePNG(sheetFile, spliced.width, spliced.height, spliced.rgba);
console.log(`[redraw-row] wrote ${sheetFile} (original backed up to ${backup})`);
console.log(`[redraw-row] paste this sha into FACING['${fighter}/${sheet}']: ${shortHash(hashFile(sheetFile))}`);
