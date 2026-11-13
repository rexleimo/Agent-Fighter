/**
 * Cell-level sprite sheet redraw.
 *
 * A whole 4x4 sheet is the unit the generator and the slicer speak, but a
 * single bad frame is not a reason to re-roll the other fifteen: every
 * redrawn sheet invalidates its FACING ledger entry, and a fresh drawing can
 * come back with new defects in cells that were already reviewed twice.
 *
 * So this replaces the cells you name. `--cells 12` replaces one frame;
 * `--row 3` is the shorthand for that row's four cells. Everything you did not
 * name stays byte-identical, which keeps their recorded flips valid and limits
 * the fresh read to the frames that actually changed.
 *
 * Each replacement is scaled and placed to match the cell it replaces: the bake
 * applies one scale per fighter across the sheet, so a frame drawn 15% larger
 * would make the fighter grow mid-clip.
 *
 * The generation is cached outside the repository and `--from` splices an
 * existing file without calling the API again - a rejected drawing must never
 * cost a second payment.
 *
 * Usage:
 *   node scripts/sprites/redraw-row.mjs --fighter ember --sheet kick --row 3
 *   node scripts/sprites/redraw-row.mjs --fighter ember --sheet kick --cells 5,6,9,10
 *   node scripts/sprites/redraw-row.mjs --fighter ember --sheet kick --cells 12 --from /tmp/....png
 *   Add --write to replace the source sheet; without it the tool only reports.
 *   Add --out FILE to write the spliced sheet somewhere else and leave the
 *   source alone - that is how a splice gets checked before it is trusted.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  readPNG, cropRGBA, blitRGBA, writePNG, resizeRGBA, hashFile, shortHash,
} from '../lib/imageops.mjs';
import { generateImage } from './rexai.mjs';
import { promptFor, GRID, FACING } from './sheets.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
// AFL_SPRITE_SOURCE lets the gate exercise --write against a throwaway copy of
// the sheets. Without it the write path could only be tested by mutating real
// source art, which is how it shipped a broken reference for a whole round.
const SOURCE = process.env.AFL_SPRITE_SOURCE || path.join(ROOT, 'assets', 'source', 'sprites');
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
const row = arg('row');
const model = arg('model', 'gpt-image-2-5-sunburst');
const doWrite = process.argv.includes('--write');
if (!fighter || !sheet || (!row && !arg('cells'))) {
  throw new Error('usage: --fighter ID --sheet ID (--row N | --cells 5,6,9,10) [--from FILE] [--write]');
}
if (row !== null && (Number.isNaN(Number(row)) || Number(row) < 0 || Number(row) >= GRID)) {
  throw new Error('row must be 0..3');
}

const sheetFile = path.join(SOURCE, fighter, sheet + '.png');
if (!fs.existsSync(sheetFile)) throw new Error('no source sheet: ' + sheetFile);
const outFile = arg('out');
if (outFile && doWrite) throw new Error('--out and --write are mutually exclusive: --out already writes a file');

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

// --row N replaces a whole row; --cells 5,6,9,10 replaces named cells and leaves
// their clip-mates byte-identical. A cell is the smaller claim, so it is the
// default shape of a fix: the frames that were already read twice stay valid.
const cellArg = arg('cells');
const cells = (cellArg ? cellArg.split(',') : Array.from({ length: GRID }, (_, i) => i + Number(row) * GRID))
  .map((s) => Number(String(s).trim()))
  .filter((n) => Number.isInteger(n));
if (!cells.length) throw new Error('--cells needs indexes 0..15, or pass --row N');
for (const c of cells) if (c < 0 || c >= GRID * GRID) throw new Error('cell index out of range: ' + c);

const cellOf = (img, c) => cropRGBA(img, (c % GRID) * cellW, Math.floor(c / GRID) * cellH, cellW, cellH);

fs.mkdirSync(CACHE, { recursive: true });
let generated = arg('from');
if (!generated) {
  const outFile = path.join(CACHE, `${fighter}-${sheet}-${Date.now()}.png`);
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
const report = [];
cells.forEach((c) => {
  const oldCell = cellOf(old, c);
  const oldBox = inkBox(oldCell);
  if (!oldBox) throw new Error(`existing cell ${c} has no ink to match`);
  const newCell = cellOf(fresh, c);
  const newBox = inkBox(newCell);
  if (!newBox) throw new Error(`generated cell ${c} has no ink — wrong row/column in the new drawing`);
  // Match the replaced frame's own ink height: the bake applies one scale per
  // fighter, so a taller or shorter replacement makes the body pop mid-clip.
  const factor = Math.min(1.4, Math.max(0.7, oldBox.h / newBox.h));
  const scaled = scaleCell(newCell, newBox, factor);
  const box = inkBox(scaled.img);
  const placed = place(scaled.img, box, cellW, cellH, oldBox.x + oldBox.w / 2, oldBox.y + oldBox.h);
  blitRGBA(old, { x: (c % GRID) * cellW, y: Math.floor(c / GRID) * cellH, w: cellW, h: cellH }, placed);
  report.push(`cell ${c}: ink ${oldBox.h}px -> ${box ? box.h : 0}px (scale ${factor.toFixed(3)})`);
});

const cellKey = cells.slice().sort((a, b) => a - b).join('-');
const preview = path.join(CACHE, `${fighter}-${sheet}-${cellKey}-spliced.png`);
writePNG(preview, old.width, old.height, old.rgba);
console.log(`[redraw-row] cells ${cells.join(',')} of ${fighter}/${sheet}`);
console.log(`[redraw-row] preview ${preview}`);
for (const line of report) console.log('  ' + line);

// A cell listed in FACING.flip is an instruction to mirror that frame at bake
// time. Replacing it means the override now applies to a drawing nobody has
// read, so the entry can no longer be trusted for that cell - and a stale flip
// turns a correct frame around. Name the cells that need a fresh read.
const entry = FACING[`${fighter}/${sheet}`];
if (entry) {
  const touchedFlips = cells.filter((c) => entry.flip.includes(c));
  const untouched = GRID * GRID - cells.length;
  console.log(`[redraw-row] ${untouched} cell(s) left byte-identical: their ledger entries stay valid as read.`);
  if (touchedFlips.length) {
    console.log(`[redraw-row] WARN replaced flipped cell(s) ${touchedFlips.join(',')} - FACING['${fighter}/${sheet}'].flip now describes drawings that were never reviewed. Read them before baking.`);
  } else if (entry.flip.length) {
    console.log(`[redraw-row] ledger flips ${entry.flip.join(',')} were not touched, so they still describe the shipped drawings.`);
  }
} else {
  console.log(`[redraw-row] WARN no FACING entry for ${fighter}/${sheet}; the bake will treat this sheet as unread.`);
}

console.log(`[redraw-row] new sheet sha would be ${shortHash(hashFile(preview))} (current ${shortHash(hashFile(sheetFile))})`);
if (outFile) {
  const abs = path.resolve(outFile);
  writePNG(abs, old.width, old.height, old.rgba);
  console.log(`[redraw-row] wrote ${abs} (source sheet untouched) sha=${shortHash(hashFile(abs))}`);
  process.exit(0);
}
if (!doWrite) {
  console.log('[redraw-row] dry run: source sheet untouched. Re-run with --write to replace it, or --out FILE to write elsewhere.');
  process.exit(0);
}
const backup = path.join(CACHE, `${fighter}-${sheet}-before-${Date.now()}.png`);
fs.copyFileSync(sheetFile, backup);
// The splice mutated `old` in place; `old.rgba` IS the new sheet. (This path
// used to name a `spliced` buffer that the cell refactor removed, so --write
// threw ReferenceError while the dry run kept working - a broken write path is
// invisible until the one run that matters.)
writePNG(sheetFile, old.width, old.height, old.rgba);
console.log(`[redraw-row] wrote ${sheetFile} (original backed up to ${backup})`);
console.log(`[redraw-row] paste this sha into FACING['${fighter}/${sheet}']: ${shortHash(hashFile(sheetFile))}`);
