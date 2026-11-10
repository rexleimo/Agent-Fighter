/**
 * Sprite animator: the read-only projection of the server's authoritative
 * fighter state onto baked frame-by-frame animation.
 *
 * The server still owns combat (skeleton, hitboxes, frame data). This module
 * only answers "which drawing, right now": it maps (state, moveId, moveFrame,
 * phase) to a clip frame, aligns the feet to the fighter's ground position,
 * mirrors by facing, and crossfades between drawings so motion reads smooth.
 *
 * Assets: /assets/sprites.json indexes per-fighter anim JSON; each anim JSON
 * points at five 4x4 atlases. Frames are square, feet on a fixed anchor.
 */

const INDEX_URL = '/assets/sprites.json';
const loaded = new Map();   // id -> { anim, images: Map<sheet, Image>, ready }
const pending = new Map();
let indexPromise = null;

export function loadSpriteIndex() {
  if (!indexPromise) {
    indexPromise = fetch(INDEX_URL).then((r) => (r.ok ? r.json() : { fighters: [] }))
      .catch(() => ({ fighters: [] }));
  }
  return indexPromise;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('sprite atlas failed: ' + url));
    img.src = url;
  });
}

export function ensureSprites(id) {
  if (!id || loaded.has(id) || pending.has(id)) return;
  const p = loadSpriteIndex().then(async (index) => {
    const entry = (index.fighters || []).find((f) => f.id === id);
    if (!entry) throw new Error('no sprites for ' + id);
    const anim = await fetch(entry.anim).then((r) => r.json());
    const images = new Map();
    await Promise.all(Object.entries(anim.sheets).map(async ([sheet, ref]) => {
      images.set(sheet, await loadImage(ref.atlas));
    }));
    loaded.set(id, { anim, images, ready: true });
    pending.delete(id);
  }).catch(() => { pending.delete(id); });
  pending.set(id, p);
}

export function spritesReady(id) {
  return loaded.has(id);
}

/** Pick the clip frame for the current authoritative fighter state. */
function selectFrame(anim, f, globalFrame, track) {
  const clips = anim.clips;
  const state = f.state || 'idle';
  const loopIdx = (clip) => Math.floor(globalFrame / Math.max(1, Math.round(60 / (clip.fps || 8)))) % clip.frames.length;

  if ((state === 'attack' || state === 'projectile' || state === 'special') && f.moveId && clips[f.moveId]) {
    const clip = clips[f.moveId];
    const ph = f.phase || {};
    const m = ph.startup || 0, a = ph.active || 0;
    let bucket, prog;
    if (ph.phase === 'startup') { bucket = clip.phases ? clip.phases.startup : [0]; prog = m ? f.moveFrame / m : 0; }
    else if (ph.phase === 'active') { bucket = clip.phases ? clip.phases.active : [1]; prog = a ? (f.moveFrame - m) / a : 0; }
    else { bucket = clip.phases ? clip.phases.recovery : [clip.frames.length - 1]; prog = (ph.recovery ? (f.moveFrame - m - a) / ph.recovery : 0); }
    const bi = Math.min(bucket.length - 1, Math.floor(Math.max(0, Math.min(0.999, prog)) * bucket.length));
    return { clipId: f.moveId, idx: bucket[bi], hard: ph.phase === 'active' };
  }
  if (state === 'knockdown') {
    // wakeup counts down to 0; fall -> lie -> getup as it approaches 0.
    const clip = clips.knockdown || clips.hitstun;
    const w = f.wakeup || 0;
    if (w > 0 && w < 10 && clips.getup) return { clipId: 'getup', idx: w > 5 ? 0 : 1, hard: false };
    return { clipId: 'knockdown', idx: w > 14 ? 0 : 1, hard: false };
  }
  if (state === 'hitstun') {
    // Draw the impact flinch first, then hold the stagger. Alternating the two
    // drawings every render frame (the old `hitstun % 2`) strobed the whole
    // body at 30 Hz: two different silhouettes flickering read as the
    // character popping big and small mid-combo.
    const peak = track.stunPeak || (f.hitstun || 0);
    const clip = clips.hitstun || clips.idle;
    const idx = (f.hitstun || 0) > peak * 0.5 ? 0 : Math.min(1, clip.frames.length - 1);
    return { clipId: 'hitstun', idx, hard: false };
  }
  if (state === 'guard' || (f.blockstun || 0) > 0) {
    if ((f.blockstun || 0) > 0 && clips.blockstun) return { clipId: 'blockstun', idx: 0, hard: true };
    return { clipId: 'guard', idx: 1, hard: false };
  }
  if (state === 'crouch') return { clipId: 'crouch', idx: 1, hard: false };
  if (state === 'jump' || (f.y || 0) < -2) {
    const clip = clips.jump;
    // Rising vs falling from vertical velocity when present, else height.
    const vy = f.vy !== undefined ? f.vy : 0;
    let idx = 1;
    if (vy < -4) idx = 1; else if (vy > 4) idx = 3; else idx = 2;
    if ((f.y || 0) > -6 && vy >= 0) idx = 3;
    return { clipId: 'jump', idx: Math.min(idx, clip.frames.length - 1), hard: false };
  }
  if (state === 'dash' && clips.dash) return { clipId: 'dash', idx: loopIdx(clips.dash), hard: false };
  if (state === 'walk') {
    const clip = clips.walk;
    const backward = (f.vx || 0) * (f.facing || 1) < 0;
    const n = clip.frames.length;
    const i = loopIdx(clip);
    return { clipId: 'walk', idx: backward ? (n - 1 - i) : i, hard: false };
  }
  const idle = clips.idle;
  return { clipId: 'idle', idx: loopIdx(idle), hard: false };
}

/**
 * Draw the fighter. `track` is mutable per-side state (two fighters may share
 * one fighter id in a mirror match, so animation state cannot live per id).
 */
export function drawSprite(c, f, { gx, gy, globalFrame, track, height = 204, tint = null, alpha = 1 }) {
  const entry = loaded.get(f.fighterId);
  if (!entry || !entry.ready) return false;
  const { anim, images } = entry;
  const sel = selectFrame(anim, f, globalFrame, track);
  const clip = anim.clips[sel.clipId] || anim.clips.idle;
  const idx = Math.min(sel.idx, clip.frames.length - 1);
  const frame = clip.frames[idx];
  const img = images.get(clip.sheet);
  if (!frame || !img) return false;

  // Crossfade on drawing changes (except hard impact cuts) for smooth motion.
  // The fade source is remembered across frames so the blend spans FADE_FRAMES
  // rather than collapsing to a single hold-then-jump frame.
  const FADE_FRAMES = 3;
  if (track.clipId !== sel.clipId || track.idx !== idx) {
    track.fromClip = track.clipId;
    track.fromIdx = track.idx;
    track.changedAt = globalFrame;
    track.clipId = sel.clipId;
    track.idx = idx;
  }
  let prevFrame = null, blend = 1;
  if (!sel.hard && track.fromIdx !== undefined && track.fromClip === sel.clipId) {
    const t = (globalFrame - (track.changedAt || globalFrame)) / FADE_FRAMES;
    if (t < 1) {
      prevFrame = clip.frames[Math.min(track.fromIdx, clip.frames.length - 1)];
      blend = Math.max(0, t);
    }
  }

  const k = height / (anim.stanceHeight || 200);
  const [ax, ay] = anim.anchor || [128, 248];
  const facing = f.facing || 1;
  c.save();
  c.globalAlpha = alpha;
  c.translate(gx, gy);
  c.scale(-facing * k, k); // sprites face left natively; flip to face right
  if (tint) c.filter = tint;
  const draw = (fr, a) => {
    if (!fr) return;
    c.globalAlpha = alpha * a;
    c.drawImage(img, fr.x, fr.y, fr.w, fr.h, -ax, -ay, anim.frame, anim.frame);
  };
  if (prevFrame) draw(prevFrame, 1 - blend);
  draw(frame, prevFrame ? blend : 1);
  c.restore();
  return true;
}