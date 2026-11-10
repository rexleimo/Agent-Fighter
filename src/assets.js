/**
 * Server-side asset manifest.
 *
 * The browser uses `/assets/manifest.json` directly; this module is the
 * server's small index for critical preload tags, hashed-path validation and
 * the migration aliases that keep old `/assets/art/**` and `/assets/rig/**`
 * clients working. It never owns rendering or combat data.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const ASSETS = path.join(WEB, 'assets');
const MANIFEST_PATH = path.join(ASSETS, 'manifest.json');

const SOURCE = path.join(ROOT, 'assets', 'source', 'plates');
const COMPAT = path.join(ROOT, 'assets', 'compat', 'rig');

const state = {
  manifest: null,
  byId: new Map(),
  mtimeMs: 0,
  ok: false,
};

function readManifest() {
  let stat;
  try {
    stat = fs.statSync(MANIFEST_PATH);
  } catch {
    state.ok = false;
    state.manifest = null;
    state.byId = new Map();
    return;
  }
  if (state.manifest && stat.mtimeMs === state.mtimeMs) return;
  try {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.assets)) throw new Error('bad manifest schema');
    const byId = new Map();
    for (const asset of manifest.assets) byId.set(asset.id, asset);
    state.manifest = manifest;
    state.byId = byId;
    state.mtimeMs = stat.mtimeMs;
    state.ok = true;
  } catch (error) {
    console.error('[afl] asset manifest unavailable:', error.message);
    state.manifest = null;
    state.byId = new Map();
    state.ok = false;
  }
}

export function getManifest() {
  readManifest();
  return state.manifest;
}

export function getAsset(id) {
  readManifest();
  return state.byId.get(id) || null;
}

export function assetsState() {
  readManifest();
  if (!state.ok) return { manifest: '/assets/manifest.json', revision: null, schemaVersion: null, ok: false };
  return {
    manifest: '/assets/manifest.json',
    revision: state.manifest.revision,
    schemaVersion: state.manifest.schemaVersion,
    ok: true,
  };
}

export function isHashedAssetPath(pathname) {
  return /^\/assets\/v\/(?:[a-z0-9._-]+\/)+[a-z0-9._-]+\.[a-f0-9]{12}\.(png|webp|json)$/i.test(pathname);
}

/** Critical images the HTML shell should preload before JS runs. */
export function criticalPreloadTags() {
  const manifest = getManifest();
  if (!manifest) return '';
  const stage = manifest.assets.find((asset) => asset.kind === 'stage-plate');
  const variant = stage && stage.variants && stage.variants[0];
  if (!variant) return '';
  return `<link rel="preload" as="image" href="${variant.path}" fetchpriority="high">\n`;
}

/**
 * Migration alias map. Old tabs keep requesting these exact URLs; they get
 * the original/frozen bytes, while new clients use the content-addressed
 * manifest paths.
 */
export function legacyAssetPath(pathname) {
  if (pathname === '/assets/art/stage_main.png') {
    return path.join(SOURCE, 'stage', 'stage_main.png');
  }
  let match = pathname.match(/^\/assets\/art\/([a-z0-9-]+)\.png$/i);
  if (match) return path.join(SOURCE, 'fighters', match[1] + '.png');
  match = pathname.match(/^\/assets\/rig\/([a-z0-9-]+)\/(rig\.json|mask\.png)$/i);
  if (match) return path.join(COMPAT, match[1], match[2]);
  return null;
}

export function webRoot() {
  return WEB;
}

export function assetsRoot() {
  return ASSETS;
}
