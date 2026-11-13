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
// One entry per stage plate, so switching arenas never drops the previous one
// while a replay is still painting it.
const stageImages = new Map();

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

/**
 * The plate for one stage. There used to be exactly one stage in the league, so
 * this took the first `stage-plate` it found; with five arenas that would draw
 * the neutral stadium behind every match regardless of what the server declared.
 * `stageId` is the id the server published, and an unknown id resolves to the
 * neutral arena rather than to an arbitrary plate.
 */
export function stageVariant(stageId) {
  const plates = [...state.byId.values()].filter((asset) => asset.kind === 'stage-plate');
  if (!plates.length) return null;
  const wanted = stageId ? plates.find((p) => p.id === stageId) : null;
  return wanted || plates.find((p) => p.preload === 'critical') || plates[0];
}

/** The plate a request resolved to, so a fallback uses its own legacy file
 *  instead of reverse-parsing a url. */
export function stagePlateFor(stageId) {
  const asset = stageVariant(stageId);
  if (!asset) return null;
  const variant = asset.variants ? asset.variants.find((v) => v.role === 'stage') || asset.variants[0] : null;
  return variant ? { id: asset.id, path: variant.path } : null;
}

/** Which stage ids actually have a published plate - used to report honestly. */
export function stagePlateIds() {
  return [...state.byId.values()].filter((a) => a.kind === 'stage-plate').map((a) => a.id);
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

export async function loadStageArt(stageId) {
  const key = stageId || 'stage_main';
  if (stageImages.get(key)) return stageImages.get(key);
  await ensureManifest();
  const plate = stagePlateFor(key);
  if (!plate) return loadStageArtFallback(key);
  const img = await loadImage(plate.path, legacyArtUrl(plate.id));
  stageImages.set(key, img);
  if (!stageImages.get('stage_main')) stageImages.set('stage_main', img);
  state.stage = img;
  return img;
}

/** No manifest plate at all: the legacy file, and never a blank arena. */
async function loadStageArtFallback(key) {
  const img = await loadImage(null, legacyArtUrl(key));
  stageImages.set(key, img);
  if (!stageImages.get('stage_main')) stageImages.set('stage_main', img);
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
