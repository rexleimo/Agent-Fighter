/**
 * Cutout rig baker (A2).
 *
 * A painted fighter plate is ONE static drawing. To make it articulate, we
 * cut it into body parts and let the server's 15-joint skeleton drive those
 * parts, exactly the way a 2D cutout (Flash / MUGEN-style) character works.
 *
 * Pixel ownership is decided by bone-space segmentation: every opaque pixel
 * joins the nearest rendered bone capsule, weighted so front limbs claim the
 * pixels drawn on top of the torso. That is geometry, not a hand-painted mask,
 * so the result is reproducible and reviewable from `rig.json`.
 *
 * Outputs, per fighter, under web/assets/rig/<id>/:
 *   mask.png       RGBA atlas; RGB = part colour, A = owned
 *   <part>.pad.png dilated backing layer, colour propagated from its own
 *                  pixels, so rotating a limb does not expose a hole in the
 *                  torso it was drawn over
 *   rig.json       joints (plate px), pivots, z-order, crops
 *
 * Usage:
 *   node scripts/rig-bake.mjs            # bake every fighter
 *   node scripts/rig-bake.mjs abyss      # bake one
 *   node scripts/rig-bake.mjs --overlay  # also write .tmp-rig/<id>.png
 */
import fs from 'node:fs';
import path from 'node:path';
import { readRGBA, writeRGBA } from './lib/png.mjs';
import { FIGHTERS } from '../src/fighters.js';
import { BASE_POSE } from '../src/combat.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const ART = path.join(ROOT, 'web', 'assets', 'art');
const OUT = path.join(ROOT, 'web', 'assets', 'rig');
const PREVIEW = path.join(ROOT, '.tmp-rig');

/**
 * Part definitions. `bones` is the capsule chain that owns pixels; `pivot` is
 * the joint the part rotates around; `z` is paint order (low = behind).
 * `radius` widens the capsule where the drawn body is thicker.
 */
const PART_DEFS = [
  // z ascends with paint order; `drive` is the bone whose angle turns the part,
  // `follow`/`followK` add the joint's own travel, `clamp` bounds the rotation
  // and `ball` gives the pivot a disc of pixels so the seam cannot open.
  { id: 'armB', bones: ['shoulderB', 'elbowB', 'handB'], pivot: 'shoulderB', z: 0, weight: 0.95, radius: 0.08, drive: ['shoulderB', 'elbowB'], follow: ['handB'], followK: 0.15, spin: 0.8, ball: 0.06, clamp: 0.62 },
  { id: 'legB', bones: ['hip', 'kneeB', 'footB'], pivot: 'hip', z: 1, weight: 1.0, radius: 0.12, drive: ['hip', 'kneeB'], follow: [], followK: 0, spin: 0.45, ball: 0.075, clamp: 0.32 },
  { id: 'torso', bones: ['hip', 'chest', 'neck', 'shoulderF', 'shoulderB', 'skirt'], pivot: 'hip', z: 2, weight: 1.0, radius: 0.15, drive: ['hip', 'chest'], follow: [], followK: 0, spin: 0.45, ball: 0.075, clamp: 0.5 },
  { id: 'legF', bones: ['hip', 'kneeF', 'footF'], pivot: 'hip', z: 3, weight: 1.12, radius: 0.125, drive: ['hip', 'kneeF'], follow: [], followK: 0, spin: 0.45, ball: 0.08, clamp: 0.32 },
  { id: 'head', bones: ['neck', 'head'], pivot: 'neck', z: 4, weight: 1.0, radius: 0.13, drive: ['neck', 'head'], follow: [], followK: 0, spin: 1, ball: 0.05, clamp: 0.42 },
  { id: 'armF', bones: ['shoulderF', 'elbowF', 'handF'], pivot: 'shoulderF', z: 5, weight: 1.28, radius: 0.09, drive: ['shoulderF', 'elbowF'], follow: ['handF'], followK: 0.15, spin: 0.8, ball: 0.065, clamp: 0.62 },
];

const baseAngle = (a, b) => Math.atan2(BASE_POSE[b][1] - BASE_POSE[a][1], BASE_POSE[b][0] - BASE_POSE[a][0]);

const PART_COLORS = {
  armB: [255, 92, 92], legB: [255, 168, 62], torso: [72, 190, 255],
  legF: [255, 240, 96], head: [126, 255, 146], armF: [200, 122, 255],
};

/**
 * Default skeleton template, in normalised plate space: x is a fraction of
 * width measured from the horizontal centre, y is a fraction of height from
 * the top of the alpha silhouette. It describes the stance these plates are
 * drawn in: frontal, slight 3/4, both claws forward, knees soft.
 */
const TEMPLATE = {
  root: [0, 0.55], hip: [0, 0.52], chest: [0, 0.32], neck: [0, 0.20], head: [0, 0.09],
  shoulderF: [0.15, 0.30], elbowF: [0.30, 0.40], handF: [0.17, 0.52],
  shoulderB: [-0.15, 0.30], elbowB: [-0.30, 0.40], handB: [-0.17, 0.52],
  kneeF: [0.12, 0.76], footF: [0.20, 1.0],
  kneeB: [-0.12, 0.76], footB: [-0.20, 1.0],
  // Virtual joint: a coat tail / skirt hangs from the hip and must not be
  // claimed by a leg, or it tears off when the leg swings.
  skirt: [0, 0.66],
};

/** Per-fighter joint overrides, in the same normalised space. */
function rigOverride(id) {
  const file = path.join(OUT, id, 'override.json');
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function silhouette(rgba, w, h) {
  const alpha = new Uint8Array(w * h);
  let minX = w, maxX = -1, minY = h, maxY = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (rgba[(y * w + x) * 4 + 3] <= 32) continue;
      alpha[y * w + x] = 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { alpha, minX, maxX, minY, maxY };
}

function jointsFor(box, overrides) {
  const W = box.maxX - box.minX + 1;
  const H = box.maxY - box.minY + 1;
  const cx = box.minX + W / 2;
  const spec = { ...TEMPLATE, ...overrides };
  const joints = {};
  for (const [k, v] of Object.entries(spec)) {
    joints[k] = [Math.round(cx + v[0] * W), Math.round(box.minY + v[1] * H)];
  }
  return joints;
}

function segDistance(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = a[0] + dx * t, qy = a[1] + dy * t;
  return Math.hypot(px - qx, py - qy);
}

function chainDistance(px, py, chain) {
  let best = Infinity;
  for (let i = 0; i < chain.length - 1; i += 1) {
    const d = segDistance(px, py, chain[i], chain[i + 1]);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Claim score: distance to the part's bone chain, divided by the part's own
 * capsule radius (a fraction of figure height) and a front/back weight.
 * Lowest score wins, so a pixel drawn on top of the torso belongs to the limb
 * bone that runs through it, not to the spine.
 */
function partScore(px, py, part, joints, figH) {
  const chain = part.bones.map((k) => joints[k]);
  const d = chainDistance(px, py, chain);
  return d / (part.weight * part.radius * figH);
}

function bakeOne(id, { overlay }) {
  const artFile = path.join(ART, id + '.png');
  if (!fs.existsSync(artFile)) return { id, skipped: 'no art' };
  const { width: w, height: h, rgba } = readRGBA(artFile);
  const box = silhouette(rgba, w, h);
  const joints = jointsFor(box, rigOverride(id));
  const figH = box.maxY - box.minY + 1;

  // ── pixel ownership ──────────────────────────────────────────────────────
  const owner = new Int8Array(w * h).fill(-1);
  for (let y = box.minY; y <= box.maxY; y += 1) {
    for (let x = box.minX; x <= box.maxX; x += 1) {
      if (!box.alpha[y * w + x]) continue;
      let bestPart = 0, bestScore = Infinity;
      for (let i = 0; i < PART_DEFS.length; i += 1) {
        const s = partScore(x, y, PART_DEFS[i], joints, figH);
        if (s < bestScore) { bestScore = s; bestPart = i; }
      }
      owner[y * w + x] = bestPart;
    }
  }

  // ── joint balls ──────────────────────────────────────────────────────────
  // A rigid part rotating about its pivot opens a wedge along its proximal
  // cut edge. Give every rotating joint a disc of pixels that belongs to the
  // part, so the "ball" sweeps the wedge closed, exactly like a real cutout
  // puppet's joint cap. Higher z wins, so a front arm claims the shoulder.
  for (const part of PART_DEFS) {
    if (!part.ball) continue;
    const [cx, cy] = joints[part.pivot];
    const r = part.ball * figH;
    const mine = PART_DEFS.indexOf(part);
    for (let y = Math.max(box.minY, Math.round(cy - r)); y <= Math.min(box.maxY, Math.round(cy + r)); y += 1) {
      for (let x = Math.max(box.minX, Math.round(cx - r)); x <= Math.min(box.maxX, Math.round(cx + r)); x += 1) {
        if (!box.alpha[y * w + x]) continue;
        if (Math.hypot(x - cx, y - cy) > r) continue;
        owner[y * w + x] = mine;
      }
    }
  }

  // ── part crops ───────────────────────────────────────────────────────────
  const crops = {};
  for (let i = 0; i < PART_DEFS.length; i += 1) crops[PART_DEFS[i].id] = null;
  for (let y = box.minY; y <= box.maxY; y += 1) {
    for (let x = box.minX; x <= box.maxX; x += 1) {
      const o = owner[y * w + x];
      if (o < 0) continue;
      const id2 = PART_DEFS[o].id;
      const c = crops[id2];
      if (!c) crops[id2] = { x0: x, y0: y, x1: x, y1: y };
      else {
        if (x < c.x0) c.x0 = x;
        if (x > c.x1) c.x1 = x;
        if (y < c.y0) c.y0 = y;
        if (y > c.y1) c.y1 = y;
      }
    }
  }

  const dir = path.join(OUT, id);
  fs.mkdirSync(dir, { recursive: true });

  // ── mask atlas (compresses to almost nothing: flat colours) ──────────────
  const mask = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    const o = owner[i];
    if (o < 0) continue;
    const col = PART_COLORS[PART_DEFS[o].id];
    mask[i * 4] = col[0];
    mask[i * 4 + 1] = col[1];
    mask[i * 4 + 2] = col[2];
    mask[i * 4 + 3] = 255;
  }
  writeRGBA(path.join(dir, 'mask.png'), w, h, mask);

  const counts = {};
  for (let i = 0; i < w * h; i += 1) {
    const o = owner[i];
    if (o < 0) continue;
    counts[PART_DEFS[o].id] = (counts[PART_DEFS[o].id] || 0) + 1;
  }
  const missing = PART_DEFS.filter((p) => !crops[p.id]).map((p) => p.id);

  const rig = {
    id,
    // Server skeleton is ~192 units tall; the plate is ~950px. The renderer
    // needs this to convert joint deltas into plate pixels.
    plateScale: Math.round((figH / 192) * 1000) / 1000,
    serverHeight: 192,
    source: 'web/assets/art/' + id + '.png',
    width: w,
    height: h,
    box: { w: box.maxX - box.minX + 1, h: box.maxY - box.minY + 1 },
    joints,
    parts: PART_DEFS.filter((p) => crops[p.id]).map((p) => ({
      id: p.id, z: p.z, pivot: p.pivot,
      crop: { x: crops[p.id].x0, y: crops[p.id].y0, w: crops[p.id].x1 - crops[p.id].x0 + 1, h: crops[p.id].y1 - crops[p.id].y0 + 1 },
      ball: p.ball || 0,
      bones: p.bones,
      drive: p.drive,
      restAngle: Math.round(baseAngle(p.drive[0], p.drive[1]) * 10000) / 10000,
      follow: p.follow,
      followK: p.followK,
      spin: p.spin,
      clamp: p.clamp || 0.95,
    })),
  };
  fs.writeFileSync(path.join(dir, 'rig.json'), JSON.stringify(rig, null, 2) + '\n');

  if (overlay) {
    fs.mkdirSync(PREVIEW, { recursive: true });
    const out = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i += 1) {
      const o = owner[i];
      const si = i * 4;
      if (o < 0) { out[si] = 12; out[si + 1] = 16; out[si + 2] = 20; out[si + 3] = 255; continue; }
      const col = PART_COLORS[PART_DEFS[o].id];
      // Tint the drawing so the segmentation stays readable through it.
      out[si] = Math.round(rgba[si] * 0.45 + col[0] * 0.55);
      out[si + 1] = Math.round(rgba[si + 1] * 0.45 + col[1] * 0.55);
      out[si + 2] = Math.round(rgba[si + 2] * 0.45 + col[2] * 0.55);
      out[si + 3] = 255;
    }
    const dot = (cx, cy, r, col) => {
      for (let y = Math.round(cy - r); y <= cy + r; y += 1) {
        for (let x = Math.round(cx - r); x <= cx + r; x += 1) {
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          if (Math.hypot(x - cx, y - cy) > r) continue;
          const si = (y * w + x) * 4;
          out[si] = col[0]; out[si + 1] = col[1]; out[si + 2] = col[2]; out[si + 3] = 255;
        }
      }
    };
    for (const part of PART_DEFS) {
      const pv = joints[part.pivot];
      dot(pv[0], pv[1], 4, [255, 255, 255]);
    }
    for (const [k, v] of Object.entries(joints)) dot(v[0], v[1], 2.5, k.includes('F') ? [0, 255, 240] : [255, 90, 255]);
    writeRGBA(path.join(PREVIEW, id + '.png'), w, h, out);
  }

  const owned = owner.reduce((n, o) => n + (o >= 0 ? 1 : 0), 0);
  return { id, joints: Object.keys(joints).length, owned, counts, missing, size: `${w}x${h}` };
}

const argv = process.argv.slice(2);
const overlay = argv.includes('--overlay');
const only = argv.filter((a) => !a.startsWith('--'));
const ids = only.length ? only : FIGHTERS.map((f) => f.id);
const results = ids.map((id) => bakeOne(id, { overlay }));
for (const r of results) console.log(JSON.stringify(r));
const failed = results.filter((r) => r.skipped);
if (failed.length) process.exitCode = 1;
