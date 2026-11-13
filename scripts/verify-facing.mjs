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
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { FIGHTERS } from '../src/fighters.js';
import { hashFile, shortHash, readPNG, cropRGBA } from './lib/imageops.mjs';
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

// 7. The cell-level redraw tool. It exists so a single bad frame can be
//    replaced without re-rolling the sheet, and its entire promise is that the
//    cells you did not name stay byte-identical - that is what keeps the rest
//    of the ledger valid. That promise, and the --write path itself, were
//    unverified: --write referenced a variable the cell refactor deleted, so
//    every dry run succeeded while every real write threw ReferenceError.
//    Run it against a throwaway copy so no source art and no paid call is used.
{
  const id = 'ember';
  const sheetId = 'kick';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'afl-redraw-'));
  const fakeSource = path.join(tmp, 'sprites');
  fs.mkdirSync(path.join(fakeSource, id), { recursive: true });
  for (const s of SHEET_IDS) {
    const f = path.join(SOURCE, id, s + '.png');
    if (fs.existsSync(f)) fs.copyFileSync(f, path.join(fakeSource, id, s + '.png'));
  }
  const target = path.join(fakeSource, id, sheetId + '.png');
  const before = readPNG(target);
  const env = { ...process.env, AFL_SPRITE_SOURCE: fakeSource };
  const cw = Math.floor(before.width / 4);
  const ch = Math.floor(before.height / 4);
  const cellBytes = (file, c) => {
    const img = readPNG(file);
    return cropRGBA(img, (c % 4) * cw, Math.floor(c / 4) * ch, cw, ch).rgba;
  };
  // A different sheet of the same fighter stands in for a fresh drawing.
  const standIn = path.join(fakeSource, id, 'base.png');
  const named = [5, 12];
  const out = path.join(tmp, 'spliced.png');
  const run = (args) => execFileSync(process.execPath,
    [path.join(ROOT, 'scripts', 'sprites', 'redraw-row.mjs'), ...args],
    { encoding: 'utf8', env });

  let spliceLog = '';
  let splicedOk = true;
  try {
    spliceLog = run(['--fighter', id, '--sheet', sheetId, '--cells', named.join(','),
      '--from', standIn, '--out', out]);
  } catch (e) { splicedOk = false; spliceLog = String(e.stderr || e.message); }
  ok('逐格重绘能跑通（不付费、不碰源图）', splicedOk && fs.existsSync(out), spliceLog.split('\n').find((l) => /Error/i.test(l)) || '');

  if (splicedOk && fs.existsSync(out)) {
    const changed = [];
    const kept = [];
    for (let c = 0; c < 16; c += 1) {
      (cellBytes(target, c).equals(cellBytes(out, c)) ? kept : changed).push(c);
    }
    ok('只有点名的格被替换', changed.length === named.length && named.every((c) => changed.includes(c)),
      `点名 ${named.join(',')} / 实际改变 ${changed.join(',') || '无'}`);
    ok('其余格逐字节不变（所以它们的台账条目仍然有效）', kept.length === 16 - named.length,
      `${kept.length}/16 格保持原样`);
  }

  // The write path is the one that was broken, so run it for real - against
  // the copy, never the repository.
  let wrote = false;
  let writeDetail = '';
  try {
    const log = run(['--fighter', id, '--sheet', sheetId, '--cells', '12', '--from', standIn, '--write']);
    wrote = fs.existsSync(target) && !/Error/.test(log);
    const predicted = (log.match(/new sheet sha would be ([0-9a-f]+)/) || [])[1];
    const actual = shortHash(hashFile(target));
    writeDetail = `预告 ${predicted} / 实写 ${actual}`;
    ok('--write 真的落盘，且落盘 sha 与 dry-run 预告一致', wrote && predicted === actual, writeDetail);
  } catch (e) {
    ok('--write 真的落盘，且落盘 sha 与 dry-run 预告一致', false,
      String(e.stderr || e.message).split('\n').find((l) => /Error/.test(l)) || 'threw');
  }

  // Replacing a cell that the ledger says to mirror means the override now
  // describes a drawing nobody read. The tool has to say so out loud.
  const flipCell = (FACING[`${id}/${sheetId}`] || {}).flip?.[0];
  if (Number.isInteger(flipCell)) {
    const warnLog = run(['--fighter', id, '--sheet', sheetId, '--cells', String(flipCell),
      '--from', standIn, '--out', path.join(tmp, 'w.png')]);
    ok('替换被 flip 覆盖的格时警告台账条目已失效', /WARN replaced flipped cell/.test(warnLog),
      `cell ${flipCell} 在 FACING['${id}/${sheetId}'].flip 里`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

process.exitCode = failures.length ? 1 : 0;
console.log(failures.length ? `facing ledger: ${failures.length} failure(s)` : 'facing ledger: clean');
