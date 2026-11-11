/**
 * Facing ledger gate — the FACING table is load-bearing, so check it here
 * rather than by baking sixteen fighters.
 *
 * One judgement per sheet (plus per-cell overrides) decides whether the bake
 * mirrors a frame. Get a sheet wrong and all sixteen of its frames show the
 * character's back; get an override wrong and one good frame turns around. The
 * bake already refuses an unadjudicated sheet and flags a sheet whose file
 * changed since it was read, but it can only say that while writing atlases.
 * This script answers the same questions in a second, and adds the two the
 * bake cannot see: the ledger's own shape, and the shipped-orientation rule
 * itself, so a sign error in shipsFlipped cannot survive an edit.
 *
 * Usage: node scripts/verify-facing.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { FIGHTERS } from '../src/fighters.js';
import { hashFile, shortHash } from './lib/imageops.mjs';
import {
  CELL_COUNT, SHEET_IDS, FACING, facingReview, shipsFlipped,
} from './sprites/sheets.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE = path.join(ROOT, 'assets', 'source', 'sprites');

const failures = [];
const ok = (label, cond, detail = '') => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  ' + detail : ''));
  if (!cond) failures.push(label);
};

// 1. The rule the whole table exists to serve. Art is canonically left-facing,
//    so only right-facing frames may be mirrored, and never the other way.
const art = (faces, flipped) => (flipped ? -faces : faces);
const truth = [[1, false], [1, true], [-1, false], [-1, true]]
  .map(([faces, flipped]) => ({ faces, flipped, ships: shipsFlipped({ faces, flip: flipped ? [0] : [] }, 0) }));
ok('left-facing art ships un-mirrored, right-facing art ships mirrored',
  truth.every((c) => c.ships === (art(c.faces, c.flipped) > 0)),
  truth.map((c) => `${c.faces > 0 ? 'R' : 'L'}${c.flipped ? '*' : ''}->${c.ships ? 'mirror' : 'plain'}`).join(' '));

// 2. Coverage: every sheet of every fighter was read.
const keys = FIGHTERS.map((f) => f.id).sort()
  .flatMap((id) => SHEET_IDS.map((sheetId) => id + '/' + sheetId));
const absent = keys.filter((key) => !FACING[key]);
ok(`every sheet adjudicated (${keys.length} sheets)`, absent.length === 0, absent.slice(0, 6).join(' '));
const unlisted = Object.keys(FACING).filter((key) => !keys.includes(key));
ok('no ledger entry without a sheet behind it', unlisted.length === 0, unlisted.join(' '));

// 3. Shape: a value that is not exactly one of the two orientations, or a cell
//    index outside the grid, silently means "mirror nothing" or "mirror the
//    wrong cell" instead of failing.
const badFaces = keys.filter((key) => FACING[key] && FACING[key].faces !== 1 && FACING[key].faces !== -1);
ok('faces is +1 or -1', badFaces.length === 0, badFaces.join(' '));
const badCells = keys.filter((key) => {
  const e = FACING[key];
  if (!e) return false;
  const seen = new Set(e.flip);
  return e.flip.length !== seen.size
    || e.flip.some((c) => !Number.isInteger(c) || c < 0 || c >= CELL_COUNT);
});
ok(`flip cells are ${CELL_COUNT} unique in-range indexes`, badCells.length === 0, badCells.join(' '));
const badSha = keys.filter((key) => FACING[key] && !/^[0-9a-f]{12}$/.test(FACING[key].sha));
ok('every entry carries the sha it was read against', badSha.length === 0, badSha.join(' '));

// 4. Freshness: the same test the bake runs, without baking. A regenerated
//    sheet is a different drawing, and the entry describing the old one is
//    then a guess.
const stale = keys.filter((key) => {
  const e = FACING[key];
  if (!e) return false;
  const [id, sheetId] = key.split('/');
  const file = path.join(SOURCE, id, sheetId + '.png');
  return fs.existsSync(file) && shortHash(hashFile(file)) !== e.sha;
});
ok('every entry was read against the sheet on disk', stale.length === 0, stale.slice(0, 8).join(' '));

// 5. Overrides are supposed to be the exception. A sheet whose "opposite" cells
//    are half the grid is a sheet whose dominant was recorded backwards.
const flip = keys.filter((key) => FACING[key] && FACING[key].flip.length > 0);
const heavy = flip.filter((key) => FACING[key].flip.length * 2 >= CELL_COUNT);
ok('no sheet overrides half or more of its frames', heavy.length === 0,
  `${flip.length}/${keys.length} sheets carry overrides; ` + heavy.join(' '));
console.log(`  note    overridden cells: ${flip.reduce((n, key) => n + FACING[key].flip.length, 0)}`
  + ` across ${flip.length} sheets; review instrument: node scripts/sprites/facing-sheet.mjs --full`
  + ' --fighters <id> --sheet <s>');

// 6. facingReview must stay the only door: a typo'd sheet id has to throw.
let threw = false;
try { facingReview('abyss', 'nope'); } catch { threw = true; }
ok('an unadjudicated sheet cannot be baked', threw);

process.exitCode = failures.length ? 1 : 0;
console.log(failures.length ? `facing ledger: ${failures.length} failure(s)` : 'facing ledger: clean');
