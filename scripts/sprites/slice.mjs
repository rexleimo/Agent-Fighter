// Sprite slice pipeline CLI. Implementation lives in the slice-*.mjs modules.
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
import { attempt, parseOr } from '../lib/no-throw.mjs';
import { CELL, OUT, FRAME, STANCE_H, ANCHOR, matteCell, stripGroundShadows, stripSealFade } from './slice-shared.mjs';
import { dropBackgroundPockets, bodyExtent, median, stanceReference, stanceWidth } from './slice-pockets.mjs';
import { sheetCorrection, standingCorrection, placeFrame, BODY_COMPONENT_MIN } from './slice-placement.mjs';
import { labelComponents, doubledBodies, splitCrossRowComponents, sliceSheet } from './slice-audit.mjs';
import { frameStats, auditClip, bakeFighter } from './slice-bake.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
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
    const baked = await attempt(() => bakeFighter(id, { write: !check }));
    if (baked.ok) {
      const entry = baked.value;
      entries.push(entry);
      const problems = entry.qa.length;
      if (problems) bad += 1;
      console.log(`[slice] ${id}: clips=${entry.clipCount} atlas=${entry.atlasBytes}B qa=${problems}`
        + (problems ? ' ' + JSON.stringify(entry.qa.slice(0, 4)) : '')
        + (entry.repairs.length ? ` repaired=${JSON.stringify(entry.repairs)}` : '')
        + (entry.defects.length ? ` off-model=${JSON.stringify(entry.defects)}` : ''));
    } else {
      bad += 1;
      console.error(`[slice] ${id}: ${baked.error.message}`);
    }
  }

  if (!check) {
    // Merge with the existing index: a partial run (--only) must not drop the
    // fighters that were baked earlier.
    const indexPath = path.join(OUT, 'sprites.json');
    let previous = { fighters: [] };
    if (fs.existsSync(indexPath)) {
      previous = await parseOr(fs.readFileSync(indexPath, 'utf8'), { fighters: [] });
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
  FRAME, STANCE_H, ANCHOR,
  matteCell, stripGroundShadows, dropBackgroundPockets, stripSealFade, sliceSheet,
  bodyExtent, cropRGBA, labelComponents, doubledBodies, splitCrossRowComponents,
  median, stanceReference, stanceWidth, sheetCorrection, standingCorrection,
  placeFrame, bakeFighter,
  frameStats, auditClip, BODY_COMPONENT_MIN,
};

// Importable so the bake can be audited frame by frame; the CLI only runs when
// this file is executed directly.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
