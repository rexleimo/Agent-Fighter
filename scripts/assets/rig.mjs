/**
 * Rig baker v2 — pre-composed part atlas + compact schema-2 JSON.
 *
 * The browser must not decode a full-resolution ownership mask and composite
 * six canvases per fighter. This module does that work once at build time:
 *
 *   source plate -> silhouette -> bone-capsule ownership -> padded part crops
 *   -> scaled atlas -> rig.json (schema 2)
 *
 * Ownership is still geometric and reproducible (nearest bone capsule with
 * front/back weights), so the result is reviewable rather than hand-painted.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPNG, resizeRGBA, sha256, writeAtomic, writePNG, encodeWebP, cwebpPath, shortHash, shelfPack, blitRGBA } from '../lib/imageops.mjs';
import { encodeRGBA } from '../lib/png.mjs';
import { BASE_POSE } from '../../src/combat.js';

export const RIG_SCHEMA_VERSION = 2;

/** Default skeleton template in normalised plate space. */
export const TEMPLATE = {
  root: [0, 0.55], hip: [0, 0.52], chest: [0, 0.32], neck: [0, 0.20], head: [0, 0.09],
  shoulderF: [0.15, 0.30], elbowF: [0.30, 0.40], handF: [0.17, 0.52],
  shoulderB: [-0.15, 0.30], elbowB: [-0.30, 0.40], handB: [-0.17, 0.52],
  kneeF: [0.12, 0.76], footF: [0.20, 1.0],
  kneeB: [-0.12, 0.76], footB: [-0.20, 1.0],
  skirt: [0, 0.66],
};

/**
 * Part definitions. `bones` owns pixels; `pivot` rotates; `drive` is the
 * server bone pair that produces the angle. Clamps are deliberately wider
 * than v1: the old 0.32–0.62 rad cap is why every attack looked like idle.
 * The wider cap is paired with a soft seam halo so it does not tear.
 */
export const PART_DEFS = [
  { id: 'armB', bones: ['shoulderB', 'elbowB', 'handB'], pivot: 'shoulderB', z: 0, weight: 0.95, radius: 0.09, drive: ['shoulderB', 'elbowB'], follow: ['handB'], followK: 0.25, spin: 0.95, ball: 0.08, clamp: 1.05 },
  { id: 'legB', bones: ['hip', 'kneeB', 'footB'], pivot: 'hip', z: 1, weight: 1.0, radius: 0.13, drive: ['hip', 'kneeB'], follow: [], followK: 0, spin: 0.8, ball: 0.09, clamp: 0.55 },
  { id: 'torso', bones: ['hip', 'chest', 'neck', 'shoulderF', 'shoulderB', 'skirt'], pivot: 'hip', z: 2, weight: 1.0, radius: 0.15, drive: ['hip', 'chest'], follow: [], followK: 0, spin: 0.55, ball: 0.08, clamp: 0.6 },
  { id: 'legF', bones: ['hip', 'kneeF', 'footF'], pivot: 'hip', z: 3, weight: 1.12, radius: 0.135, drive: ['hip', 'kneeF'], follow: [], followK: 0, spin: 0.8, ball: 0.09, clamp: 0.55 },
  { id: 'head', bones: ['neck', 'head'], pivot: 'neck', z: 4, weight: 1.0, radius: 0.13, drive: ['neck', 'head'], follow: [], followK: 0, spin: 1, ball: 0.06, clamp: 0.5 },
  { id: 'armF', bones: ['shoulderF', 'elbowF', 'handF'], pivot: 'shoulderF', z: 5, weight: 1.28, radius: 0.1, drive: ['shoulderF', 'elbowF'], follow: ['handF'], followK: 0.25, spin: 0.95, ball: 0.085, clamp: 1.05 },
];

const OVERLAY_COLORS = [
  [255, 92, 92], [255, 168, 62], [72, 190, 255], [255, 240, 96],
  [126, 255, 146], [200, 122, 255], [255, 130, 200], [120, 255, 230],
  [255, 200, 120], [160, 160, 255], [220, 255, 120], [255, 120, 120],
];

function loadOverride(fromDir, id) {
  const file = path.join(fromDir, id, 'override.json');
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
  if (maxX < 0) throw new Error('rig: empty silhouette');
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

function partScore(px, py, part, joints, figH) {
  const chain = part.bones.map((k) => joints[k]).filter(Boolean);
  if (chain.length < 2) return Infinity;
  return chainDistance(px, py, chain) / (part.weight * part.radius * figH);
}

function baseAngle(a, b) {
  return Math.atan2(BASE_POSE[b][1] - BASE_POSE[a][1], BASE_POSE[b][0] - BASE_POSE[a][0]);
}

/** Fill a soft halo around owned pixels so a rotated part cannot expose a hole. */
function padPart(src, owner, partIndex, crop, pad, figH) {
  const out = Buffer.alloc(crop.w * crop.h * 4);
  const distance = new Uint16Array(crop.w * crop.h).fill(0xFFFF);
  const queue = [];
  for (let y = 0; y < crop.h; y += 1) {
    for (let x = 0; x < crop.w; x += 1) {
      const sx = crop.x + x, sy = crop.y + y;
      if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) continue;
      if (owner[sy * src.width + sx] !== partIndex) continue;
      const di = (y * crop.w + x) * 4;
      const si = (sy * src.width + sx) * 4;
      out[di] = src.rgba[si];
      out[di + 1] = src.rgba[si + 1];
      out[di + 2] = src.rgba[si + 2];
      out[di + 3] = src.rgba[si + 3];
      distance[y * crop.w + x] = 0;
      queue.push(y * crop.w + x);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++];
    const d = distance[idx];
    if (d >= pad) continue;
    const x = idx % crop.w, y = (idx / crop.w) | 0;
    const di = idx * 4;
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (nx < 0 || ny < 0 || nx >= crop.w || ny >= crop.h) continue;
      const ni = ny * crop.w + nx;
      if (distance[ni] <= d + 1) continue;
      distance[ni] = d + 1;
      const alpha = Math.max(0, Math.round((1 - (d + 1) / (pad + 1)) * 255));
      const nj = ni * 4;
      out[nj] = out[di];
      out[nj + 1] = out[di + 1];
      out[nj + 2] = out[di + 2];
      out[nj + 3] = alpha;
      queue.push(ni);
    }
  }
  void figH;
  return { width: crop.w, height: crop.h, rgba: out };
}

function writeOverlay(file, src, owner, parts, colors) {
  const out = Buffer.alloc(src.width * src.height * 4);
  for (let i = 0; i < src.width * src.height; i += 1) {
    const o = owner[i];
    const si = i * 4;
    if (o < 0) { out[si] = 12; out[si + 1] = 16; out[si + 2] = 20; out[si + 3] = 255; continue; }
    const col = colors[o % colors.length];
    out[si] = Math.round(src.rgba[si] * 0.45 + col[0] * 0.55);
    out[si + 1] = Math.round(src.rgba[si + 1] * 0.45 + col[1] * 0.55);
    out[si + 2] = Math.round(src.rgba[si + 2] * 0.45 + col[2] * 0.55);
    out[si + 3] = 255;
  }
  writePNG(file, src.width, src.height, out);
}

/**
 * Bake one fighter.
 *
 * @param {object} opts
 * @param {string} opts.id
 * @param {string} opts.sourcePath
 * @param {string} opts.outDir       web/assets/v/rig/<id>
 * @param {string} opts.overrideDir  assets/rig
 * @param {number} [opts.bakeHeight=512]
 * @param {boolean} [opts.write=true]
 * @param {boolean} [opts.overlay=false]
 * @param {string} [opts.previewDir]
 */
export function buildRig({
  id, sourcePath, outDir, overrideDir, bakeHeight = 512, write = true, overlay = false, previewDir,
}) {
  const src = readPNG(sourcePath);
  if (write) fs.mkdirSync(outDir, { recursive: true });
  const sourceSha256 = sha256(fs.readFileSync(sourcePath));
  const box = silhouette(src.rgba, src.width, src.height);
  const override = loadOverride(overrideDir, id);
  const joints = jointsFor(box, override.joints || {});
  const figH = box.maxY - box.minY + 1;
  const partDefs = PART_DEFS.map((p) => ({ ...p }));
  if (Array.isArray(override.parts)) {
    for (const patch of override.parts) {
      const at = partDefs.findIndex((p) => p.id === patch.id);
      if (at >= 0) partDefs[at] = { ...partDefs[at], ...patch };
      else partDefs.push({ ...patch });
    }
  }

  // ── pixel ownership ─────────────────────────────────────────────────────
  const owner = new Int8Array(src.width * src.height).fill(-1);
  for (let y = box.minY; y <= box.maxY; y += 1) {
    for (let x = box.minX; x <= box.maxX; x += 1) {
      if (!box.alpha[y * src.width + x]) continue;
      let bestPart = 0, bestScore = Infinity;
      for (let i = 0; i < partDefs.length; i += 1) {
        const s = partScore(x, y, partDefs[i], joints, figH);
        if (s < bestScore) { bestScore = s; bestPart = i; }
      }
      owner[y * src.width + x] = bestPart;
    }
  }

  // ── joint balls ──────────────────────────────────────────────────────────
  for (const part of partDefs) {
    if (!part.ball || !joints[part.pivot]) continue;
    const [cx, cy] = joints[part.pivot];
    const r = part.ball * figH;
    const mine = partDefs.indexOf(part);
    for (let y = Math.max(box.minY, Math.round(cy - r)); y <= Math.min(box.maxY, Math.round(cy + r)); y += 1) {
      for (let x = Math.max(box.minX, Math.round(cx - r)); x <= Math.min(box.maxX, Math.round(cx + r)); x += 1) {
        if (!box.alpha[y * src.width + x]) continue;
        if (Math.hypot(x - cx, y - cy) > r) continue;
        owner[y * src.width + x] = mine;
      }
    }
  }

  // ── crops ────────────────────────────────────────────────────────────────
  const crops = partDefs.map(() => null);
  for (let y = box.minY; y <= box.maxY; y += 1) {
    for (let x = box.minX; x <= box.maxX; x += 1) {
      const o = owner[y * src.width + x];
      if (o < 0) continue;
      const c = crops[o];
      if (!c) crops[o] = { x0: x, y0: y, x1: x, y1: y };
      else {
        if (x < c.x0) c.x0 = x;
        if (x > c.x1) c.x1 = x;
        if (y < c.y0) c.y0 = y;
        if (y > c.y1) c.y1 = y;
      }
    }
  }

  const missing = partDefs.filter((p, i) => !crops[i]).map((p) => p.id);
  if (missing.length) throw new Error(`rig ${id}: parts with no pixels: ${missing.join(', ')}`);

  // ── scale + pad + atlas ──────────────────────────────────────────────────
  const scale = Math.min(1, bakeHeight / figH);
  const padSrc = Math.max(2, Math.round(figH * 0.012));
  const scaled = [];
  partDefs.forEach((part, i) => {
    const c = crops[i];
    const crop = {
      x: c.x0 - padSrc, y: c.y0 - padSrc,
      w: c.x1 - c.x0 + 1 + padSrc * 2,
      h: c.y1 - c.y0 + 1 + padSrc * 2,
    };
    // Clamp the padded crop to the plate; the pad is a halo, not a new frame.
    const x = Math.max(0, crop.x), y = Math.max(0, crop.y);
    const x2 = Math.min(src.width, crop.x + crop.w), y2 = Math.min(src.height, crop.y + crop.h);
    const clipped = { x, y, w: x2 - x, h: y2 - y };
    const padded = padPart(src, owner, i, clipped, padSrc, figH);
    const dw = Math.max(1, Math.round(padded.width * scale));
    const dh = Math.max(1, Math.round(padded.height * scale));
    const resized = resizeRGBA(padded, dw, dh);
    scaled.push({
      part,
      image: resized,
      // Pivot relative to the padded crop (and therefore to the atlas rect).
      px: Math.round((joints[part.pivot][0] - clipped.x) * scale),
      py: Math.round((joints[part.pivot][1] - clipped.y) * scale),
      ax: Math.round((joints[part.pivot][0] - joints.root[0]) * scale),
      ay: Math.round((joints[part.pivot][1] - box.minY) * scale),
      seam: Math.round(padSrc * scale),
    });
  });

  const packed = shelfPack(scaled.map((s) => ({ w: s.image.width, h: s.image.height, ...s })), { gutter: 2, maxWidth: 1024 });
  const atlas = { width: packed.width, height: packed.height, rgba: Buffer.alloc(packed.width * packed.height * 4) };
  for (const item of packed.placed) blitRGBA(atlas, { x: item.x, y: item.y }, item.image);

  const figureHeight = Math.max(1, Math.round(figH * scale));
  const plateScale = Math.round((figureHeight / 192) * 10000) / 10000;
  const parts = packed.placed.map((item) => ({
    id: item.part.id,
    z: item.part.z,
    pivot: item.part.pivot,
    rect: { x: item.x, y: item.y, w: item.image.width, h: item.image.height },
    px: item.px,
    py: item.py,
    ax: item.ax,
    ay: item.ay,
    restAngle: Math.round(baseAngle(item.part.drive[0], item.part.drive[1]) * 10000) / 10000,
    drive: item.part.drive,
    follow: item.part.follow || [],
    followK: item.part.followK || 0,
    spin: item.part.spin,
    clamp: item.part.clamp,
    seam: item.seam,
  })).sort((a, b) => a.z - b.z);

  const atlasPngBuf = encodeRGBA(atlas.width, atlas.height, atlas.rgba);
  const atlasPngHash = sha256(atlasPngBuf);
  const atlasPngName = 'atlas.' + shortHash(atlasPngHash) + '.png';
  const atlasPngPath = path.join(outDir, atlasPngName);
  let atlasPath = atlasPngPath;
  let atlasUrlName = atlasPngName;
  let atlasFormat = 'png';
  let atlasBytes = atlasPngBuf.length;
  let atlasHash = atlasPngHash;
  if (write) {
    // cwebp needs a real PNG input; use a temp file, then keep only WebP when
    // the encoder is available. PNG remains the fallback on machines without
    // cwebp, but the committed build is WebP-primary.
    const tmpPng = path.join(os.tmpdir(), `afl-atlas-${id}-${process.pid}.png`);
    writeAtomic(tmpPng, atlasPngBuf);
    const tmpWebp = path.join(os.tmpdir(), `afl-atlas-${id}-${process.pid}.webp`);
    const encoded = encodeWebP(tmpPng, tmpWebp, { quality: 86, alpha: true });
    if (encoded) {
      const buf = fs.readFileSync(tmpWebp);
      atlasHash = sha256(buf);
      atlasUrlName = 'atlas.' + shortHash(atlasHash) + '.webp';
      atlasPath = path.join(outDir, atlasUrlName);
      atlasBytes = buf.length;
      atlasFormat = 'webp';
      fs.renameSync(tmpWebp, atlasPath);
      fs.rmSync(tmpPng, { force: true });
    } else {
      atlasPath = atlasPngPath;
      writeAtomic(atlasPngPath, atlasPngBuf);
      fs.rmSync(tmpPng, { force: true });
    }
  }

  const rig = {
    schemaVersion: RIG_SCHEMA_VERSION,
    id,
    sourceSha256,
    bakeHeight,
    atlas: {
      path: '/assets/v/rig/' + id + '/' + atlasUrlName,
      width: atlas.width,
      height: atlas.height,
      bytes: atlasBytes,
      format: atlasFormat,
      sha256: atlasHash,
    },
    figureHeight,
    serverHeight: 192,
    plateScale,
    box: {
      w: Math.round((box.maxX - box.minX + 1) * scale),
      h: figureHeight,
    },
    joints: Object.fromEntries(Object.entries(joints).map(([k, v]) => [
      k, [Math.round((v[0] - box.minX) * scale), Math.round((v[1] - box.minY) * scale)],
    ])),
    parts,
  };
  const rigJsonBuf = Buffer.from(JSON.stringify(rig) + '\n');
  const rigJsonHash = sha256(rigJsonBuf);
  const jsonName = 'rig.' + shortHash(rigJsonHash) + '.json';
  const jsonPath = path.join(outDir, jsonName);
  if (write) writeAtomic(jsonPath, rigJsonBuf);
  if (overlay && previewDir) {
    fs.mkdirSync(previewDir, { recursive: true });
    writeOverlay(path.join(previewDir, id + '.png'), src, owner, partDefs, OVERLAY_COLORS);
  }
  return {
    rig,
    jsonPath,
    jsonUrl: '/assets/v/rig/' + id + '/' + jsonName,
    jsonBytes: rigJsonBuf.length,
    jsonSha256: rigJsonHash,
    atlasPath,
    atlasFormat,
    atlasBytes,
    atlasSha256: atlasHash,
    hasCwebp: Boolean(cwebpPath()),
  };
}
