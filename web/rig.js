/**
 * Cutout rig renderer v2.
 *
 * The build bakes all six/eight parts into one atlas and emits a compact
 * schema-2 JSON. This module loads those two files and draws atlas rects; it
 * never decodes a full-size ownership mask or composites part canvases on the
 * main thread. The server still owns the skeleton: the picture is a projection.
 */
import { loadRigAtlas, loadRigData } from './asset-store.js';

const rigCache = new Map();

function wrapAngle(a) {
  const t = Math.PI * 2;
  let v = (a + Math.PI) % t;
  if (v < 0) v += t;
  return v - Math.PI;
}

function build(data, atlas) {
  return {
    id: data.id,
    data,
    atlas,
    figureHeight: data.figureHeight,
    plateScale: data.plateScale,
    box: data.box,
    parts: data.parts.map((part) => ({
      id: part.id,
      z: part.z,
      pivot: part.pivot,
      rect: part.rect,
      px: part.px,
      py: part.py,
      ax: part.ax,
      ay: part.ay,
      restAngle: part.restAngle,
      drive: part.drive,
      follow: part.follow || [],
      followK: part.followK || 0,
      spin: part.spin,
      clamp: part.clamp || 0.95,
      seam: part.seam || 0,
    })),
  };
}

/** Load (once) and build the rig for a fighter id. */
export function loadRig(id) {
  if (!rigCache.has(id)) {
    const job = (async () => {
      const data = await loadRigData(id);
      if (!data) throw new Error('no rig data for ' + id);
      const atlas = await loadRigAtlas(data);
      if (!atlas) throw new Error('no rig atlas for ' + id);
      return build(data, atlas);
    })().catch((error) => {
      rigCache.delete(id);
      throw error;
    });
    rigCache.set(id, job);
  }
  return rigCache.get(id);
}

/**
 * Draw the rigged body.
 *
 * opts:
 *   H (screen height), x/y (ground contact), dir (facing),
 *   squashX/squashY, lean (whole-body radians), bob,
 *   localJoints {joint: [x, y]} in server-local units,
 *   delta {joint: [dx, dy]} server displacement from neutral.
 */
export function drawRig(ctx, rig, opts) {
  const { H, x, y, dir } = opts;
  const k = H / rig.figureHeight;
  const local = opts.localJoints || {};
  const delta = opts.delta || {};
  const sx = opts.squashX || 1;
  const sy = opts.squashY || 1;

  const hipD = delta.hip || [0, 0];
  const bodyX = hipD[0] * rig.plateScale;
  const bodyY = hipD[1] * rig.plateScale;

  ctx.save();
  ctx.translate(x + bodyX * k, y + (opts.bob || 0) + bodyY * k);
  if (opts.lean) ctx.rotate(opts.lean);
  ctx.scale(dir * sx, sy);

  for (const part of rig.parts) {
    const a = local[part.drive[0]];
    const b = local[part.drive[1]];
    let angle = 0;
    if (a && b) {
      angle = wrapAngle(Math.atan2(b[1] - a[1], b[0] - a[0]) - part.restAngle) * part.spin;
      if (angle > part.clamp) angle = part.clamp;
      else if (angle < -part.clamp) angle = -part.clamp;
    }
    let tx = 0, ty = 0;
    if (part.follow.length && part.followK) {
      const d = delta[part.follow[0]];
      if (d) {
        tx = (d[0] - hipD[0]) * part.followK * rig.plateScale;
        ty = (d[1] - hipD[1]) * part.followK * rig.plateScale;
      }
    }
    ctx.save();
    ctx.translate((part.ax + tx) * k, (part.ay - rig.figureHeight + ty) * k);
    if (angle) ctx.rotate(angle);
    ctx.drawImage(
      rig.atlas,
      part.rect.x, part.rect.y, part.rect.w, part.rect.h,
      -part.px * k, -part.py * k, part.rect.w * k, part.rect.h * k,
    );
    ctx.restore();
  }
  ctx.restore();
}

/** Screen-space bounding box of the drawn rig, for hit feedback placement. */
export function rigBounds(rig, opts) {
  const k = opts.H / rig.figureHeight;
  return {
    w: rig.box.w * k,
    h: rig.box.h * k,
    cx: opts.x,
    top: opts.y - rig.box.h * k,
  };
}
