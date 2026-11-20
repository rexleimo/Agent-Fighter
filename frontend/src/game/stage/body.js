/**
 * Fighter body painting: sprite/rig cutout, procedural fallback and portrait.
 * Extracted from stage.js without changing any drawing behaviour.
 */
import { drawRig } from '@web/rig.js';
import { drawSprite, ensureSprites, spritesReady } from '@web/sprite.js';
import { ART, GROUND } from './shared.js';

export function installBody(ctx) {
  const {
    S, label, poseFor, fighterDef, artImage, ensureRig, poly, line,
    drawSignature, drawFrameGeometry, blitFighter, rigLocalJoints, RIG_STATES, FALLBACK_FIGHTER,
  } = ctx;

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

  return { drawSpriteBody, drawFighter, drawPortrait };
}
