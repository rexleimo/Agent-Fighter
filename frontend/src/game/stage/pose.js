/**
 * Fighter pose, primitive draw helpers, rig loading and geometry overlays.
 * Extracted from stage.js without changing any drawing behaviour.
 */
import { loadRig } from '@web/rig.js';

export function installPose(ctx) {
  const { S, ART, GROUND, ACTION_LABEL, repaintArt } = ctx;

  const label = (a) => ACTION_LABEL[a] || (S.moves[a] && S.moves[a].label) || a;

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
  } else if (f.state === 'dodge') {
    // Matches the kernel pose: weight back, torso leaned off the line, both
    // arms trailing. This fallback only draws when no skeleton came with the
    // frame, but it must not disagree with the authoritative one.
    p.hip = [-6, -44]; p.chest = [-14, -78]; p.head = [-20, -98];
    p.elbowF = [-2, -70]; p.handF = [-16, -60];
    p.elbowB = [-20, -68]; p.handB = [-32, -58];
    p.kneeF = [6, -22]; p.footF = [12, 0];
    p.kneeB = [-14, -24]; p.footB = [-26, 0];
  } else if (f.state === 'parry') {
    p.hip = [-2, -46]; p.chest = [-4, -80]; p.head = [-4, -102];
    p.elbowF = [18, -76]; p.handF = [30, -92];
    p.elbowB = [10, -74]; p.handB = [24, -86];
    p.kneeF = [12, -22]; p.footF = [20, 0];
    p.kneeB = [-8, -24]; p.footB = [-18, 0];
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

  return {
    label, lerp, poseFor, line, blitFighter, rigLocalJoints, ensureRig,
    fighterDef, poly, drawSignature, drawFrameGeometry, RIG_STATES, FALLBACK_FIGHTER,
  };
}
