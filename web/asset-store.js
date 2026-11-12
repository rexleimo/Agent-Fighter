/**
 * Browser asset store.
 *
 * One manifest is the source of truth for every generated image. The live view
 * asks for only the two fighters in the current match; the gallery asks for
 * cards when its view becomes visible. If the manifest or a WebP variant is
 * missing, callers fall back to the legacy source URLs and finally to the
 * procedural renderer.
 */

const state = {
  manifest: null,
  byId: new Map(),
  stage: null,
  ready: false,
  revision: null,
};

const images = new Map();
const rigData = new Map();
const MAX_IMAGES = 24;

function remember(key, value) {
  if (images.size >= MAX_IMAGES) {
    const oldest = images.keys().next().value;
    images.delete(oldest);
  }
  images.set(key, value);
  return value;
}

export async function loadManifest() {
  if (state.ready) return state.manifest;
  try {
    const res = await fetch('/assets/manifest.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('manifest ' + res.status);
    const manifest = await res.json();
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.assets)) {
      throw new Error('bad manifest schema');
    }
    state.manifest = manifest;
    state.revision = manifest.revision || null;
    state.byId = new Map(manifest.assets.map((asset) => [asset.id, asset]));
    state.ready = true;
  } catch (error) {
    state.ready = false;
    console.warn('[afl] asset manifest unavailable, using legacy paths', error);
  }
  return state.manifest;
}

export function manifestReady() {
  return state.ready;
}

export function assetFor(id) {
  return state.byId.get(id) || null;
}

export function variantFor(id, role) {
  const asset = assetFor(id);
  if (!asset || !Array.isArray(asset.variants)) return null;
  return asset.variants.find((variant) => variant.role === role) || asset.variants[0] || null;
}

export function stageVariant() {
  const stage = [...state.byId.values()].find((asset) => asset.kind === 'stage-plate');
  return stage && stage.variants ? stage.variants[0] : null;
}

export function legacyArtUrl(id) {
  return '/assets/art/' + encodeURIComponent(id) + '.png';
}

export function legacyRigUrl(id) {
  return '/assets/rig/' + encodeURIComponent(id) + '/rig.json';
}

function loadImage(url, fallback) {
  // A missing manifest must not mean "no art". The header promises callers fall
  // back to the legacy source URLs, so an empty primary url has to take the
  // fallback branch too - rejecting here made every stage and fighter image
  // silently disappear and left the procedural placeholder set on screen.
  const primary = url || null;
  if (!primary && !fallback) return Promise.reject(new Error('missing asset url'));
  const cached = images.get(primary);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      const done = () => remember(primary, img) && resolve(img);
      if (typeof img.decode === 'function') img.decode().then(done).catch(done);
      else done();
    };
    img.onerror = () => {
      if (fallback && fallback !== primary) {
        loadImage(null, fallback).then(resolve).catch(reject);
        return;
      }
      reject(new Error('asset failed: ' + (primary || fallback)));
    };
    img.src = primary || fallback;
  });
}

/**
 * Every art lookup is manifest-driven, so the manifest has to be resolved by the
 * store itself. Relying on a caller to bootstrap first is not a contract: no
 * caller ever did, which left state.byId empty and made every variant path null.
 */
async function ensureManifest() {
  if (state.ready) return state.manifest;
  return loadManifest();
}

export async function loadStageArt() {
  if (state.stage) return state.stage;
  await ensureManifest();
  const variant = stageVariant();
  const img = await loadImage(variant && variant.path, legacyArtUrl('stage_main'));
  state.stage = img;
  return img;
}

export async function loadFighterArt(id, role = 'play') {
  const key = id + ':' + role;
  const cached = images.get(key);
  if (cached) return cached;
  await ensureManifest();
  const variant = variantFor(id, role);
  const img = await loadImage(variant && variant.path, legacyArtUrl(id));
  remember(key, img);
  return img;
}

export async function loadRigData(id) {
  if (rigData.has(id)) return rigData.get(id);
  await ensureManifest();
  const asset = assetFor(id);
  if (!asset || !asset.rig || !asset.rig.data) return null;
  try {
    const res = await fetch(asset.rig.data, { cache: 'no-cache' });
    if (!res.ok) throw new Error('rig ' + res.status);
    const rig = await res.json();
    if (rig.schemaVersion !== 2) throw new Error('rig schema ' + rig.schemaVersion);
    rigData.set(id, rig);
    return rig;
  } catch (error) {
    console.warn('[afl] rig data unavailable for ' + id, error);
    return null;
  }
}

export async function loadRigAtlas(rig) {
  if (!rig || !rig.atlas || !rig.atlas.path) return null;
  try {
    return await loadImage(rig.atlas.path, null);
  } catch {
    return null;
  }
}

export async function preloadFighters(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  return Promise.allSettled(unique.map((id) => loadFighterArt(id, 'play')));
}
