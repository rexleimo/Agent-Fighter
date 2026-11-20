/**
 * Painted art layer: asset loading, arena plates and procedural weather.
 * Extracted from stage.js without changing any drawing behaviour.
 */
import { loadFighterArt, loadStageArt, preloadFighters } from '@web/asset-store.js';
import { ART, GROUND } from './shared.js';

export function installArt(ctx) {
  const { S } = ctx;

/** The plate a stage id resolves to, or the neutral arena if it never arrived. */
function stageImage(stageId) {
  const img = ART.stages[stageId];
  if (img && img.complete && img.naturalWidth > 0) return img;
  const neutral = ART.stages.stage_main;
  return neutral && neutral.complete && neutral.naturalWidth > 0 ? neutral : null;
}

function artImage(id) {
  const img = ART.images[id];
  return img && img.complete && img.naturalWidth > 0 ? img : null;
}

function repaintArt() {
  // Repaint whatever was last drawn, on the canvas it was drawn to. This used
  // to repaint only the stage canvas, so on the replay page - whose stage
  // canvas is a throwaway - the arena image arriving after the first frame
  // never reached the screen: the replay kept showing procedural geometry under
  // a record that correctly named the arena.
  const last = S.lastDraw;
  if (!last || !last.canvas) return;
  ctx.draw(last.ctx, last.frame, last.match, last.canvas);
}

/**
 * Load the plate for the arena this match is actually played in.
 *
 * Called on every new match: the previous behaviour was to load one image once
 * and keep it, which is exactly how a single-stage league looked static across
 * every fight. `ART.failed` records the id so a missing plate is reported as a
 * fallback rather than silently showing the wrong arena.
 */
function loadStageArtwork(stageId) {
  const id = stageId || 'stage_main';
  if (ART.stages[id] || ART.failed.has(id)) return;
  loadStageArt(id).then((img) => {
    ART.stages[id] = img;
    ART.stage = img;
    repaintArt();
  }).catch(() => {
    ART.failed.add(id);
    // Without the declared plate, fall back to the neutral arena and say so via
    // the failed set - never keep painting the previous match's arena.
    if (id !== 'stage_main') loadStageArtwork('stage_main');
  });
}

function loadFighter(id) {
  if (!id || ART.wanted.has(id)) return;
  ART.wanted.add(id);
  loadFighterArt(id, 'play').then((img) => {
    ART.images[id] = img;
    repaintArt();
  }).catch(() => ART.failed.add(id));
}

function matchFighterIds(match) {
  return [match && match.a, match && match.b]
    .map((side) => side && side.fighter && side.fighter.id)
    .filter(Boolean);
}

/** Preload only the matchup we are about to watch. */
function ensureMatchFighters(match) {
  const ids = matchFighterIds(match);
  if (!ids.length) return;
  preloadFighters(ids);
  for (const id of ids) loadFighter(id);
}

/** Deterministic pseudo-random from (seed, lane, frame) - same inputs, same
 *  particle field in live and replay, because both carry the same seed. */
function hash3(a, b, c) {
  let h = (a ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (b + 0x165667b1), 0xc2b2ae35) >>> 0;
  h = Math.imul(h ^ (c + 0x27d4eb2f), 0x165667b1) >>> 0;
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

const WEATHER = {
  rain: { count: 90, color: 'rgba(150,205,235,', speed: 9.5, drift: -1.4, size: [8, 20] },
  embers: { count: 54, color: 'rgba(255,168,72,', speed: -2.6, drift: 0.9, size: [1.4, 3.4] },
  dust: { count: 66, color: 'rgba(214,190,150,', speed: -0.7, drift: 1.6, size: [1.2, 3.0] },
  sparks: { count: 46, color: 'rgba(196,158,255,', speed: -3.4, drift: 2.2, size: [1.0, 2.6] },
};

/**
 * The living layer over a still plate: weather, ambient grade and light
 * flicker. Everything is a pure function of (stage layers, seed, tick), so the
 * arena breathes identically when the same match is replayed - a Math.random()
 * here would make the live view and the replay disagree, which is the one thing
 * a stage may never do.
 */
function drawStageLayers(c, w, h, stage, seed, tick) {
  if (!stage || !stage.layers) return;
  const L = stage.layers;
  const t = Number.isFinite(tick) ? tick : 0;
  const s = Number.isFinite(seed) ? seed >>> 0 : 0;
  const spec = WEATHER[L.weather];
  if (spec && S.showFx) {
    for (let i = 0; i < spec.count; i += 1) {
      const lane = hash3(s, i, 1);
      const phase = hash3(s, i, 2);
      const x = ((lane * w + t * spec.drift * 0.6) % (w + 60) + w + 60) % (w + 60) - 30;
      const y = ((phase * h + t * spec.speed) % (h + 40) + h + 40) % (h + 40) - 20;
      const len = spec.size[0] + phase * (spec.size[1] - spec.size[0]);
      const alpha = 0.16 + lane * 0.3;
      c.fillStyle = spec.color + alpha.toFixed(3) + ')';
      if (L.weather === 'rain') {
        c.fillRect(x, y, 1.2, len);
      } else {
        c.beginPath();
        c.arc(x, y, len * 0.5, 0, Math.PI * 2);
        c.fill();
      }
    }
  }
  // Ambient grade: a tint that ties the plate to the team's element.
  const AMBIENT = {
    warm: 'rgba(255,120,40,.07)', cool: 'rgba(60,150,220,.07)',
    sodium: 'rgba(255,180,80,.06)', storm: 'rgba(150,90,255,.08)',
    neon: 'rgba(90,200,230,.05)',
  };
  if (AMBIENT[L.ambient]) {
    c.fillStyle = AMBIENT[L.ambient];
    c.fillRect(0, 0, w, h);
  }
  // Light flicker, and for storm stages a periodic lightning sweep.
  if (L.flicker) {
    const n = hash3(s, 7, Math.floor(t / 6));
    c.fillStyle = 'rgba(255,255,255,' + (n * L.flicker * 0.05).toFixed(4) + ')';
    c.fillRect(0, 0, w, h);
  }
  if (L.ambient === 'storm' && hash3(s, 11, Math.floor(t / 34)) > 0.82) {
    c.fillStyle = 'rgba(210,190,255,.16)';
    c.fillRect(0, 0, w, h * 0.62);
  }
}

/** Painted arena plate for one stage; returns false so the set takes over. */
function drawStageArt(c, w, h, stageId) {
  const img = stageImage(stageId);
  ART.stageFailed = Boolean(stageId && stageId !== 'stage_main' && ART.failed.has(stageId));
  if (!img) {
    c.fillStyle = '#0b121a';
    c.fillRect(0, 0, w, h);
    return false;
  }  const scale = w / img.naturalWidth;
  const dh = img.naturalHeight * scale;
  const dy = GROUND - dh * 0.70; // align the painted floor with the hitbox ground
  c.drawImage(img, 0, dy, w, dh);
  const veil = c.createLinearGradient(0, 0, 0, h);
  veil.addColorStop(0, 'rgba(6,11,18,.50)');
  veil.addColorStop(0.42, 'rgba(6,11,18,.08)');
  veil.addColorStop(1, 'rgba(6,11,18,.48)');
  c.fillStyle = veil;
  c.fillRect(0, 0, w, h);
  // Keep the crowd and neon from competing with the fighters: a soft vignette
  // around the play plane, strongest at the edges and absent at the floor.
  const grade = c.createRadialGradient(w / 2, GROUND - 40, 90, w / 2, GROUND - 40, w * 0.72);
  grade.addColorStop(0, 'rgba(5,10,16,0)');
  grade.addColorStop(0.55, 'rgba(4,8,14,.08)');
  grade.addColorStop(1, 'rgba(2,6,11,.48)');
  c.fillStyle = grade;
  c.fillRect(0, 0, w, h);
  return true;
}

  return {
    stageImage, artImage, repaintArt, loadStageArtwork, loadFighter,
    matchFighterIds, ensureMatchFighters, drawStageLayers, drawStageArt,
  };
}
