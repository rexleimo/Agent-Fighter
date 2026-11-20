// Manifest construction for the asset pipeline, split out of scripts/assets/build.mjs.
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
const SOURCE_FIGHTERS = path.join(ROOT, 'assets', 'source', 'plates', 'fighters');
const SOURCE_STAGE_DIR = path.join(ROOT, 'assets', 'source', 'plates', 'stage');
const OVERRIDE_DIR = path.join(ROOT, 'assets', 'rig');
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

export { buildManifest };
