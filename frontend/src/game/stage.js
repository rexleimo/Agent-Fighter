/**
 * Imperative canvas renderer extracted from the legacy app. React owns the
 * page and HUD; this module only paints the authoritative frame into a canvas.
 *
 * NOTE: this is intentionally a straight extraction (~1000 lines). It has one
 * responsibility (frame -> pixels), but it is over the normal file budget.
 * Splitting pose / geometry / fx into separate modules is a follow-up.
 */
import { loadRig, drawRig } from '@web/rig.js';
import { drawSprite, ensureSprites, spritesReady } from '@web/sprite.js';
import { createFx } from '@web/fx.js';
import { createImpactFx } from '@web/impact-fx.js';
import { loadFighterArt, loadStageArt, preloadFighters } from '@web/asset-store.js';
import { play as playSound } from '@web/audio.js';

const GROUND = 440;
const COLOR_A = '#35d6a4';
const COLOR_B = '#5b8cff';
const ACTION_LABEL = {
  idle: '待机', walk_f: '前走', walk_b: '后撤', jump: '跳跃', crouch: '蹲防', block: '站防', throw: '投技',
  lp: '轻拳', mp: '中拳', hp: '重拳', lk: '轻脚', mk: '中脚', hk: '重脚', dp: '升龙', fireball: '波动',
  dash: '前冲', special: '专属技', ex: 'EX 强化', super: '超必杀',
};
const EVENT_LABEL = {
  hit: '命中', block: '防御', spawn: '发出波动', ko: 'KO', time_up: '时间到',
  cancel: '取消连段', super_start: '超必杀发动', armor: '霸体吸收', wakeup: '起身',
  move_start: '出招', hitstop: '命中停顿',
};
const PHASE_LABEL = { startup: '起手', active: '判定', recovery: '收招', none: '可行动' };
const REASON_LABEL = { ko: 'KO', time_up: '时间到', elimination: '全队淘汰' };

export function createStageRenderer({ view, stageCanvas, replayCanvas }) {
  const S = view;
  const label = (a) => ACTION_LABEL[a] || (S.moves[a] && S.moves[a].label) || a;
  const fxLabel = (side, moveId, match) => (
    ['special', 'ex', 'super'].includes(moveId) ? skillName(side, moveId, match) : label(moveId)
  );
  const stageFx = createFx({ colors: { a: COLOR_A, b: COLOR_B }, labelFor: fxLabel });
  const replayFx = createFx({ colors: { a: COLOR_A, b: COLOR_B }, labelFor: fxLabel });
  const impactFx = {
    stage: createImpactFx({ labelFor: fxLabel, plainLabel: label, onSound: playSound, enabled: () => S.showFx, ground: GROUND }),
    replay: createImpactFx({ labelFor: fxLabel, plainLabel: label, onSound: null, enabled: () => S.showFx, ground: GROUND }),
  };

/* ---------------------------------------------------------------- canvas */
function lerp(a, b, t) { return a + (b - a) * t; }

function poseFor(f) {
  const t = f.moveId && S.moves[f.moveId] ? Math.min(1, f.moveFrame / Math.max(1, S.moves[f.moveId].startup + S.moves[f.moveId].active)) : 0;
  const swing = Math.sin(Math.min(1, t) * Math.PI);
  const walk = Math.sin(f.state === 'walk' ? (f.x / 12) : 0) * 9;
  const p = {
    hip: [0, -44], chest: [0, -80], head: [0, -102],
    elbowF: [12, -66], handF: [26, -58],
    elbowB: [-12, -64], handB: [-22, -56],
    kneeF: [10, -22], footF: [16 + walk, 0],
    kneeB: [-9, -22], footB: [-16 - walk, 0],
  };
  if (f.state === 'crouch') {
    for (const k of Object.keys(p)) p[k][1] *= 0.68;
    p.footF = [22, 0]; p.footB = [-18, 0];
  } else if (f.state === 'jump' || f.y < 0) {
    p.kneeF = [16, -34]; p.footF = [22, -22];
    p.kneeB = [-12, -34]; p.footB = [-18, -20];
  } else if (f.state === 'guard' || f.blockstun > 0) {
    p.elbowF = [16, -74]; p.handF = [24, -86];
    p.elbowB = [-4, -70]; p.handB = [14, -70];
  } else if (f.state === 'hitstun') {
    p.chest = [-10, -78]; p.head = [-16, -98];
    p.handF = [-6, -50]; p.handB = [-30, -48];
  } else if (f.state === 'attack' || f.state === 'projectile') {
    const m = S.moves[f.moveId] || {};
    if (f.moveId === 'dp') {
      p.handF = [16 + 12 * swing, -128 + 8 * swing];
      p.elbowF = [10 + 6 * swing, -104];
      p.footF = [20, -16];
    } else if (f.moveId === 'fireball') {
      p.elbowF = [18 + 10 * swing, -72]; p.handF = [34 + 16 * swing, -70];
      p.elbowB = [2, -70]; p.handB = [22 + 12 * swing, -66];
    } else if (f.moveId === 'throw') {
      p.handF = [30 + 16 * swing, -76]; p.handB = [22 + 14 * swing, -72];
    } else if (['lk', 'mk', 'hk'].includes(f.moveId)) {
      p.kneeF = [22 + 16 * swing, -40]; p.footF = [34 + 46 * swing, -48 + 8 * swing];
    } else {
      p.elbowF = [16 + 8 * swing, -76]; p.handF = [30 + 52 * swing, -78 + 4 * swing];
      p.handB = [-14, -62];
    }
    if (m.startup && f.moveFrame < m.startup) {
      p.handF = [18, -72]; p.elbowF = [10, -70];
      p.footF = [16, 0];
    }
  }
  return p;
}

function line(c, a, b, width, color, outline) {
  c.lineCap = 'round';
  c.lineJoin = 'round';
  if (outline) {
    c.strokeStyle = '#0a1017';
    c.lineWidth = width + 4;
    c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
  }
  c.strokeStyle = color;
  c.lineWidth = width;
  c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
}

/* --- Painted art layer ---------------------------------------------------
 * Original generated illustrations are composited over a painted stage plate.
 * The procedural geometry below stays as a zero-dependency fallback while
 * images load (or if an asset is missing), so the site never shows an empty
 * arena. All art is 100% original: no SNK / KOF assets are used.
 * ------------------------------------------------------------------------ */
const ART = {
  images: Object.create(null),
  rigs: Object.create(null),
  rigPending: new Set(),
  stage: null,
  failed: new Set(),
  wanted: new Set(),
};

function artImage(id) {
  const img = ART.images[id];
  return img && img.complete && img.naturalWidth > 0 ? img : null;
}

function repaintArt() {
  if (S.current) draw(ctx, S.current, S.match, stageCanvas);
}

function loadStageArtwork() {
  if (ART.stage) return;
  loadStageArt().then((img) => {
    ART.stage = img;
    repaintArt();
  }).catch(() => ART.failed.add('stage'));
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

/** Painted stadium plate; returns false so the procedural set takes over. */
function drawStageArt(c, w, h) {
  const img = ART.stage;
  if (!img || !img.complete || !img.naturalWidth) {
    c.fillStyle = '#0b121a';
    c.fillRect(0, 0, w, h);
    return false;
  }
  const scale = w / img.naturalWidth;
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

function blitFighter(c, img, gx, gy, W, H, dir, sx, sy, lean, bob) {
  c.translate(gx, gy + bob);
  c.rotate(lean);
  c.scale(dir * sx, sy);
  c.drawImage(img, -W / 2, -H + 6, W, H);
}
/**
 * Skeleton-driven cutout puppet. Every body part the bake step produced is
 * rotated by the same angular delta the kernel applied to that limb, so the
 * painted fighter performs the move the server actually resolved.
 * There is no client-side animation state machine here: this is a projection.
 */
const RIG_STATES = { knockdown: true };

function rigLocalJoints(f, sk) {
  const local = {};
  for (const [k, v] of Object.entries(sk.joints)) local[k] = [(v[0] - f.x) * (f.facing || 1), v[1] - f.y];
  return local;
}

function ensureRig(id) {
  if (ART.rigs[id] || ART.rigPending.has(id) || !id) return;
  ART.rigPending.add(id);
  loadRig(id).then((rig) => {
    ART.rigs[id] = rig;
    repaintArt();
  }).catch(() => {
    ART.rigPending.delete(id);
    ART.failed.add('rig:' + id);
  });
}

function drawSpriteBody(c, img, o) {
  const { f, def, pal, dir, gx, gy } = o;
  const rig = ART.rigs[def.id];
  const H = 204;
  const W = img
    ? H * (img.naturalWidth / img.naturalHeight)
    : rig
      ? H * (rig.box.w / rig.box.h)
      : H * 0.55;
  const state = f.state || 'idle';
  const acting = state === 'attack' || state === 'projectile' || state === 'special';
  const m = S.moves[f.moveId];
  const active = Boolean(m && acting && f.moveFrame >= m.startup && f.moveFrame < m.startup + m.active);
  let sx = 1, sy = 1, lean = 0, bob = 0, flashing = false;
  const track = (S.spriteTrack[o.side] = S.spriteTrack[o.side] || {});
  if (state === 'hitstun') {
    const hs = f.hitstun || 0;
    // Every new hit restarts the stun counter upward: flash its first three
    // render frames. The old `hitstun % 7 < 2` lit the body eight times a
    // second for the whole stun, which read as a strobe artifact on top of the
    // pose flicker rather than a hit.
    if (hs > (track.prevHitstun || 0)) track.flashLeft = 3;
    track.prevHitstun = hs;
  } else {
    track.prevHitstun = 0;
    track.flashLeft = 0;
  }
  if (state === 'walk' || state === 'dash') bob = Math.sin(((S.current && S.current.frame) || 0) * 0.24) * 2.2;
  if (f.y < -2) bob = -2;
  if (state === 'hitstun' && (track.flashLeft || 0) > 0) {
    flashing = true;
    track.flashLeft -= 1;
  }
  if (state === 'knockdown') { lean = -1.12 * dir; bob = 10; }

  c.save();
  const glow = c.createRadialGradient(gx, gy - 82, 8, gx, gy - 82, W * 0.7);
  glow.addColorStop(0, pal.aura || 'rgba(140,180,220,.16)');
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = glow;
  c.beginPath(); c.ellipse(gx, gy - 82, W * 0.7, H * 0.58, 0, 0, Math.PI * 2); c.fill();
  c.restore();

  const globalFrame = (S.current && S.current.frame) || 0;
  // A dark rim keeps the silhouette readable against bright baked effects and
  // the stage lights; without it a white-palette fighter merges into the glow.
  const rim = 'drop-shadow(0 0 1.5px rgba(6,10,18,.8))';
  if (spritesReady(def.id)) {
    // Frame-by-frame sprite animation: the server state selects the drawing.
    const filters = [rim];
    if (flashing) filters.push('saturate(1.45)', 'brightness(1.12)', 'contrast(1.06)');
    if (o.side === 'b') filters.push('hue-rotate(-14deg)', 'saturate(1.06)', 'brightness(0.97)');
    const tint = filters.join(' ');
    if (active) {
      // Motion ghost: dark and saturated. A brightened ghost is a white smear
      // that erases the pose it is supposed to repeat.
      drawSprite(c, f, { gx: gx - 14 * dir, gy, globalFrame, height: H, alpha: 0.18, tint: 'saturate(1.7) brightness(0.72)' });
    }
    drawSprite(c, f, { gx, gy, globalFrame, height: H, tint });
  } else {
  const sk = f.skeleton;
  const rigid = RIG_STATES[state] || !sk;
  const local = sk && !rigid ? rigLocalJoints(f, sk) : {};
  const delta = sk && !rigid ? sk.delta || {} : {};

  if (active && rig) {
    c.save();
    c.globalAlpha = 0.18;
    c.filter = 'saturate(1.7) brightness(0.72)';
    drawRig(c, rig, { H, x: gx - 18 * dir, y: gy, dir, squashX: sx, squashY: sy, lean, bob, localJoints: local, delta });
    c.restore();
  }

  c.save();
  const filters = [rim];
  if (flashing) filters.push('saturate(1.45)', 'brightness(1.12)', 'contrast(1.06)');
  if (o.side === 'b') filters.push('hue-rotate(-14deg)', 'saturate(1.06)', 'brightness(0.97)', 'drop-shadow(0 0 5px rgba(91,140,255,.7))');
  c.filter = filters.join(' ');
  if (rig) {
    drawRig(c, rig, { H, x: gx, y: gy, dir, squashX: sx, squashY: sy, lean, bob, localJoints: local, delta });
  } else {
    // Still loading (or no rig baked for this id): draw the plate whole.
    blitFighter(c, img, gx, gy, W, H, dir, sx, sy, lean, bob);
  }
  c.restore();
  }

  if (f.counterWindow > 0) {
    // 当身 stance: a live window the opponent can read, and the only pose in
    // the game that punishes a blocked-hit guess.
    c.save();
    c.globalAlpha = 0.85;
    c.strokeStyle = pal.accent;
    c.lineWidth = 2.5;
    c.beginPath(); c.arc(gx + 10 * dir, gy - 108, 52, -1.5, 1.5); c.stroke();
    c.globalAlpha = 0.35;
    c.fillStyle = pal.light;
    c.beginPath(); c.arc(gx + 10 * dir, gy - 108, 52, -1.5, 1.5); c.fill();
    c.restore();
  }
  if (state === 'guard' || f.blockstun > 0) {
    c.save();
    c.strokeStyle = 'rgba(150,205,255,.55)';
    c.lineWidth = 2;
    c.beginPath(); c.arc(gx + 16 * dir, gy - 88, 46, -1.1, 1.1); c.stroke();
    c.restore();
  }
  if (f.armorLeft > 0) {
    c.save();
    c.strokeStyle = 'rgba(255,200,90,.8)';
    c.lineWidth = 2;
    c.beginPath(); c.ellipse(gx, gy - 92, W * 0.38, H * 0.52, 0, 0, Math.PI * 2); c.stroke();
    c.restore();
  }
}


const FALLBACK_FIGHTER = {
  palette: { base: '#c8d6e2', shade: '#5a7288', light: '#ffffff', accent: '#8fe6ff', aura: 'rgba(190,220,240,.16)' },
  build: { shoulder: 1, torso: 1, head: 1, limb: 1, bulk: 1 },
  gear: { head: 'visor', shoulder: 'plate', back: 'none', weapon: 'none' },
  signature: { shape: 'shard' },
};

function fighterDef(side, match) {
  const seat = (match && (side === 'a' ? match.a : match.b)) || {};
  // Live rooms carry a full fighter brief; a recorded match only carries the
  // fighter id, so both shapes have to resolve to the same roster entry.
  const id = (seat.fighter && seat.fighter.id)
    || seat.fighterId
    || (match && match.fighters && match.fighters[side]);
  return (id && S.fighters.find((x) => x.id === id))
    || S.fighters.find((x) => x.id === 'quartz')
    || FALLBACK_FIGHTER;
}

function poly(c, pts, fill, stroke, lw = 1) {
  c.beginPath();
  c.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i += 1) c.lineTo(pts[i][0], pts[i][1]);
  c.closePath();
  if (fill) { c.fillStyle = fill; c.fill(); }
  if (stroke) { c.strokeStyle = stroke; c.lineWidth = lw; c.stroke(); }
}

function drawSignature(c, shape, x, y, dir, pal, phase) {
  c.save();
  c.translate(x, y);
  c.scale(dir, 1);
  c.globalAlpha = 0.72;
  c.strokeStyle = pal.light;
  c.fillStyle = pal.accent;
  c.lineWidth = 2;
  const r = 22 + phase * 2;
  switch (shape) {
    case 'wave':
      for (let i = 0; i < 3; i += 1) {
        c.beginPath(); c.arc(0, 0, r + i * 9, -0.9, 0.9); c.stroke();
      }
      break;
    case 'burst':
      for (let i = 0; i < 8; i += 1) {
        const a = (i / 8) * Math.PI * 2;
        line(c, [Math.cos(a) * 10, Math.sin(a) * 10], [Math.cos(a) * (r + 12), Math.sin(a) * (r + 12)], 2, pal.accent, true);
      }
      break;
    case 'crescent':
      c.beginPath(); c.arc(0, 0, r + 6, -1.15, 1.15); c.arc(0, 0, r - 6, 1.15, -1.15, true); c.fill();
      break;
    case 'bolt':
      c.beginPath(); c.moveTo(0, -r); c.lineTo(-8, 2); c.lineTo(3, -2); c.lineTo(-4, r); c.lineTo(12, -6); c.lineTo(1, -4); c.closePath(); c.fill();
      break;
    case 'ring':
      c.beginPath(); c.arc(0, 0, r, 0, Math.PI * 2); c.stroke();
      c.beginPath(); c.arc(0, 0, r - 8, 0, Math.PI * 2); c.stroke();
      break;
    default:
      poly(c, [[0, -r], [r * 0.7, 0], [0, r], [r * 0.2, 0]], pal.accent, pal.light, 1);
  }
  c.restore();
}

/**
 * The debug overlay is now REAL: these are the exact world-space rectangles
 * the kernel used to resolve this frame, plus the 15-joint skeleton they were
 * built from. Nothing here is computed or guessed on the client.
 */
function drawFrameGeometry(c, f, side) {
  const boxes = f.boxes;
  const sk = f.skeleton;
  if (!boxes || !sk) return;
  c.save();
  c.lineJoin = 'round';
  c.font = '9px ui-monospace, monospace';
  c.textAlign = 'left';

  if (S.showBoxes && boxes.push) {
    const b = boxes.push;
    c.strokeStyle = 'rgba(142,163,184,.55)';
    c.lineWidth = 1;
    c.setLineDash([3, 4]);
    c.strokeRect(b.x, GROUND + b.y, b.w, b.h);
    c.setLineDash([]);
  }
  if (S.showBoxes) {
    for (const b of boxes.hurt || []) {
      c.strokeStyle = 'rgba(56,217,192,.72)';
      c.fillStyle = 'rgba(56,217,192,.055)';
      c.lineWidth = 1.2;
      c.fillRect(b.x, GROUND + b.y, b.w, b.h);
      c.strokeRect(b.x, GROUND + b.y, b.w, b.h);
    }
    for (const b of boxes.hit || []) {
      c.strokeStyle = '#ff5d6c';
      c.fillStyle = 'rgba(255,93,108,.20)';
      c.lineWidth = 2;
      c.fillRect(b.x, GROUND + b.y, b.w, b.h);
      c.strokeRect(b.x, GROUND + b.y, b.w, b.h);
      const t = (b.height || '').toUpperCase() + ' · ' + b.damage;
      c.font = '700 10px ui-monospace, monospace';
      c.lineWidth = 3;
      c.strokeStyle = 'rgba(8,14,22,.9)';
      c.strokeText(t, b.x + 3, GROUND + b.y - 5);
      c.fillStyle = '#ffd7dc';
      c.fillText(t, b.x + 3, GROUND + b.y - 5);
    }
  }
  if (S.showBones) {
    // A/B use different bone colours so two overlapping mirrored fighters
    // stay readable as two separate skeletons.
    const warm = side === 'a';
    c.strokeStyle = warm ? 'rgba(255,209,102,.62)' : 'rgba(130,185,255,.58)';
    c.lineWidth = 1.3;
    for (const [x1, y1, x2, y2] of sk.bones) {
      c.beginPath();
      c.moveTo(x1, GROUND + y1);
      c.lineTo(x2, GROUND + y2);
      c.stroke();
    }
    for (const [k, v] of Object.entries(sk.joints)) {
      c.beginPath();
      c.arc(v[0], GROUND + v[1], k === 'head' ? 2.8 : 1.7, 0, Math.PI * 2);
      c.fillStyle = warm ? (k === 'handF' || k === 'footF' ? '#ff9f6b' : '#ffe1a2')
        : (k === 'handF' || k === 'footF' ? '#9fd0ff' : '#cfe6ff');
      c.fill();
    }
  }
  c.restore();
}

function drawFighter(c, f, side, frame, match) {
  const def = fighterDef(side, match);
  const pal = def.palette;
  const B = def.build || FALLBACK_FIGHTER.build;
  const G = def.gear || FALLBACK_FIGHTER.gear;
  const dir = f.facing || 1;
  const gx = f.x;
  const gy = GROUND + f.y;
  const p = poseFor(f);
  const sk = f.skeleton;
  // Joints come from the server's authoritative skeleton when available.
  // The procedural pose is only a fallback for pre-v2 replay data.
  const P = (k) => (sk && sk.joints && sk.joints[k]
    ? [sk.joints[k][0], GROUND + sk.joints[k][1]]
    : [gx + p[k][0] * dir, gy + p[k][1]]);
  const hip = P('hip'), chest = P('chest'), head = P('head');
  const elbowF = P('elbowF'), handF = P('handF'), elbowB = P('elbowB'), handB = P('handB');
  const kneeF = P('kneeF'), footF = P('footF'), kneeB = P('kneeB'), footB = P('footB');
  const bulk = B.bulk || 1;
  const sw = 11 * (B.shoulder || 1);
  const sideColor = side === 'a' ? '#35d6a4' : '#5b8cff';

  // Ground shadow + fighter aura. With painted art the solid aura ellipse
  // would show as a coloured block behind the illustration, so use a thin
  // side-colour outline instead.
  const sprite = artImage(def.id);
  ensureRig(def.id);
  ensureSprites(def.id);
  c.save();
  if (sprite) {
    const sh = c.createRadialGradient(gx, GROUND + 2, 2, gx, GROUND + 2, 54 * bulk);
    sh.addColorStop(0, 'rgba(0,0,0,.62)');
    sh.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = sh;
    c.beginPath(); c.ellipse(gx, GROUND + 3, 54 * bulk, 11, 0, 0, Math.PI * 2); c.fill();
  } else {
    c.globalAlpha = 0.28; c.fillStyle = '#000';
    c.beginPath(); c.ellipse(gx, GROUND + 3, 30 * bulk, 6, 0, 0, Math.PI * 2); c.fill();
  }
  c.restore();
  c.save();
  if (sprite) {
    const light = c.createRadialGradient(gx, gy - 80, 8, gx, gy - 80, 86 * bulk);
    light.addColorStop(0, side === 'a' ? 'rgba(53,214,164,.12)' : 'rgba(91,140,255,.12)');
    light.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = light;
    c.beginPath(); c.ellipse(gx, gy - 80, 86 * bulk, 104, 0, 0, Math.PI * 2); c.fill();
    c.globalAlpha = 0.14; c.strokeStyle = sideColor; c.lineWidth = 1.2;
    c.beginPath(); c.ellipse(gx, gy - 94, 45 * bulk, 96, 0, 0, Math.PI * 2); c.stroke();
  } else {
    c.fillStyle = pal.aura || 'rgba(140,180,220,.12)';
    c.beginPath(); c.ellipse(gx, gy - 54, 40 * bulk, 62, 0, 0, Math.PI * 2); c.fill();
    c.globalAlpha = 0.32; c.strokeStyle = sideColor; c.lineWidth = 1.5; c.stroke();
  }
  c.restore();

  if (sprite || ART.rigs[def.id] || spritesReady(def.id)) {
    drawSpriteBody(c, sprite, { f, def, pal, dir, gx, gy, side, sideColor, handF, bulk });
  } else {
  // Procedural fallback: used only while art loads or for an unknown id.
  // Back gear
  if (G.back === 'cape' || G.back === 'banner') {
    poly(c, [
      [chest[0] - 10 * dir, chest[1] - 12], [chest[0] + 10 * dir, chest[1] - 12],
      [chest[0] + 26 * dir, gy - 6], [chest[0] - 22 * dir, gy - 6],
    ], pal.shade, pal.light, 1);
  } else if (G.back === 'wing') {
    poly(c, [[chest[0], chest[1] - 14], [chest[0] - 34 * dir, chest[1] - 42], [chest[0] - 22 * dir, chest[1] - 2]], pal.light, pal.base, 1);
  }

  // Rear limbs
  const back = pal.shade;
  line(c, hip, kneeB, 9 * B.limb * bulk, back, true);
  line(c, kneeB, footB, 8 * B.limb * bulk, back, true);
  line(c, chest, elbowB, 7 * B.limb * bulk, back, true);
  line(c, elbowB, handB, 6 * B.limb * bulk, back, true);

  // Torso as an armoured shape, not a stick
  poly(c, [
    [hip[0] - 10 * bulk, hip[1] + 4], [hip[0] + 10 * bulk, hip[1] + 4],
    [chest[0] + sw, chest[1] - 6], [chest[0] - sw, chest[1] - 6],
  ], pal.base, pal.light, 1.4);
  poly(c, [
    [chest[0] - sw * 0.6, chest[1] - 12], [chest[0] + sw * 0.6, chest[1] - 12],
    [chest[0] + sw * 0.35, chest[1] + 16], [chest[0] - sw * 0.35, chest[1] + 16],
  ], pal.shade, null);
  c.fillStyle = pal.accent;
  c.fillRect(chest[0] - 3, chest[1] - 2, 6, 6);

  // Front limbs
  line(c, hip, kneeF, 10 * B.limb * bulk, pal.base, true);
  line(c, kneeF, footF, 9 * B.limb * bulk, pal.light, true);
  line(c, chest, elbowF, 8 * B.limb * bulk, pal.base, true);
  line(c, elbowF, handF, 7 * B.limb * bulk, pal.light, true);

  // Shoulder armour
  const sh = [chest[0] + sw * 0.72 * dir, chest[1] - 6];
  if (G.shoulder === 'spike') {
    poly(c, [[sh[0] - 9, sh[1] - 7], [sh[0] + 14 * dir, sh[1] - 18], [sh[0] + 9, sh[1] + 8]], pal.accent, pal.light, 1);
  } else if (G.shoulder === 'plate') {
    c.fillStyle = pal.light;
    c.beginPath(); c.ellipse(sh[0], sh[1], 11 * bulk, 7, 0, 0, Math.PI * 2); c.fill();
    c.strokeStyle = pal.shade; c.lineWidth = 1; c.stroke();
  } else if (G.shoulder === 'cloth') {
    poly(c, [[sh[0] - 8, sh[1] - 6], [sh[0] + 8, sh[1] - 6], [sh[0] + 6, sh[1] + 12], [sh[0] - 6, sh[1] + 10]], pal.shade, pal.light, 1);
  }

  // Head + headgear
  const hr = 12 * (B.head || 1);
  c.fillStyle = '#0a1017';
  c.beginPath(); c.arc(head[0], head[1], hr + 3, 0, Math.PI * 2); c.fill();
  c.fillStyle = pal.base;
  c.beginPath(); c.arc(head[0], head[1], hr, 0, Math.PI * 2); c.fill();
  c.fillStyle = pal.shade;
  c.beginPath(); c.arc(head[0] + 3 * dir, head[1], hr * 0.62, 0, Math.PI * 2); c.fill();
  c.fillStyle = pal.accent;
  c.fillRect(head[0] + 1 * dir, head[1] - 2, 5 * dir, 3);
  if (G.head === 'crest') {
    poly(c, [[head[0] - 8, head[1] - hr], [head[0] - 2, head[1] - hr - 16], [head[0] + 8, head[1] - hr - 6], [head[0] + 9, head[1] - hr]], pal.accent, pal.light, 1);
  } else if (G.head === 'horn') {
    poly(c, [[head[0] - 9, head[1] - hr + 2], [head[0] - 16, head[1] - hr - 12], [head[0] - 2, head[1] - hr - 4]], pal.light, null);
    poly(c, [[head[0] + 9, head[1] - hr + 2], [head[0] + 16, head[1] - hr - 12], [head[0] + 2, head[1] - hr - 4]], pal.light, null);
  } else if (G.head === 'hood') {
    poly(c, [[head[0] - hr - 3, head[1] + 4], [head[0] - 4, head[1] - hr - 7], [head[0] + hr + 3, head[1] + 2]], pal.shade, pal.light, 1);
  } else if (G.head === 'visor') {
    c.fillStyle = pal.light;
    c.fillRect(head[0] - hr, head[1] - 3, hr * 2, 5);
  } else if (G.head === 'halo') {
    c.strokeStyle = pal.accent; c.lineWidth = 2;
    c.beginPath(); c.arc(head[0], head[1] - hr - 9, 11, 0, Math.PI * 2); c.stroke();
  }

  // Weapon held in the front hand
  if (G.weapon === 'blade') {
    line(c, handF, [handF[0] + 30 * dir, handF[1] - 22], 3, pal.light, true);
  } else if (G.weapon === 'staff') {
    line(c, [handF[0], handF[1] - 24], [handF[0], handF[1] + 34], 4, pal.shade, true);
    c.fillStyle = pal.accent;
    c.beginPath(); c.arc(handF[0], handF[1] - 27, 7, 0, Math.PI * 2); c.fill();
  } else if (G.weapon === 'gauntlet') {
    c.fillStyle = pal.accent;
    c.beginPath(); c.arc(handF[0], handF[1], 9 * bulk, 0, Math.PI * 2); c.fill();
    c.strokeStyle = pal.light; c.lineWidth = 1.5; c.stroke();
  }

  } // end procedural fallback

  // Active-frame signature effect
  const m = S.moves[f.moveId];
  const active = m && (f.state === 'attack' || f.state === 'projectile') && f.moveFrame >= m.startup && f.moveFrame < m.startup + m.active;
  if (active) {
    drawSignature(c, (def.signature && def.signature.shape) || 'shard', handF[0] + 20 * dir, handF[1], dir, pal, f.moveFrame - m.startup);
  }

  drawFrameGeometry(c, f, side);

  // Side marker on the floor so mirrored fighters stay distinguishable.
  c.strokeStyle = sideColor; c.lineWidth = 2; c.globalAlpha = 0.8;
  c.beginPath(); c.ellipse(gx, GROUND + 2, 20 * bulk, 4, 0, 0, Math.PI * 2); c.stroke();
  c.globalAlpha = 1;
  c.textAlign = 'center';
  c.lineJoin = 'round';
  c.lineWidth = 3;
  c.strokeStyle = 'rgba(11,18,26,.92)';
  const tagY = gy - (sprite ? 206 : 134);
  const comboY = gy - (sprite ? 228 : 155);
  const sideMeta = match && match[side];
  const agentName = sideMeta && sideMeta.name ? sideMeta.name : '';
  const tag = (agentName ? agentName + ' · ' : '') + (def.code || 'UNIT') + (f.moveId ? ' / ' + label(f.moveId) : '');
  c.font = '600 10px ui-monospace, monospace';
  const tw = c.measureText(tag).width;
  c.fillStyle = 'rgba(8,14,22,.62)';
  c.fillRect(gx - tw / 2 - 5, tagY - 10, tw + 10, 14);
  c.strokeText(tag, gx, tagY);
  c.fillStyle = sideColor;
  c.fillText(tag, gx, tagY);
  if (f.combo > 1) {
    c.font = '600 14px ui-monospace, monospace';
    c.strokeText(f.combo + ' HIT', gx, comboY);
    c.fillStyle = '#ffc260';
    c.fillText(f.combo + ' HIT', gx, comboY);
  }
}

/** Stylised bust for the fighter gallery. */
function drawPortrait(c, f, w, h) {
  const pal = f.palette;
  const G = f.gear || {};
  const cx = w / 2;
  const cy = h * 0.62;
  c.clearRect(0, 0, w, h);
  c.fillStyle = '#111a24'; c.fillRect(0, 0, w, h);
  c.strokeStyle = 'rgba(140,170,200,.09)'; c.lineWidth = 1;
  for (let x = 0; x < w; x += 20) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
  for (let y = 0; y < h; y += 20) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
  c.fillStyle = pal.aura || 'rgba(140,180,220,.12)';
  c.beginPath(); c.arc(cx, cy, 66, 0, Math.PI * 2); c.fill();
  if (G.back === 'cape' || G.back === 'banner') {
    poly(c, [[cx - 38, cy - 26], [cx + 38, cy - 26], [cx + 62, h], [cx - 62, h]], pal.shade, pal.light, 1);
  } else if (G.back === 'wing') {
    poly(c, [[cx, cy - 30], [cx - 78, cy - 62], [cx - 46, h]], pal.light, pal.base, 1);
    poly(c, [[cx, cy - 30], [cx + 78, cy - 62], [cx + 46, h]], pal.light, pal.base, 1);
  }
  poly(c, [[cx - 30, cy], [cx + 30, cy], [cx + 52, h], [cx - 52, h]], pal.base, pal.light, 1.5);
  poly(c, [[cx - 18, cy + 4], [cx + 18, cy + 4], [cx + 12, cy + 46], [cx - 12, cy + 46]], pal.shade, null);
  c.fillStyle = pal.accent; c.fillRect(cx - 4, cy + 14, 8, 8);
  const hr = 22;
  c.fillStyle = '#0a1017'; c.beginPath(); c.arc(cx, cy - 46, hr + 4, 0, Math.PI * 2); c.fill();
  c.fillStyle = pal.base; c.beginPath(); c.arc(cx, cy - 46, hr, 0, Math.PI * 2); c.fill();
  c.fillStyle = pal.shade; c.beginPath(); c.arc(cx + 5, cy - 46, hr * 0.62, 0, Math.PI * 2); c.fill();
  c.fillStyle = pal.accent; c.fillRect(cx + 2, cy - 48, 10, 4);
  if (G.head === 'crest') poly(c, [[cx - 14, cy - 62], [cx - 4, cy - 92], [cx + 14, cy - 68], [cx + 16, cy - 60]], pal.accent, pal.light, 1);
  else if (G.head === 'horn') { poly(c, [[cx - 18, cy - 58], [cx - 30, cy - 88], [cx - 4, cy - 66]], pal.light, null); poly(c, [[cx + 18, cy - 58], [cx + 30, cy - 88], [cx + 4, cy - 66]], pal.light, null); }
  else if (G.head === 'hood') poly(c, [[cx - 28, cy - 36], [cx - 8, cy - 76], [cx + 28, cy - 38]], pal.shade, pal.light, 1);
  else if (G.head === 'visor') { c.fillStyle = pal.light; c.fillRect(cx - hr, cy - 49, hr * 2, 6); }
  else if (G.head === 'halo') { c.strokeStyle = pal.accent; c.lineWidth = 3; c.beginPath(); c.arc(cx, cy - 74, 17, 0, Math.PI * 2); c.stroke(); }
  if (G.shoulder === 'spike') {
    poly(c, [[cx - 48, cy - 2], [cx - 70, cy - 30], [cx - 30, cy - 12]], pal.accent, pal.light, 1);
    poly(c, [[cx + 48, cy - 2], [cx + 70, cy - 30], [cx + 30, cy - 12]], pal.accent, pal.light, 1);
  } else if (G.shoulder === 'plate') {
    c.fillStyle = pal.light;
    c.beginPath(); c.ellipse(cx - 36, cy - 4, 18, 10, 0, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.ellipse(cx + 36, cy - 4, 18, 10, 0, 0, Math.PI * 2); c.fill();
  }
  c.font = '10px ui-monospace, monospace'; c.fillStyle = 'rgba(231,238,246,.4)'; c.textAlign = 'left';
  c.fillText('UNIT / ' + f.code, 10, h - 10);
}

function skillName(side, moveId, match) {
  const def = fighterDef(side, match);
  const sk = def && def.skills && def.skills.find((s) => s.id === moveId);
  return sk ? sk.name : label(moveId);
}

/** Startup / active / recovery + cancel window + 3 meter bars, per side. */
function drawFrameBar(c, f, x, y, w, side, match) {
  const ph = f.phase || { phase: 'none', frame: 0, total: 0, startup: 0, active: 0, recovery: 0 };
  const total = Math.max(1, ph.total || 1);
  const seg = (n) => (n / total) * w;
  c.save();
  c.textAlign = 'left';
  c.font = '600 10px ui-monospace, monospace';
  c.fillStyle = side === 'a' ? '#35d6a4' : '#5b8cff';
  const title = f.moveId ? skillName(side, f.moveId, match) : (f.state === 'knockdown' ? '倒地' : '可行动');
  c.fillText(title.toUpperCase(), x, y - 9);
  c.fillStyle = 'rgba(210,225,240,.55)';
  c.textAlign = 'right';
  c.fillText((ph.phase === 'none' ? 'READY' : PHASE_LABEL[ph.phase] + ' ' + ph.frame + '/' + ph.total), x + w, y - 9);

  const parts = [
    [seg(ph.startup), 'rgba(255,193,92,.55)'],
    [seg(ph.active), 'rgba(255,93,108,.8)'],
    [seg(ph.recovery), 'rgba(140,160,184,.35)'],
  ];
  let px = x;
  for (const [len, col] of parts) { c.fillStyle = col; c.fillRect(px, y, Math.max(0, len - 1), 6); px += len; }
  if (ph.phase !== 'none') {
    const cur = x + seg(ph.frame);
    c.fillStyle = '#fff';
    c.fillRect(cur - 1, y - 3, 2, 12);
  }
  if (ph.cancelable) {
    c.fillStyle = '#7dffcb';
    c.font = '700 9px ui-monospace, monospace';
    c.textAlign = 'left';
    c.fillText('CANCEL ' + (ph.cancelInto || []).join('/'), x, y + 18);
  }
  // Three 100-point meter bars: EX = half a bar, super = a full bar.
  for (let i = 0; i < 3; i += 1) {
    const bx = x + i * 34;
    const fill = Math.max(0, Math.min(1, (f.meter - i * 100) / 100));
    c.fillStyle = 'rgba(140,160,184,.2)';
    c.fillRect(bx, y + 24, 30, 4);
    c.fillStyle = f.meter >= 100 ? '#ffc260' : 'rgba(255,194,96,.65)';
    c.fillRect(bx, y + 24, 30 * fill, 4);
  }
  c.fillStyle = 'rgba(190,210,230,.45)';
  c.font = '9px ui-monospace, monospace';
  c.textAlign = 'left';
  c.fillText('METER ' + f.meter + (f.meter >= 100 ? '  SUPER READY' : f.meter >= 50 ? '  EX READY' : ''), x + 108, y + 28);
  c.restore();
}

function drawBoxLegend(c, w) {
  if (!S.showBoxes && !S.showBones) return;
  const items = [
    ['#38d9c0', 'HURT 受击框'], ['#ff5d6c', 'HIT 攻击框'],
    ['#8ea3b8', 'PUSH 碰撞框'], ['#ffd166', 'BONE 骨架'],
  ];
  c.save();
  c.font = '9px ui-monospace, monospace';
  c.textAlign = 'left';
  let x = 52;
  for (const [col, text] of items) {
    c.fillStyle = col;
    c.fillRect(x, 73, 7, 7);
    c.fillStyle = 'rgba(190,210,230,.62)';
    c.fillText(text, x + 11, 80);
    x += c.measureText(text).width + 26;
  }
  c.restore();
  void w;
}

function draw(c, frame, match, canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const fx = canvas === stageCanvas ? stageFx : replayFx;
  fx.observe(frame);
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, w, h);
  // Impact shake: a short zoom plus a jolt, so the frame edges never show
  // a gap while the scene is displaced.
  const sh = S.showFx && frame ? fx.shake(frame) : { x: 0, y: 0, amp: 0 };
  if (sh.x || sh.y) {
    // Zoom off the impulse envelope, never off the noise sample: deriving it
    // from |x|+|y| put the whole frame between 1.00 and 1.05 by chance on
    // neighbouring frames, which reads as the fighters themselves swelling
    // and shrinking on every link of a combo rather than the camera kicking.
    const zoom = 1 + Math.min(0.03, sh.amp * 0.0028);
    c.translate(w / 2, h / 2);
    c.scale(zoom, zoom);
    c.translate(-w / 2, -h / 2);
    c.translate(sh.x, sh.y);
  }
  const artStage = drawStageArt(c, w, h);
  if (!artStage) {

  // Back wall, distant structures and a spectator rail: a broadcast set,
  // not a flat debug grid.
  c.fillStyle = '#101b26';
  c.fillRect(0, 40, w, GROUND - 40);
  c.fillStyle = '#13202d';
  for (let x = 18; x < w; x += 86) {
    const top = 104 + (x % 3) * 9;
    c.fillRect(x, top, 46, GROUND - 70 - top);
    c.fillStyle = 'rgba(120,170,210,.07)';
    for (let y = top + 12; y < GROUND - 78; y += 18) c.fillRect(x + 8, y, 30, 5);
    c.fillStyle = '#13202d';
  }
  c.fillStyle = '#0e1923';
  c.fillRect(0, GROUND - 70, w, 70);
  c.fillStyle = 'rgba(130,170,205,.10)';
  for (let x = 12; x < w; x += 14) c.fillRect(x, GROUND - 56, 6, 6);
  c.fillStyle = 'rgba(130,170,205,.06)';
  for (let x = 6; x < w; x += 22) c.fillRect(x, GROUND - 40, 9, 4);
  for (const lx of [108, 480, 852]) {
    c.fillStyle = '#1b2a38'; c.fillRect(lx - 3, 52, 6, GROUND - 122);
    c.fillStyle = '#2a3f52'; c.fillRect(lx - 14, 48, 28, 8);
    c.fillStyle = 'rgba(190,220,245,.055)';
    poly(c, [[lx - 12, 56], [lx + 12, 56], [lx + 96, GROUND - 70], [lx - 96, GROUND - 70]], 'rgba(190,220,245,.045)', null);
  }
  if (S.showGrid) {
    c.strokeStyle = 'rgba(120,160,190,.05)';
    c.lineWidth = 1;
    for (let x = 40; x <= 920; x += 60) { c.beginPath(); c.moveTo(x, 40); c.lineTo(x, GROUND); c.stroke(); }
    for (let y = 90; y < GROUND; y += 48) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
  }
  c.fillStyle = '#16212c';
  c.fillRect(0, GROUND, w, h - GROUND);
  c.strokeStyle = 'rgba(120,160,190,.07)';
  c.lineWidth = 1;
  for (let i = 1; i <= 6; i += 1) {
    const y = GROUND + i * 13;
    c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke();
  }
  c.strokeStyle = '#31465a';
  c.lineWidth = 2;
  c.beginPath(); c.moveTo(0, GROUND); c.lineTo(w, GROUND); c.stroke();
  c.strokeStyle = 'rgba(53,214,164,.35)';
  c.lineWidth = 1;
  for (const bx of [40, 920]) { c.beginPath(); c.moveTo(bx, 60); c.lineTo(bx, GROUND); c.stroke(); }
  } else {
    // Painted stage: keep only a faint floor line, arena bounds and the
    // optional debug grid. Everything else comes from the illustration.
    c.strokeStyle = 'rgba(200,232,255,.16)';
    c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(0, GROUND); c.lineTo(w, GROUND); c.stroke();
    c.strokeStyle = 'rgba(53,214,164,.30)';
    c.lineWidth = 1;
    for (const bx of [40, 920]) { c.beginPath(); c.moveTo(bx, 52); c.lineTo(bx, GROUND); c.stroke(); }
    if (S.showGrid) {
      c.strokeStyle = 'rgba(120,160,190,.10)';
      c.lineWidth = 1;
      for (let x = 40; x <= 920; x += 60) { c.beginPath(); c.moveTo(x, 40); c.lineTo(x, GROUND); c.stroke(); }
      for (let y = 90; y < GROUND; y += 48) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
    }
  }
  const mode = (match && match.mode) || 'demo';
  const stage = mode === 'ranked' ? 'RANKED ARENA' : mode === 'scrim' ? 'PRIVATE SCRIM' : 'NEUTRAL GRID';
  const technical = S.showBoxes || S.showBones || S.showRuler || S.showGrid;
  if (technical) {
    c.font = '10px ui-monospace, monospace';
    c.fillStyle = 'rgba(138,156,176,.45)';
    c.textAlign = 'left';
    c.fillText('STAGE 01 / ' + stage, 52, 62);
    c.textAlign = 'right';
    c.fillText('SERVER-AUTHORITATIVE · 60 FPS', 908, 62);
    c.textAlign = 'left';
  }

  if (!frame) {
    c.fillStyle = 'rgba(138,156,176,.5)';
    c.font = '13px ui-monospace, monospace';
    c.textAlign = 'center';
    c.fillText('WAITING FOR FIRST FRAME', w / 2, 210);
    c.textAlign = 'left';
    return;
  }

  if (S.showRuler) {
    const dx = Math.abs(frame.a.x - frame.b.x);
    const y = GROUND + 24;
    c.strokeStyle = 'rgba(255,194,96,.55)';
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(frame.a.x, y); c.lineTo(frame.b.x, y); c.stroke();
    for (const x of [frame.a.x, frame.b.x]) {
      c.beginPath(); c.moveTo(x, y - 4); c.lineTo(x, y + 4); c.stroke();
    }
    c.fillStyle = '#ffc260';
    c.font = '10px ui-monospace, monospace';
    c.textAlign = 'center';
    c.fillText('DIST ' + dx, (frame.a.x + frame.b.x) / 2, y - 6);
    c.textAlign = 'left';
  }

  for (const p of frame.projectiles || []) {
    const pal = fighterDef(p.owner, match).palette;
    // The projectile is drawn AT THE SIZE OF ITS OWN HITBOX, so the picture
    // cannot promise reach the kernel does not have: an orb is 34x44, a super
    // beam is 96x92 and reads as a beam.
    const box = p.box || { w: 30, h: 40 };
    const bw = box.w;
    const bh = box.h;
    const beam = bw > 60;
    c.save();
    c.translate(p.x, GROUND + p.y);
    if ((p.delay || 0) > 0) { c.restore(); continue; }
    if (beam) {
      const grad = c.createLinearGradient(-bw / 2, 0, bw / 2, 0);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.25, pal.light);
      grad.addColorStop(0.6, pal.base);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      c.globalAlpha = 0.55;
      c.fillStyle = grad;
      c.fillRect(-bw / 2, -bh / 2, bw, bh);
      c.globalAlpha = 0.9;
      c.fillStyle = pal.accent;
      c.fillRect(-bw / 2, -bh * 0.16, bw, bh * 0.32);
      c.globalAlpha = 0.35;
      c.fillStyle = pal.light;
      c.fillRect(-bw / 2, -bh / 2, bw, 3);
      c.fillRect(-bw / 2, bh / 2 - 3, bw, 3);
    } else {
      const glow = c.createRadialGradient(0, 0, 2, 0, 0, Math.max(bw, bh) * 0.9);
      glow.addColorStop(0, pal.accent);
      glow.addColorStop(0.45, pal.light);
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      c.globalAlpha = 0.85;
      c.fillStyle = glow;
      c.beginPath(); c.ellipse(0, 0, bw * 0.9, bh * 0.9, 0, 0, Math.PI * 2); c.fill();
      c.globalAlpha = 0.95;
      c.fillStyle = pal.base;
      c.beginPath(); c.ellipse(0, 0, bw / 2, bh / 2, 0, 0, Math.PI * 2); c.fill();
      c.fillStyle = pal.accent;
      c.beginPath(); c.ellipse(0, 0, bw / 6, bh / 6, 0, 0, Math.PI * 2); c.fill();
    }
    c.restore();
  }

  drawFighter(c, frame.b, 'b', frame, match);
  drawFighter(c, frame.a, 'a', frame, match);

  impactFx[canvas === stageCanvas ? 'stage' : 'replay'].draw(c, frame, match, w, h);
  if (technical) {
    drawFrameBar(c, frame.a, 52, h - 34, 320, 'a', match);
    drawFrameBar(c, frame.b, w - 52 - 320, h - 34, 320, 'b', match);
    drawBoxLegend(c, w);
  }
  // The counter is HUD, not scenery: it must not ride the impact shake.
  c.setTransform(1, 0, 0, 1, 0, 0);
  if (S.showFx) fx.draw(c, frame, match, w);
  if (S.lastResult && (!match || S.lastResult.matchId === match.matchId)) drawResult(c, w, h, match);
}

function drawResult(c, w, h, match) {
  const result = S.lastResult;
  if (!result) return;
  const m = match || S.match;
  const winner = result.winnerName
    || (result.winner === 'a' ? m && m.a && m.a.name : result.winner === 'b' ? m && m.b && m.b.name : '')
    || '—';
  const ko = result.reason === 'ko';
  c.save();
  c.fillStyle = 'rgba(4,8,14,.60)';
  c.fillRect(0, 0, w, h);
  c.textAlign = 'center';
  c.font = '800 52px ui-monospace, monospace';
  c.lineWidth = 6;
  c.strokeStyle = 'rgba(5,10,16,.92)';
  const title = ko ? 'K.O.' : 'TIME UP';
  c.strokeText(title, w / 2, h / 2 - 22);
  c.fillStyle = ko ? '#ffd166' : '#9fd0ff';
  c.fillText(title, w / 2, h / 2 - 22);
  c.font = '600 18px ui-monospace, monospace';
  c.fillStyle = '#e7eef6';
  c.fillText(winner + ' 获胜', w / 2, h / 2 + 28);
  c.font = '11px ui-monospace, monospace';
  c.fillStyle = 'rgba(190,210,230,.62)';
  c.fillText('下一局即将开始 · 可在大厅或回放中继续观看', w / 2, h / 2 + 54);
  c.restore();
}

// The server streams one snapshot per simulation frame (60/s). Playback is
// paced by wall time, not by rAF: one snapshot per animation frame only works
// at exactly 60 Hz. On a 120 Hz panel it ran the match at double speed and
// then sat empty half of every tick, and a dropped frame left the queue to be
// skipped wholesale — both read as the fighters twitching.

  function replayImpactWindow(index) {
    const window = [];
    const from = Math.max(0, index - impactFx.replay.windowTicks);
    for (let i = from; i <= index; i += 1) {
      const tk = S.replay && S.replay.ticks ? S.replay.ticks[i] : null;
      if (tk && tk.events) window.push(tk.events);
    }
    return window;
  }

  return {
    draw,
    drawResult,
    ensureMatchFighters,
    loadStageArtwork,
    loadFighter,
    matchFighterIds,
    resetFx() {
      stageFx.reset();
      replayFx.reset();
      impactFx.stage.reset();
      impactFx.replay.reset();
    },
    ingestLiveEvents(events) {
      stageFx.ingest(events);
      impactFx.stage.ingest(events);
    },
    observeReplay(frame, events) {
      replayFx.observe(frame, events);
    },
    replaceReplayImpact(index) {
      impactFx.replay.replace(replayImpactWindow(index));
    },
  };
}
