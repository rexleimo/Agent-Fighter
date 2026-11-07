/**
 * Cutout rig renderer (client side of A2).
 *
 * The server owns the skeleton; this module maps it onto body parts cut from
 * the painted plate (see scripts/rig-bake.mjs). Each part rotates about its
 * own joint pivot by the same ANGULAR DELTA the server applied to the neutral
 * stance, so the picture performs exactly the move the kernel resolved — the
 * illustration is no longer a static sticker with slices sliding over it.
 *
 * Composition happens once per fighter at load: the plate is masked by the
 * baked ownership atlas, producing one small canvas per part.
 */

const rigCache = new Map();

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('rig asset failed: ' + url));
    img.src = url;
  });
}

function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** Crop the ownership atlas and turn one part's colour into an alpha mask. */
function maskFor(maskCtx, crop, color) {
  const data = maskCtx.getImageData(crop.x, crop.y, crop.w, crop.h);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const keep = Math.abs(px[i] - color[0]) < 10
      && Math.abs(px[i + 1] - color[1]) < 10
      && Math.abs(px[i + 2] - color[2]) < 10;
    px[i] = 255;
    px[i + 1] = 255;
    px[i + 2] = 255;
    px[i + 3] = keep ? px[i + 3] : 0;
  }
  const c = canvasOf(crop.w, crop.h);
  c.getContext('2d').putImageData(data, 0, 0);
  return c;
}

const PART_COLORS = {
  armB: [255, 92, 92], legB: [255, 168, 62], torso: [72, 190, 255],
  legF: [255, 240, 96], head: [126, 255, 146], armF: [200, 122, 255],
};

function build(json, plate, mask) {
  const maskCanvas = canvasOf(mask.naturalWidth, json.height);
  const maskCtx = maskCanvas.getContext('2d');
  maskCtx.drawImage(mask, 0, 0);

  const parts = [];
  for (const spec of json.parts.slice().sort((a, b) => a.z - b.z)) {
    const color = PART_COLORS[spec.id];
    if (!color) continue;
    const crop = spec.crop;
    const part = canvasOf(crop.w, crop.h);
    const pctx = part.getContext('2d');
    pctx.drawImage(plate, -crop.x, -crop.y);
    pctx.globalCompositeOperation = 'destination-in';
    pctx.drawImage(maskFor(maskCtx, crop, color), 0, 0);
    pctx.globalCompositeOperation = 'source-over';

    const pivot = json.joints[spec.pivot];
    const root = json.joints.root;
    parts.push({
      id: spec.id,
      z: spec.z,
      canvas: part,
      crop,
      // Pivot in plate space, relative to the figure's root joint: this is
      // where the part turns.
      ax: pivot[0] - root[0],
      ay: pivot[1],
      // Pivot relative to the crop's top-left corner: this is the image offset.
      px: pivot[0] - crop.x,
      py: pivot[1] - crop.y,
      restAngle: spec.restAngle,
      drive: spec.drive,
      follow: spec.follow,
      followK: spec.followK,
      spin: spec.spin,
      clamp: spec.clamp || MAX_PART_SPIN,
    });
  }
  return { id: json.id, json, height: json.height, width: json.width, parts, plateScale: json.plateScale };
}

/** Load (once) and composite the rig for a fighter id. */
export function loadRig(id) {
  if (!rigCache.has(id)) {
    const job = Promise.all([
      fetch('/assets/rig/' + encodeURIComponent(id) + '/rig.json').then((r) => {
        if (!r.ok) throw new Error('no rig for ' + id);
        return r.json();
      }),
      loadImage('/assets/art/' + encodeURIComponent(id) + '.png'),
      loadImage('/assets/rig/' + encodeURIComponent(id) + '/mask.png'),
    ]).then(([json, plate, mask]) => build(json, plate, mask));
    rigCache.set(id, job);
  }
  return rigCache.get(id);
}

const TAU = Math.PI * 2;
// A rigid part cannot rotate arbitrarily far without tearing its joint seam,
// so the projection is clamped; extreme poses are carried by the whole-body
// transform instead (knockdown, super).
const MAX_PART_SPIN = 0.95;

function wrapAngle(a) {
  let v = (a + Math.PI) % TAU;
  if (v < 0) v += TAU;
  return v - Math.PI;
}

/**
 * Draw the rigged body.
 *
 * opts:
 *   html height (screen px), x/y (screen ground contact), dir (facing),
 *   squashX/squashY, lean (whole-body radians), bob,
 *   localJoints {joint: [x, y]} in server-local units (forward +x, down +y),
 *   delta {joint: [dx, dy]} server displacement from the neutral stance.
 *
 * Caller is responsible for the ambient glow / shadow; this draws only the
 * character, already mirrored by `dir`.
 */
export function drawRig(ctx, rig, opts) {
  const { H, x, y, dir } = opts;
  const k = H / rig.height;
  const local = opts.localJoints || {};
  const delta = opts.delta || {};
  const sx = opts.squashX || 1;
  const sy = opts.squashY || 1;

  // The whole body follows the hip joint: a jump, a crouch or the rise of an
  // uppercut is a real translation of the sprite, not a scale hack.
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
    // A joint's own travel also slides the part, so a punch reaches out
    // instead of just swinging in place.
    let tx = 0, ty = 0;
    if (part.follow && part.followK) {
      const d = delta[part.follow[0]];
      if (d) {
        // Relative to the hip, because the body already moved with it.
        tx = (d[0] - hipD[0]) * part.followK * rig.plateScale;
        ty = (d[1] - hipD[1]) * part.followK * rig.plateScale;
      }
    }
    // Plate space -> screen space: the plate's bottom edge is the ground
    // contact (y = 0), the root joint is the horizontal centre.
    ctx.save();
    ctx.translate((part.ax + tx) * k, (part.ay - rig.height + ty) * k);
    if (angle) ctx.rotate(angle);
    // The crop's own top-left sits px/py pixels away from the pivot.
    ctx.drawImage(part.canvas,
      0, 0, part.crop.w, part.crop.h,
      -part.px * k, -part.py * k, part.crop.w * k, part.crop.h * k);
    ctx.restore();
  }
  ctx.restore();
}

/** Screen-space bounding box of the drawn rig, for hit feedback placement. */
export function rigBounds(rig, opts) {
  const k = opts.H / rig.height;
  return {
    w: rig.json.box.w * k,
    h: rig.json.box.h * k,
    cx: opts.x,
    top: opts.y - rig.json.box.h * k,
  };
}
