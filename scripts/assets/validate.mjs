/**
 * Static asset-library validator. No network, no browser, no writes.
 *
 * Usage: node scripts/assets/validate.mjs [--json]
 * Exits 1 on any gate failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIGHTERS } from '../../src/fighters.js';
import {
  PIPELINE_VERSION, alphaStats, probeImage, readPNG, sha256, walkFiles,
} from '../lib/imageops.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WEB = path.join(ROOT, 'web');
const ASSETS = path.join(WEB, 'assets');
const MANIFEST = path.join(ASSETS, 'manifest.json');
const COMPAT = path.join(ROOT, 'assets', 'compat', 'rig');
const SOURCE_FIGHTERS = path.join(ROOT, 'assets', 'source', 'plates', 'fighters');
const SOURCE_STAGE = path.join(ROOT, 'assets', 'source', 'plates', 'stage', 'stage_main.png');

const failures = [];
const warnings = [];
const ok = (label, cond, detail = '') => {
  if (!cond) failures.push(label + (detail ? ': ' + detail : ''));
  return cond;
};

function urlToFile(url) {
  if (!url || !url.startsWith('/assets/')) return null;
  return path.join(ASSETS, url.slice('/assets/'.length));
}

function refsFor(manifest) {
  const refs = new Set();
  const add = (url) => {
    if (!url || !url.startsWith('/assets/')) return;
    refs.add(url.slice('/assets/'.length).split('/').join(path.sep));
  };
  for (const asset of manifest.assets || []) {
    for (const variant of asset.variants || []) {
      add(variant.path);
      add(variant.alternate);
    }
    if (asset.rig) {
      add(asset.rig.data);
      add(asset.rig.atlas);
    }
  }
  return refs;
}

function validate() {
  if (!fs.existsSync(MANIFEST)) {
    failures.push('manifest missing: web/assets/manifest.json');
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  ok('schemaVersion is 1', manifest.schemaVersion === 1, String(manifest.schemaVersion));
  ok('pipeline matches', manifest.pipeline === PIPELINE_VERSION, manifest.pipeline);
  ok('revision present', /^sha256:[a-f0-9]{64}$/.test(manifest.revision || ''), manifest.revision);
  ok('assets is an array', Array.isArray(manifest.assets));
  ok('fighter ids match the roster',
    JSON.stringify((manifest.assets || []).filter((a) => a.kind === 'fighter-plate').map((a) => a.id).sort())
    === JSON.stringify(FIGHTERS.map((f) => f.id).sort()));

  const seenIds = new Set();
  let generatedBytes = 0;
  for (const asset of manifest.assets || []) {
    ok('asset id is unique: ' + asset.id, !seenIds.has(asset.id));
    seenIds.add(asset.id);
    ok('asset has license: ' + asset.id, Boolean(asset.license && asset.license.spdx && asset.license.origin));
    ok('asset has variants: ' + asset.id, Array.isArray(asset.variants) && asset.variants.length > 0);
    for (const variant of asset.variants || []) {
      const file = urlToFile(variant.path);
      ok('variant file exists: ' + variant.path, Boolean(file && fs.existsSync(file)));
      if (!file || !fs.existsSync(file)) continue;
      const buf = fs.readFileSync(file);
      const probe = probeImage(file);
      generatedBytes += buf.length;
      ok('variant bytes: ' + variant.path, buf.length === variant.bytes, `${buf.length} != ${variant.bytes}`);
      ok('variant sha256: ' + variant.path, sha256(buf) === variant.sha256);
      ok('variant dimensions: ' + variant.path, Boolean(probe) && probe.width === variant.width && probe.height === variant.height,
        probe ? `${probe.width}x${probe.height}` : 'probe failed');
      ok('variant alpha flag: ' + variant.path, asset.kind === 'stage-plate' ? probe && !probe.alpha : probe && probe.alpha);
    }
    if (asset.rig) {
      const dataFile = urlToFile(asset.rig.data);
      const atlasFile = urlToFile(asset.rig.atlas);
      ok('rig data exists: ' + asset.id, Boolean(dataFile && fs.existsSync(dataFile)));
      ok('rig atlas exists: ' + asset.id, Boolean(atlasFile && fs.existsSync(atlasFile)));
      if (!dataFile || !fs.existsSync(dataFile) || !atlasFile || !fs.existsSync(atlasFile)) continue;
      const rig = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      ok('rig schema 2: ' + asset.id, rig.schemaVersion === 2);
      ok('rig atlas url matches: ' + asset.id, rig.atlas && rig.atlas.path === asset.rig.atlas);
      ok('rig atlas dimensions match: ' + asset.id,
        rig.atlas && rig.atlas.width === asset.rig.width && rig.atlas.height === asset.rig.height);
      ok('rig has parts: ' + asset.id, Array.isArray(rig.parts) && rig.parts.length >= 6);
      ok('rig figureHeight sane: ' + asset.id, rig.figureHeight > 64 && rig.figureHeight <= 2048);
      ok('rig plateScale sane: ' + asset.id, rig.plateScale >= 1.2 && rig.plateScale <= 4.5, String(rig.plateScale));
      ok('rig atlas bytes: ' + asset.id, fs.statSync(atlasFile).size === asset.rig.bytes);
      ok('rig atlas sha256: ' + asset.id, sha256(fs.readFileSync(atlasFile)) === asset.rig.atlasSha256);
      const rects = [];
      for (const part of rig.parts || []) {
        const r = part.rect || {};
        ok(`rig ${asset.id}/${part.id} drive pair`, Array.isArray(part.drive) && part.drive.length === 2);
        ok(`rig ${asset.id}/${part.id} rect inside atlas`,
          r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0 && r.x + r.w <= rig.atlas.width && r.y + r.h <= rig.atlas.height);
        // A pivot may sit just above a limb crop (the hip is claimed by the
        // torso), so allow a bounded margin rather than requiring the pivot
        // pixel to be inside the atlas rect.
        const margin = Math.max(8, Math.round(rig.figureHeight * 0.25));
        ok(`rig ${asset.id}/${part.id} pivot inside rect`,
          part.px >= -margin && part.py >= -margin && part.px <= r.w + margin && part.py <= r.h + margin,
          `${part.px},${part.py} in ${r.w}x${r.h}`);
        ok(`rig ${asset.id}/${part.id} pivot joint exists`, Array.isArray(rig.joints[part.pivot]));
        rects.push({ id: part.id, ...r });
      }
      for (let i = 0; i < rects.length; i += 1) {
        for (let j = i + 1; j < rects.length; j += 1) {
          const a = rects[i], b = rects[j];
          const overlap = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
          ok(`rig ${asset.id} atlas rects do not overlap (${a.id}/${b.id})`, !overlap);
        }
      }
    }
  }

  ok('stage asset present', (manifest.assets || []).some((a) => a.kind === 'stage-plate'));
  ok('16 fighter assets', (manifest.assets || []).filter((a) => a.kind === 'fighter-plate').length === 16);

  // Alpha / source checks.
  for (const fighter of FIGHTERS) {
    const file = path.join(SOURCE_FIGHTERS, fighter.id + '.png');
    if (!fs.existsSync(file)) { failures.push('source plate missing: ' + fighter.id); continue; }
    const stats = alphaStats(readPNG(file));
    ok('source plate has alpha: ' + fighter.id, stats.opaqueRatio > 0.1 && stats.borderTransparentRatio > 0.6,
      `opaque=${stats.opaqueRatio.toFixed(2)} border=${stats.borderTransparentRatio.toFixed(2)}`);
    ok('legacy rig json: ' + fighter.id, fs.existsSync(path.join(COMPAT, fighter.id, 'rig.json')));
    ok('legacy rig mask: ' + fighter.id, fs.existsSync(path.join(COMPAT, fighter.id, 'mask.png')));
  }
  ok('source stage present', fs.existsSync(SOURCE_STAGE));
  if (fs.existsSync(SOURCE_STAGE)) {
    const stats = alphaStats(readPNG(SOURCE_STAGE));
    ok('source stage is opaque', stats.opaqueRatio > 0.99, stats.opaqueRatio.toFixed(3));
  }

  // Orphans (current + previous manifest keep a deploy window).
  const refs = refsFor(manifest);
  const prevPath = path.join(ASSETS, 'manifest.prev.json');
  if (fs.existsSync(prevPath)) {
    for (const ref of refsFor(JSON.parse(fs.readFileSync(prevPath, 'utf8')))) refs.add(ref);
  }
  const generated = walkFiles(path.join(ASSETS, 'v'));
  for (const file of generated) {
    const rel = path.relative(ASSETS, file);
    ok('no orphan generated file: ' + rel.split(path.sep).join('/'), refs.has(rel));
  }
  let currentBytes = 0;
  for (const rel of refsFor(manifest)) {
    const file = path.join(ASSETS, rel);
    if (fs.existsSync(file)) currentBytes += fs.statSync(file).size;
  }
  ok('manifest totals.webAssetsBytes matches its referenced files', currentBytes === manifest.totals.webAssetsBytes,
    `${currentBytes} != ${manifest.totals.webAssetsBytes}`);
  ok('live budget', manifest.totals.liveViewBytes <= manifest.budgets.liveViewBytes,
    `${manifest.totals.liveViewBytes} > ${manifest.budgets.liveViewBytes}`);
  ok('gallery budget', manifest.totals.galleryViewBytes <= manifest.budgets.galleryViewBytes,
    `${manifest.totals.galleryViewBytes} > ${manifest.budgets.galleryViewBytes}`);
  ok('library budget', manifest.totals.webAssetsBytes <= manifest.budgets.libraryBytes,
    `${manifest.totals.webAssetsBytes} > ${manifest.budgets.libraryBytes}`);

  if (!(manifest.totals.liveViewBytes <= 1500000)) {
    warnings.push('liveViewBytes above the WebP target; install cwebp or rebuild assets');
  }
}

validate();
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ok: failures.length === 0, failures, warnings }, null, 2));
} else {
  for (const warning of warnings) console.log('  WARN  ' + warning);
  for (const failure of failures) console.log('  FAIL  ' + failure);
  console.log(failures.length ? `\n${failures.length} asset failure(s)` : '\nall asset checks passed');
}
process.exitCode = failures.length ? 1 : 0;
