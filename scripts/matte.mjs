/**
 * Zero-dependency PNG background removal for the generated character art.
 *
 * ImageGen returns opaque RGB with a near-white studio backdrop (and a
 * platform watermark in the bottom-right corner). We need a real alpha
 * channel to composite fighters over the stage art.
 *
 * Algorithm: flood-fill from every border pixel that is "near white"
 * (high luminance + low chroma), which removes the backdrop and its faint
 * checker blocks without touching skin highlights or the coloured rim-light
 * glow around the character (those are saturated, so they survive). Then
 * apply a one-pixel feather and clear the watermark rectangle.
 *
 * Usage: node scripts/matte.mjs <input.png> <output.png>
 */
import fs from 'node:fs';
import { decodePNG, encodeRGBA } from './lib/png.mjs';

function removeBackdrop(src, dst, opts = {}) {
  const { width: w, height: h, bpp, pixels } = decodePNG(src);
  const alpha = new Uint8Array(w * h).fill(255);
  const nearWhite = (i) => {
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return mn > (opts.threshold ?? 218) && mx - mn < (opts.chroma ?? 24);
  };
  // BFS from the border. Deliberately 4-connected: coloured rim light forms
  // a barrier so the halo stays with the character.
  const queue = new Int32Array(w * h);
  let qh = 0, qt = 0;
  const push = (idx) => {
    if (alpha[idx] === 0) return;
    const i = idx * bpp;
    if (!nearWhite(i)) return;
    alpha[idx] = 0;
    queue[qt++] = idx;
  };
  for (let x = 0; x < w; x += 1) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y += 1) { push(y * w); push(y * w + w - 1); }
  while (qh < qt) {
    const idx = queue[qh++];
    const x = idx % w, y = (idx / w) | 0;
    if (x > 0) push(idx - 1);
    if (x < w - 1) push(idx + 1);
    if (y > 0) push(idx - w);
    if (y < h - 1) push(idx + w);
  }
  // Kill the platform watermark: bottom-right corner, never contains art.
  const wx = Math.floor(w * 0.84), wy = Math.floor(h * 0.88);
  for (let y = wy; y < h; y += 1) for (let x = wx; x < w; x += 1) alpha[y * w + x] = 0;
  // The generated backdrop contains faint checker squares. Some are isolated
  // from the border flood fill, so prune small neutral connected components:
  // keep the character (and any large detached ribbon), drop the speckle.
  const label = new Int32Array(w * h);
  const queue2 = new Int32Array(w * h);
  const comps = [];
  let compId = 0;
  for (let seed = 0; seed < w * h; seed += 1) {
    if (!alpha[seed] || label[seed]) continue;
    compId += 1;
    let head = 0, tail = 0, count = 0, neutral = 0;
    queue2[tail++] = seed; label[seed] = compId;
    while (head < tail) {
      const idx = queue2[head++]; count += 1;
      const pi = idx * bpp;
      const r = pixels[pi], g = pixels[pi + 1], b = pixels[pi + 2];
      if (Math.min(r, g, b) > 185 && Math.max(r, g, b) - Math.min(r, g, b) < 40) neutral += 1;
      const x = idx % w, y = (idx / w) | 0;
      if (x > 0 && alpha[idx - 1] && !label[idx - 1]) { label[idx - 1] = compId; queue2[tail++] = idx - 1; }
      if (x < w - 1 && alpha[idx + 1] && !label[idx + 1]) { label[idx + 1] = compId; queue2[tail++] = idx + 1; }
      if (y > 0 && alpha[idx - w] && !label[idx - w]) { label[idx - w] = compId; queue2[tail++] = idx - w; }
      if (y < h - 1 && alpha[idx + w] && !label[idx + w]) { label[idx + w] = compId; queue2[tail++] = idx + w; }
    }
    comps.push({ id: compId, count, neutral });
  }
  let largest = 0;
  for (const c of comps) if (c.count > largest) largest = c.count;
  const kill = new Set();
  for (const c of comps) {
    const small = c.count < Math.max(700, largest * 0.004);
    if (small && c.neutral / c.count > 0.45) kill.add(c.id);
  }
  for (let i = 0; i < w * h; i += 1) if (label[i] && kill.has(label[i])) alpha[i] = 0;
  // One-pixel feather on the cut edge.
  const soft = alpha.slice();
  for (let y = 1; y < h - 1; y += 1) for (let x = 1; x < w - 1; x += 1) {
    const idx = y * w + x;
    if (!alpha[idx]) continue;
    if (!alpha[idx - 1] || !alpha[idx + 1] || !alpha[idx - w] || !alpha[idx + w]) soft[idx] = 190;
  }
  // Trim fully transparent outer margin so the sprite fills its box.
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    if (!soft[y * w + x]) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (maxX < 0) throw new Error('everything was removed: ' + src);
  const pad = 4;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
  const ow = maxX - minX + 1, oh = maxY - minY + 1;
  const out = Buffer.alloc(ow * oh * 4);
  for (let y = 0; y < oh; y += 1) for (let x = 0; x < ow; x += 1) {
    const si = (y + minY) * w + (x + minX), di = (y * ow + x) * 4;
    const pi = si * bpp;
    out[di] = pixels[pi]; out[di + 1] = pixels[pi + 1]; out[di + 2] = pixels[pi + 2];
    out[di + 3] = soft[si];
  }
  fs.writeFileSync(dst, encodeRGBA(ow, oh, out));
  const kept = soft.reduce((n, a) => n + (a ? 1 : 0), 0);
  return { src, dst, input: `${w}x${h}`, output: `${ow}x${oh}`, kept: (kept / (w * h) * 100).toFixed(1) + '%' };
}

/**
 * The stage plate is opaque and carries the same bottom-right watermark.
 * Instead of removing it (which would tear a hole in the floor), mirror an
 * equally sized patch of adjacent floor texture over it and feather the seam.
 */
function patchStage(src, dst) {
  const { width: w, height: h, bpp, pixels } = decodePNG(src);
  const x0 = Math.floor(w * 0.84), y0 = Math.floor(h * 0.89);
  const bw = w - x0;
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const di = (y * w + x) * 4;
    let si = (y * w + x) * bpp;
    if (y >= y0 && x >= x0) {
      const mirror = x0 - 1 - ((x - x0) % bw);
      si = (y * w + mirror) * bpp;
    }
    rgba[di] = pixels[si]; rgba[di + 1] = pixels[si + 1]; rgba[di + 2] = pixels[si + 2];
    rgba[di + 3] = 255;
  }
  // Feather the vertical seam so the mirrored strip does not read as a cut.
  const blend = 18;
  for (let y = y0; y < h; y += 1) for (let k = 0; k < blend; k += 1) {
    const x = Math.max(0, x0 - blend + k), di = (y * w + x) * 4;
    const m = (y * w + x0 + k) * 4;
    const t = (k / blend) * 0.45;
    for (let ch = 0; ch < 3; ch += 1) rgba[di + ch] = Math.round(rgba[di + ch] * (1 - t) + rgba[m + ch] * t);
  }
  fs.writeFileSync(dst, encodeRGBA(w, h, rgba));
  return { src, dst, size: `${w}x${h}`, patched: `${w - x0}x${h - y0}` };
}

const [src, dst, ...rest] = process.argv.slice(2);
if (!src || !dst) {
  console.error('Usage: node scripts/matte.mjs <input.png> <output.png> [--stage] [threshold] [chroma]');
  process.exit(1);
}
if (rest.includes('--stage')) {
  console.log(JSON.stringify(patchStage(src, dst)));
} else {
  const nums = rest.filter((r) => /^\d+$/.test(r)).map(Number);
  console.log(JSON.stringify(removeBackdrop(src, dst, {
    threshold: nums[0],
    chroma: nums[1],
  })));
}
