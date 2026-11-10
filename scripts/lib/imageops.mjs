/**
 * Zero-dependency image operations for the asset build pipeline.
 *
 * The runtime never imports this file. It exists so the build can resize,
 * crop, hash, pack and validate PNG/WebP assets without adding an npm
 * dependency. WebP is an optional build-time optimization (cwebp); the
 * canonical PNG path always works on its own.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readRGBA, encodeRGBA } from './png.mjs';

export const PIPELINE_VERSION = 'afl-assets-v1';

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function hashFile(file) {
  return sha256(fs.readFileSync(file));
}

export function shortHash(hex, n = 12) {
  return hex.slice(0, n);
}

/** Atomic write: never leave a half-written derivative for a client to fetch. */
export function writeAtomic(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}

export function writePNG(file, width, height, rgba, options = {}) {
  writeAtomic(file, encodeRGBA(width, height, rgba, options));
}

/**
 * Alpha-aware box downscale. Input and output are RGBA buffers.
 * Colour is averaged in premultiplied space so transparent pixels do not
 * pull the visible edge toward black.
 */
export function resizeRGBA(src, dw, dh) {
  const { width: sw, height: sh, rgba } = src;
  if (dw === sw && dh === sh) return { width: sw, height: sh, rgba };
  if (dw <= 0 || dh <= 0) throw new Error('resizeRGBA: target must be positive');
  if (dw > sw || dh > sh) throw new Error('resizeRGBA: refusing to upscale');
  const out = Buffer.alloc(dw * dh * 4);
  const x0 = new Int32Array(dw), x1 = new Int32Array(dw);
  const y0 = new Int32Array(dh), y1 = new Int32Array(dh);
  for (let x = 0; x < dw; x += 1) {
    x0[x] = Math.floor((x * sw) / dw);
    x1[x] = Math.max(x0[x] + 1, Math.ceil(((x + 1) * sw) / dw));
  }
  for (let y = 0; y < dh; y += 1) {
    y0[y] = Math.floor((y * sh) / dh);
    y1[y] = Math.max(y0[y] + 1, Math.ceil(((y + 1) * sh) / dh));
  }
  for (let y = 0; y < dh; y += 1) {
    for (let x = 0; x < dw; x += 1) {
      let sr = 0, sg = 0, sb = 0, sa = 0, count = 0;
      for (let sy = y0[y]; sy < y1[y]; sy += 1) {
        let si = (sy * sw + x0[x]) * 4;
        for (let sx = x0[x]; sx < x1[x]; sx += 1) {
          const a = rgba[si + 3];
          sr += rgba[si] * a;
          sg += rgba[si + 1] * a;
          sb += rgba[si + 2] * a;
          sa += a;
          count += 1;
          si += 4;
        }
      }
      const di = (y * dw + x) * 4;
      if (sa > 0) {
        out[di] = Math.round(sr / sa);
        out[di + 1] = Math.round(sg / sa);
        out[di + 2] = Math.round(sb / sa);
        out[di + 3] = Math.round(sa / count);
      }
    }
  }
  return { width: dw, height: dh, rgba: out };
}

/** Resize to a target height, preserving the source aspect ratio. */
export function resizeToHeight(src, height) {
  const width = Math.max(1, Math.round((src.width * height) / src.height));
  return resizeRGBA(src, width, Math.min(height, src.height));
}

/** Resize to a target width, preserving the source aspect ratio. */
export function resizeToWidth(src, width) {
  const height = Math.max(1, Math.round((src.height * width) / src.width));
  return resizeRGBA(src, Math.min(width, src.width), height);
}

export function cropRGBA(src, x, y, w, h) {
  const out = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row += 1) {
    const si = ((y + row) * src.width + x) * 4;
    src.rgba.copy(out, row * w * 4, si, si + w * 4);
  }
  return { width: w, height: h, rgba: out };
}

export function alphaStats(img, border = 1) {
  let opaque = 0, transparent = 0, borderTransparent = 0, borderPixels = 0;
  const { width: w, height: h, rgba } = img;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const a = rgba[(y * w + x) * 4 + 3];
      if (a > 8) opaque += 1; else transparent += 1;
      if (x < border || y < border || x >= w - border || y >= h - border) {
        borderPixels += 1;
        if (a <= 8) borderTransparent += 1;
      }
    }
  }
  return {
    total: w * h,
    opaque,
    transparent,
    opaqueRatio: opaque / (w * h),
    borderTransparentRatio: borderPixels ? borderTransparent / borderPixels : 0,
  };
}

/** Deterministic shelf packer with a 2 px gutter. Rects never overlap. */
export function shelfPack(items, { gutter = 2, maxWidth = 1024 } = {}) {
  const totalArea = items.reduce((sum, item) => sum + (item.w + gutter) * (item.h + gutter), 0);
  const wanted = Math.max(64, Math.ceil(Math.sqrt(totalArea) * 1.08));
  let width = Math.min(maxWidth, 2 ** Math.ceil(Math.log2(wanted)));
  if (!Number.isFinite(width) || width < 64) width = 64;
  let x = 0, y = 0, rowH = 0;
  const placed = [];
  for (const item of items) {
    if (item.w + gutter > width) width = 2 ** Math.ceil(Math.log2(item.w + gutter));
    if (x + item.w + gutter > width) {
      x = 0;
      y += rowH + gutter;
      rowH = 0;
    }
    placed.push({ ...item, x, y });
    x += item.w + gutter;
    if (item.h > rowH) rowH = item.h;
  }
  const height = y + rowH;
  return { width, height, placed };
}

export function blitRGBA(dst, rect, src) {
  for (let row = 0; row < src.height; row += 1) {
    const di = ((rect.y + row) * dst.width + rect.x) * 4;
    src.rgba.copy(dst.rgba, di, row * src.width * 4, (row + 1) * src.width * 4);
  }
}

/* ---------------------------------------------------------------- WebP */

export function cwebpPath() {
  const candidate = process.env.CWEBP || 'cwebp';
  const probe = spawnSync(candidate, ['-version'], { encoding: 'utf8' });
  return probe.status === 0 ? candidate : null;
}

export function encodeWebP(pngFile, webpFile, { quality = 82, alpha = true } = {}) {
  const bin = cwebpPath();
  if (!bin) return null;
  const args = ['-quiet', '-q', String(quality), '-m', '6', '-metadata', 'none'];
  if (alpha) args.push('-alpha_q', '90');
  args.push(pngFile, '-o', webpFile);
  const result = spawnSync(bin, args, { encoding: 'utf8' });
  if (result.status !== 0 || !fs.existsSync(webpFile)) return null;
  return { path: webpFile, bytes: fs.statSync(webpFile).size };
}

/** Read dimensions + alpha flag from a WebP header without decoding pixels. */
export function probeWebP(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    const flags = buf[20];
    const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { width, height, alpha: Boolean(flags & 0x10), format: 'webp' };
  }
  if (chunk === 'VP8 ') {
    const width = buf.readUInt16LE(26) & 0x3FFF;
    const height = buf.readUInt16LE(28) & 0x3FFF;
    return { width, height, alpha: false, format: 'webp' };
  }
  if (chunk === 'VP8L') {
    const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
    const width = 1 + (((b1 & 0x3F) << 8) | b0);
    const height = 1 + (((b3 & 0x0F) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6));
    return { width, height, alpha: Boolean((b3 & 0x10) !== 0), format: 'webp' };
  }
  return null;
}

export function probePNG(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504E47) return null;
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
    alpha: buf[25] === 6,
    format: 'png',
  };
}

export function probeImage(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return probePNG(file);
  if (ext === '.webp') return probeWebP(file);
  return null;
}

export function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Full RGBA read for PNG sources; WebP is not decoded by the build. */
export function readPNG(file) {
  const { width, height, rgba } = readRGBA(file);
  return { width, height, rgba };
}

/** Write a variant pair: canonical PNG + optional WebP sibling.
 *  `keepPng: false` drops the PNG once the WebP exists — every modern browser
 *  serves WebP, and the PNG twin doubles the shipped asset weight. */
export function writeVariantPair({
  dir,
  name,
  image,
  hash,
  alpha,
  quality = 82,
  write,
  keepPng = true,
}) {
  const base = `${name}.${shortHash(hash)}`;
  const pngPath = path.join(dir, `${base}.png`);
  const webpPath = path.join(dir, `${base}.webp`);
  if (write) {
    writePNG(pngPath, image.width, image.height, image.rgba);
    encodeWebP(pngPath, webpPath, { quality, alpha });
  }
  const webpBytes = fs.existsSync(webpPath) ? fs.statSync(webpPath).size : null;
  const pngBytes = write ? fs.statSync(pngPath).size : encodeRGBA(image.width, image.height, image.rgba).length;
  if (write && !keepPng && webpBytes !== null) fs.unlinkSync(pngPath);
  return {
    pngPath,
    webpPath: fs.existsSync(webpPath) ? webpPath : null,
    pngBytes,
    webpBytes,
  };
}
