/**
 * Sprite animator: the read-only projection of the server's authoritative
 * fighter state onto baked frame-by-frame animation.
 *
 * The server still owns combat (skeleton, hitboxes, frame data). This module
 * only answers "which drawing, right now": it maps (state, moveId, moveFrame,
 * phase) to a clip frame, aligns the feet to the fighter's ground position and
 * mirrors by facing. Drawing changes are crisp cuts: staging the clips (hold
 * one hurt pose, body-height knockdown, staged getup) is what keeps motion
 * readable, while a blend ghosted two whole-body poses at once.
 *
 * Assets: /assets/sprites.json indexes per-fighter anim JSON; each anim JSON
 * points at five 4x4 atlases. Frames are square, feet on a fixed anchor.
 */

const INDEX_URL = '/assets/sprites.json';
// Frames of hitstun left over before the hurt drawing starts settling toward
// the stance. Combo links re-top the timer well above this, so the settle only
// ever plays on the last hit.
const HITSTUN_SETTLE = 8;
// Share of a move's recovery spent walking its own cells back down; the rest
// already plays the idle loop.
const RECOVERY_TO_IDLE = 0.75;
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

/**
 * Cell indices from the follow-through back down to the wind-up, so a recovery
 * plays the same gesture in reverse instead of standing still.
 */
function retractionToStance(followThrough) {
  const out = [];
  for (let i = followThrough; i >= 0; i -= 1) out.push(i);
  return out;
}

/** Pick the clip frame for the current authoritative fighter state. */
export function selectFrame(anim, f, globalFrame) {
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
    else {
      // The follow-through is not a pose to hold: a heavy kick's recovery runs
      // twenty frames, and freezing the extended limb then cutting to the
      // breathing stance is what read as 不连贯. Walking the move's own cells
      // back down winds the same gesture out, and the last quarter hands over
      // to the idle loop, so the move ends *inside* the stance instead of
      // cutting from a lunge to it. Still a pure function of (moveFrame,
      // recovery) — nothing to fall out of step with the hitbox phases.
      const rec = clip.phases ? clip.phases.recovery : [clip.frames.length - 1];
      prog = ph.recovery ? (f.moveFrame - m - a) / ph.recovery : 0;
      if (prog >= RECOVERY_TO_IDLE && clips.idle) return { clipId: 'idle', idx: loopIdx(clips.idle) };
      bucket = retractionToStance(rec[rec.length - 1]);
    }
    const bi = Math.min(bucket.length - 1, Math.floor(Math.max(0, Math.min(0.999, prog)) * bucket.length));
    return { clipId: f.moveId, idx: bucket[bi] };
  }
  if (state === 'knockdown') {
    const w = f.wakeup || 0;
    // Tied to the body, not to a timer: while the launch is still in the air
    // the topple drawing plays, and the floor drawing takes over the frame the
    // body lands. A timed swap put the body on the floor while it was still
    // rising, which read as the character teleporting between two poses.
    if ((f.y || 0) < -8) return { clipId: 'knockdown', idx: 0 };
    // Kneel -> crouch -> combat stance. The last drawing is the sheet's
    // otherwise unused `wakeup` cell; handing straight from the crouch to idle
    // read as a pop because the two drawings differ in height by half a body.
    if (w > 0 && w < 12 && clips.getup) {
      if (w <= 3 && clips.wakeup) return { clipId: 'wakeup', idx: 0 };
      return { clipId: 'getup', idx: w > 6 ? 0 : 1 };
    }
    return { clipId: 'knockdown', idx: 1 };
  }
  if (state === 'hitstun') {
    // One hurt drawing for the whole stun. Switching mid-stun (impact flinch
    // then stagger) re-popped the silhouette on every link of a combo, which
    // is what read as the victim convulsing; the per-hit flash marks the hit.
    // The exception is the tail of a stun nobody re-tops: settling there lets a
    // clean hit walk back to the stance instead of cutting flinch -> idle.
    const held = f.hitstun || 0;
    const settling = held > 0 && held <= HITSTUN_SETTLE && clips.hitstun.frames.length > 1;
    return { clipId: 'hitstun', idx: settling ? 1 : 0 };
  }
  if (state === 'guard' || (f.blockstun || 0) > 0) {
    if ((f.blockstun || 0) > 0 && clips.blockstun) return { clipId: 'blockstun', idx: 0 };
    return { clipId: 'guard', idx: 1 };
  }
  if (state === 'crouch') return { clipId: 'crouch', idx: 1 };
  if (state === 'jump' || (f.y || 0) < -2) {
    const clip = clips.jump;
    // Rising vs falling from vertical velocity when present, else height.
    const vy = f.vy !== undefined ? f.vy : 0;
    let idx = 1;
    if (vy < -4) idx = 1; else if (vy > 4) idx = 3; else idx = 2;
    if ((f.y || 0) > -6 && vy >= 0) idx = 3;
    return { clipId: 'jump', idx: Math.min(idx, clip.frames.length - 1) };
  }
  if (state === 'dash' && clips.dash) return { clipId: 'dash', idx: loopIdx(clips.dash) };
  if (state === 'walk') {
    const clip = clips.walk;
    const backward = (f.vx || 0) * (f.facing || 1) < 0;
    const n = clip.frames.length;
    const i = loopIdx(clip);
    return { clipId: 'walk', idx: backward ? (n - 1 - i) : i };
  }
  const idle = clips.idle;
  return { clipId: 'idle', idx: loopIdx(idle) };
}

/**
 * Draw the fighter. Two fighters may share one fighter id in a mirror match,
 * which is why every drawing decision comes from the passed-in state, never
 * from module-level fighter state.
 */
export function drawSprite(c, f, { gx, gy, globalFrame, height = 204, tint = null, alpha = 1 }) {
  const entry = loaded.get(f.fighterId);
  if (!entry || !entry.ready) return false;
  const { anim, images } = entry;
  const sel = selectFrame(anim, f, globalFrame);
  const clip = anim.clips[sel.clipId] || anim.clips.idle;
  const idx = Math.min(sel.idx, clip.frames.length - 1);
  const frame = clip.frames[idx];
  const img = images.get(clip.sheet);
  if (!frame || !img) return false;

  const k = height / (anim.stanceHeight || 200);
  const [ax, ay] = anim.anchor || [128, 248];
  const facing = f.facing || 1;
  c.save();
  c.globalAlpha = alpha;
  c.translate(gx, gy);
  c.scale(-facing * k, k); // sprites face left natively; flip to face right
  if (tint) c.filter = tint;
  // Frames are tight ink crops offset from the anchor, so a wide lunge keeps
  // its head instead of being cut by a square cell. The mirror above flips the
  // offset with the art, which is exactly what facing requires.
  c.drawImage(img, frame.x, frame.y, frame.w, frame.h, -ax + frame.ox, -ay + frame.oy, frame.w, frame.h);
  c.restore();
  return true;
}