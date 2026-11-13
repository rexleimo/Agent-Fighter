/**
 * Asset library builder.
 *
 * Source plates live outside the web root. This script produces:
 *   web/assets/v/<id>/play-512.<hash>.png|webp
 *   web/assets/v/<id>/card-480.<hash>.png|webp
 *   web/assets/v/stage_main/stage-1280.<hash>.png|webp
 *   web/assets/v/rig/<id>/atlas.<hash>.png|webp + rig.<hash>.json
 *   web/assets/manifest.json
 *
 * `--check` rebuilds into a temp tree and compares the manifest; it never
 * writes to web/assets. `--out` is for diagnostics.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIGHTERS } from '../../src/fighters.js';
import { STAGES } from '../../src/stages.js';
import {
  PIPELINE_VERSION, cwebpPath, encodeWebP, readPNG, resizeToHeight, resizeToWidth,
  sha256, shortHash, writeAtomic,
} from '../lib/imageops.mjs';
import { encodeRGBA } from '../lib/png.mjs';
import { buildRig } from './rig.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CATALOG_PATH = path.join(ROOT, 'assets', 'catalog.json');
const SOURCE_FIGHTERS = path.join(ROOT, 'assets', 'source', 'plates', 'fighters');
const SOURCE_STAGE_DIR = path.join(ROOT, 'assets', 'source', 'plates', 'stage');
const OVERRIDE_DIR = path.join(ROOT, 'assets', 'rig');
const DEFAULT_OUT = path.join(ROOT, 'web', 'assets');

function canonicalJSON(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJSON(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function fileVariant({ outRoot, dirRel, name, image, quality, alpha, write }) {
  const role = name.startsWith('play') ? 'play' : name.startsWith('card') ? 'card' : name.startsWith('stage') ? 'stage' : name;
  const pngBuf = encodeRGBA(image.width, image.height, image.rgba);
  const pngHash = sha256(pngBuf);
  const pngName = `${name}.${shortHash(pngHash)}.png`;
  const pngPath = path.join(outRoot, 'v', dirRel, pngName);
  const urlBase = '/assets/v/' + dirRel.split(path.sep).join('/') + '/';
  if (write) {
    writeAtomic(pngPath, pngBuf);
    const tmpWebp = path.join(os.tmpdir(), `afl-${name}-${process.pid}.webp`);
    const encoded = encodeWebP(pngPath, tmpWebp, { quality, alpha });
    if (encoded) {
      const webpBuf = fs.readFileSync(tmpWebp);
      const webpHash = sha256(webpBuf);
      const webpName = `${name}.${shortHash(webpHash)}.webp`;
      fs.renameSync(tmpWebp, path.join(outRoot, 'v', dirRel, webpName));
      fs.rmSync(pngPath, { force: true });
      return {
        id: name, role, path: urlBase + webpName, width: image.width, height: image.height,
        bytes: webpBuf.length, mediaType: 'image/webp', format: 'webp', alpha, sha256: webpHash,
      };
    }
  }
  return {
    id: name, role, path: urlBase + pngName, width: image.width, height: image.height,
    bytes: pngBuf.length, mediaType: 'image/png', format: 'png', alpha, sha256: pngHash,
  };
}

function sourceHashFor(stageFiles, catalog, ids) {
  const entries = ids.map((id) => {
    const file = path.join(SOURCE_FIGHTERS, id + '.png');
    const buf = fs.readFileSync(file);
    return { id, bytes: buf.length, sha256: sha256(buf) };
  });
  const stages = stageFiles.map((file) => {
    const buf = fs.readFileSync(file);
    return { name: path.basename(file), bytes: buf.length, sha256: sha256(buf) };
  });
  return 'sha256:' + sha256(Buffer.from(JSON.stringify({
    pipeline: PIPELINE_VERSION,
    catalog,
    fighters: entries,
    stages,
  })));
}

/**
 * Stage plates come from the server registry, not from a second list here.
 * If the build and src/stages.js disagreed about which arenas exist, a match
 * could declare a stage whose plate was never published, and the client would
 * have nothing to draw.
 */
function stagePlates() {
  return STAGES.map((s) => {
    const file = path.join(SOURCE_STAGE_DIR, s.plate + '.png');
    if (!fs.existsSync(file)) {
      throw new Error('stage ' + s.id + ' declares plate ' + s.plate
        + ' but ' + path.relative(ROOT, file) + ' does not exist');
    }
    return { stage: s, file };
  });
}

function buildManifest({ outRoot, write, ids, overlay, catalog }) {
  const license = catalog.license;
  const variants = catalog.variants;
  const assets = [];
  const files = [];

  // Stages first so a critical preload can find them without a roster scan.
  const stageVariants = [];
  stagePlates().forEach(({ stage: s, file }, index) => {
    const img = resizeToWidth(readPNG(file), variants.stage.width);
    const variant = fileVariant({
      outRoot, dirRel: s.plate, name: 'stage-1280', image: img,
      quality: variants.stage.quality, alpha: false, write,
    });
    assets.push({
      id: s.id,
      kind: 'stage-plate',
      order: index,
      // Only the neutral arena is preloaded: it is what a fresh visitor sees.
      // Team arenas are fetched when a match actually declares one.
      preload: s.neutral ? 'critical' : 'lazy',
      license,
      team: s.team,
      layers: s.layers,
      variants: [variant],
    });
    files.push(variant);
    stageVariants.push(variant);
  });

  const rigById = new Map();
  const playById = new Map();
  ids.forEach((id, index) => {
    const fighter = FIGHTERS.find((f) => f.id === id);
    if (!fighter) throw new Error('unknown fighter id: ' + id);
    const sourcePath = path.join(SOURCE_FIGHTERS, id + '.png');
    const source = readPNG(sourcePath);
    const play = fileVariant({
      outRoot, dirRel: id, name: 'play-512',
      image: resizeToHeight(source, variants.play.height),
      quality: variants.play.quality, alpha: true, write,
    });
    const card = fileVariant({
      outRoot, dirRel: id, name: 'card-480',
      image: resizeToHeight(source, variants.card.height),
      quality: variants.card.quality, alpha: true, write,
    });
    const baked = buildRig({
      id, sourcePath,
      outDir: path.join(outRoot, 'v', 'rig', id),
      overrideDir: OVERRIDE_DIR,
      bakeHeight: variants.rig.bakeHeight,
      write,
      overlay,
      previewDir: path.join(ROOT, '.tmp-rig', 'overlay'),
    });
    rigById.set(id, baked);
    playById.set(id, play);
    assets.push({
      id,
      kind: 'fighter-plate',
      fighterId: id,
      team: fighter.team,
      order: 10 + index,
      preload: 'active',
      license,
      variants: [play, card],
      rig: {
        schemaVersion: baked.rig.schemaVersion,
        data: baked.jsonUrl,
        dataBytes: baked.jsonBytes,
        dataSha256: baked.jsonSha256,
        atlas: baked.rig.atlas.path,
        format: baked.rig.atlas.format,
        width: baked.rig.atlas.width,
        height: baked.rig.atlas.height,
        bytes: baked.rig.atlas.bytes,
        atlasSha256: baked.rig.atlas.sha256,
        parts: baked.rig.parts.map((p) => p.id),
        figureHeight: baked.rig.figureHeight,
      },
    });
    files.push(play, card);
  });

  // A live view shows exactly one arena, so the budget is the worst single
  // plate plus the two fighters - not the sum of every stage in the league.
  const stageEffective = Math.max(...stageVariants.map((v) => v.bytes));
  const pairBytes = ids.map((id) => {
    const play = playById.get(id);
    const rig = rigById.get(id).rig;
    return play.bytes + rig.atlas.bytes + rigById.get(id).jsonBytes;
  }).sort((a, b) => b - a);
  const liveViewBytes = stageEffective + pairBytes[0] + (pairBytes[1] || 0);
  const galleryViewBytes = ids.reduce((sum, id) => {
    const card = assets.find((a) => a.id === id).variants[1];
    return sum + card.bytes;
  }, 0);

  // Budget counts the current build only. Previous-generation files may stay
  // on disk for rollback, but they are not part of this manifest's delivery.
  const webAssetsBytes = files.reduce((sum, v) => sum + v.bytes, 0)
    + ids.reduce((sum, id) => {
      const baked = rigById.get(id);
      return sum + baked.jsonBytes + baked.rig.atlas.bytes;
    }, 0);
  const manifest = {
    schemaVersion: 1,
    pipeline: PIPELINE_VERSION,
    minClient: 1,
    budgets: catalog.budgets,
    sourceHash: sourceHashFor(stagePlates().map((p) => p.file), catalog, ids),
    assets,
    totals: {
      liveViewBytes,
      galleryViewBytes,
      webAssetsBytes,
    },
  };
  const withoutRevision = JSON.parse(JSON.stringify(manifest));
  manifest.revision = 'sha256:' + sha256(Buffer.from(canonicalJSON(withoutRevision)));
  return manifest;
}

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function refsFor(manifest) {
  const refs = new Set();
  const add = (url) => {
    if (!url || !url.startsWith('/assets/')) return;
    refs.add(url.slice('/assets/'.length));
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

/**
 * Sub-trees of web/assets/v that belong to another pipeline.
 *
 * `prune` used to sweep the whole `v/` tree and delete anything this build's
 * manifest did not name - which silently destroyed the sprite pipeline's
 * output under `v/sprites/`, because sprites are published by
 * `sprites.json`, not by `manifest.json`. A build step must not treat another
 * step's published namespace as garbage, so ownership is declared here instead
 * of being inferred from one manifest.
 */
const FOREIGN_NAMESPACES = [
  { dir: 'sprites', manifest: 'sprites.json', label: 'sprite pipeline' },
];

function foreignRefs(outRoot) {
  const refs = new Set();
  for (const ns of FOREIGN_NAMESPACES) {
    const p = path.join(outRoot, ns.manifest);
    if (!fs.existsSync(p)) continue;
    try {
      const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const url of urlsIn(doc)) {
        if (url.startsWith('/assets/')) refs.add(url.slice('/assets/'.length));
      }
    } catch { /* unreadable sibling manifest: keep its tree, never delete blind */ }
  }
  return refs;
}

function urlsIn(value, out = []) {
  if (typeof value === 'string') { if (value.startsWith('/assets/')) out.push(value); return out; }
  if (Array.isArray(value)) { for (const v of value) urlsIn(v, out); return out; }
  if (value && typeof value === 'object') { for (const v of Object.values(value)) urlsIn(v, out); }
  return out;
}

function prune(outRoot) {
  const manifestPath = path.join(outRoot, 'manifest.json');
  const prevPath = path.join(outRoot, 'manifest.prev.json');
  if (!fs.existsSync(manifestPath)) return { removed: 0 };
  const refs = new Set(refsFor(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))));
  if (fs.existsSync(prevPath)) {
    for (const ref of refsFor(JSON.parse(fs.readFileSync(prevPath, 'utf8')))) refs.add(ref);
  }
  const vRoot = path.join(outRoot, 'v');
  const foreign = foreignRefs(outRoot);
  const foreignDirs = new Set(FOREIGN_NAMESPACES.map((n) => n.dir));
  let removed = 0;
  let skippedForeign = 0;
  for (const file of walkFiles(vRoot)) {
    const rel = path.relative(outRoot, file).split(path.sep).join('/');
    // Never touch another pipeline's namespace, even if this manifest is silent
    // about it.
    const top = rel.split('/')[1];
    if (foreignDirs.has(top)) { skippedForeign += 1; continue; }
    if (refs.has(rel) || foreign.has(rel)) continue;
    fs.rmSync(file, { force: true });
    removed += 1;
  }
  // Remove empty directories bottom-up.
  for (const dir of walkDirs(vRoot).sort((a, b) => b.length - a.length)) {
    try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch { /* ignore */ }
  }
  return { removed };
}

function walkDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    out.push(full, ...walkDirs(full));
  }
  return out;
}

export function build({ outRoot = DEFAULT_OUT, write = true, overlay = false, ids = FIGHTERS.map((f) => f.id) } = {}) {
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const manifest = buildManifest({ outRoot, write, ids, overlay, catalog });
  if (write) {
    fs.mkdirSync(outRoot, { recursive: true });
    const manifestPath = path.join(outRoot, 'manifest.json');
    const next = JSON.stringify(manifest, null, 2) + '\n';
    if (fs.existsSync(manifestPath)) {
      const current = fs.readFileSync(manifestPath, 'utf8');
      if (current !== next) fs.writeFileSync(path.join(outRoot, 'manifest.prev.json'), current);
    }
    writeAtomic(manifestPath, Buffer.from(next));
    writeAtomic(path.join(outRoot, 'build-info.json'), Buffer.from(JSON.stringify({
      generatedAt: new Date().toISOString(),
      node: process.version,
      pipeline: PIPELINE_VERSION,
      cwebp: cwebpPath(),
      revision: manifest.revision,
      sourceHash: manifest.sourceHash,
      totals: manifest.totals,
    }, null, 2) + '\n'));
    prune(outRoot);
  }
  return manifest;
}

function diffManifest(a, b) {
  const lines = [];
  if (!a) return ['committed manifest missing'];
  if (a.revision !== b.revision) lines.push(`revision ${a.revision} -> ${b.revision}`);
  if (a.sourceHash !== b.sourceHash) lines.push(`sourceHash ${a.sourceHash} -> ${b.sourceHash}`);
  const ap = new Map();
  for (const asset of a.assets) for (const v of asset.variants) ap.set(v.path, v);
  for (const asset of b.assets) for (const v of asset.variants) {
    const old = ap.get(v.path);
    if (!old) lines.push(`+ ${v.path}`);
    else if (old.sha256 !== v.sha256) lines.push(`~ ${v.path}`);
  }
  if (!lines.length) lines.push('manifest content differs');
  return lines.slice(0, 12);
}

const argv = process.argv.slice(2);
const check = argv.includes('--check');
const overlay = argv.includes('--overlay');
const outIndex = argv.indexOf('--out');
const outRoot = outIndex >= 0 && argv[outIndex + 1] ? path.resolve(argv[outIndex + 1]) : DEFAULT_OUT;
const onlyIndex = argv.indexOf('--only');
const ids = onlyIndex >= 0 && argv[onlyIndex + 1]
  ? argv[onlyIndex + 1].split(',').map((s) => s.trim()).filter(Boolean)
  : FIGHTERS.map((f) => f.id);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (check) {
    const tmp = fs.mkdtempSync(path.join(ROOT, '.tmp-assets-'));
    try {
      const built = build({ outRoot: tmp, write: true, overlay: false, ids });
      const committedPath = path.join(DEFAULT_OUT, 'manifest.json');
      const committed = fs.existsSync(committedPath)
        ? JSON.parse(fs.readFileSync(committedPath, 'utf8'))
        : null;
      if (!committed || JSON.stringify(committed) !== JSON.stringify(built)) {
        console.error('[assets:check] manifest drift');
        for (const line of diffManifest(committed, built)) console.error('  ' + line);
        process.exitCode = 1;
      } else {
        console.log('[assets:check] ok ' + built.revision + ' (' + built.assets.length + ' assets)');
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } else {
    const manifest = build({ outRoot, write: true, overlay, ids });
    console.log('[assets:build] ' + manifest.revision);
    console.log('[assets:build] assets=' + manifest.assets.length
      + ' live=' + manifest.totals.liveViewBytes
      + ' gallery=' + manifest.totals.galleryViewBytes
      + ' total=' + manifest.totals.webAssetsBytes);
  }
}
