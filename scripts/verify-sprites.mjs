/**
 * Sprite animation verification.
 *
 * The old rig "worked" while showing a dislocated sticker. These checks assert
 * the things the playtest complained about, in real Chrome:
 *
 *   1. every pose renders a whole body (no empty frame),
 *   2. grounded poses share ONE feet baseline (no vertical dislocation),
 *   3. attacks / walk / crouch / special actually differ from idle (motion),
 *   4. facing -1 mirrors the drawing (left/right both read),
 *   5. impact cues mirror with the fighter too, not just the bodies,
 *   6. upright actions keep ONE body height, measured off the shipped atlases.
 *
 * Usage: node scripts/verify-sprites.mjs   (server must already be running)
 *        node scripts/verify-sprites.mjs --ids ember,cinder
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { OFF_MODEL_ART } from './sprites/sheets.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const WEB = path.join(ROOT, 'web');
const BASE = process.env.AFL_BASE || 'http://127.0.0.1:8787';
const PORT = 9252;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const index = JSON.parse(fs.readFileSync(path.join(WEB, 'assets', 'sprites.json'), 'utf8'));
const ids = arg('--ids', index.fighters.map((f) => f.id).join(',')).split(',').filter(Boolean);

const failures = [];
const ok = (label, cond, detail = '') => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  ' + detail : ''));
  if (!cond) failures.push(label);
};

/**
 * Source evaluated in the page to measure impact-cue mirroring. The stage draws
 * bodies mirrored by facing (sprite.js scales by -facing), and the player's
 * complaint was that the effects did not follow: a guard crescent that opened
 * the same way for both fighters reads as the right-hand fighter blocking
 * backwards. This renders every cue once on the +1-facing side and once on the
 * -1-facing side, then measures the ink.
 *
 * Returns, per cue type, the ink on each side, the fraction of pixels that
 * agree once one render is flipped about the impact point (a true mirror
 * scores ~1.0), and the fraction of ink that moved between the two sides (a
 * cue blind to facing scores 0, which is the failure this exists to catch).
 */
function cueMirrorSource(base) {
  return `(async () => {
  const W = 240, H = 160, CX = 120, CY = 80;
  const { createImpactFx } = await import(${JSON.stringify(base)} + '/impact-fx.js');
  function measure(type, side) {
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d');
    c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
    const fx = createImpactFx({ ground: CY });
    // by/on carry the side letters, exactly as the engine emits them.
    fx.ingest([{ type, frame: 0, x: CX, y: 0, on: side, by: side, damage: 40, combo: 3 }]);
    fx.draw(c, { frame: 8, a: { facing: 1 }, b: { facing: -1 } }, null, W, H);
    const d = c.getImageData(0, 0, W, H).data;
    let ink = 0;
    const mask = new Uint8Array(W * H);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const i = (y * W + x) * 4;
        if (d[i] + d[i + 1] + d[i + 2] > 24) { ink += 1; mask[y * W + x] = 1; }
      }
    }
    return { ink, mask };
  }
  const out = {};
  for (const type of ['hit', 'block', 'armor', 'wakeup']) {
    const plus = measure(type, 'a'), minus = measure(type, 'b');
    let same = 0, swapped = 0;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        if (plus.mask[y * W + x] === minus.mask[y * W + (W - 1 - x)]) same += 1;
        if (plus.mask[y * W + x] !== minus.mask[y * W + x]) swapped += 1;
      }
    }
    out[type] = {
      inkPlus: plus.ink, inkMinus: minus.ink,
      mirrorExact: +(same / (W * H)).toFixed(3),
      // Ink that moved between the two sides. The centroid cannot be the judge
      // here: a hit carries a damage number, and glyphs must stay readable, so
      // that text is deliberately drawn the same for both fighters and would
      // skew it. Whatever DOES move is the shape that mirrors.
      swapped: +(swapped / Math.min(plus.ink, minus.ink)).toFixed(3),
    };
  }
  return out;
})()`;
}

/**
 * Source evaluated in the page to measure body height per clip from the SHIPPED
 * atlases. 一大一小 is a claim about what the renderer actually receives, so
 * this decodes the released webp files and reads the ink span of every frame
 * instead of trusting the bake's intentions. Ratios are against the same
 * fighter's own idle, so a tall character and a short one are judged alike, and
 * only clips that stand upright in the game's own terms are measured: a dash
 * leans the body forward and a crouch drops it, and both are correct art.
 */
function sizeContractSource(base) {
  return `(async () => {
  const UPRIGHT = ['idle', 'walk', 'guard', 'blockstun', 'hitstun'];
  const idx = await (await fetch(${JSON.stringify(base)} + '/assets/sprites.json')).json();
  const atlases = new Map();
  async function atlas(url) {
    if (atlases.has(url)) return atlases.get(url);
    const img = new Image();
    img.src = url;
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const c = cv.getContext('2d', { willReadFrequently: true });
    c.drawImage(img, 0, 0);
    atlases.set(url, c);
    return c;
  }
  function spanOf(c, r) {
    const d = c.getImageData(r.x, r.y, r.w, r.h).data;
    let top = -1, bottom = -1;
    for (let y = 0; y < r.h; y += 1) {
      let row = 0;
      for (let x = 0; x < r.w; x += 1) if (d[(y * r.w + x) * 4 + 3] > 24) row += 1;
      if (row >= 3) { if (top < 0) top = y; bottom = y; }
    }
    return top < 0 ? 0 : bottom - top + 1;
  }
  const out = {};
  for (const entry of idx.fighters) {
    const anim = await (await fetch(${JSON.stringify(base)} + entry.anim)).json();
    const spans = {};
    for (const clipId of UPRIGHT) {
      const clip = anim.clips[clipId];
      if (!clip) continue;
      const c = await atlas(${JSON.stringify(base)} + anim.sheets[clip.sheet].atlas);
      spans[clipId] = Math.max(...clip.frames.map((r) => spanOf(c, r)));
    }
    const stance = spans.idle || 1;
    out[entry.id] = {
      stance,
      ratio: Object.fromEntries(Object.entries(spans).map(([k, v]) => [k, +(v / stance).toFixed(3)])),
      from: Object.fromEntries(Object.entries(anim.clips).filter(([k]) => UPRIGHT.includes(k))
        .map(([k, clip]) => [k, clip.sheet])),
    };
  }
  return out;
})()`;
}

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);
const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));

function connect(wsUrl, sink) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === 'Runtime.exceptionThrown') {
        sink.push(msg.params.exceptionDetails.text + ' ' + (msg.params.exceptionDetails.exception?.description || ''));
      }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
      }
    };
    ws.onerror = reject;
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          id += 1;
          pending.set(id, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      close: () => ws.close(),
    });
  });
}

if (!chromePath) {
  ok('headless browser available', false, 'set CHROME_PATH');
} else {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'afl-sprite-'));
  const shotDir = process.env.AFL_SHOT_DIR || os.tmpdir();
  const chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=2100,1400', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
    '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore' });
  const errors = [];
  let cdp;
  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i += 1) {
      try {
        const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
        target = list.find((t) => t.type === 'page');
      } catch { /* starting */ }
      if (!target) await sleep(150);
    }
    if (!target) throw new Error('devtools did not start');
    cdp = await connect(target.webSocketDebuggerUrl, errors);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: BASE + '/sprite-lab.html?ids=' + ids.join(',') });
    let report = null;
    for (let i = 0; i < 160 && !report; i += 1) {
      await sleep(150);
      const r = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify(window.__spriteReport || null)', returnByValue: true });
      if (r.result.value && r.result.value !== 'null') report = JSON.parse(r.result.value);
    }
    ok('sprite lab loaded every fighter', Boolean(report) && report.length === ids.length,
      report ? report.length + '/' + ids.length : 'no report');
    if (report) {
      for (const row of report) {
        ok(row.id + ' sprites ready', row.ready);
        ok(row.id + ' whole body in every pose', row.nonEmpty.every((n) => n > 900), JSON.stringify(row.nonEmpty));
        ok(row.id + ' grounded feet share one baseline', row.feetSpread >= 0 && row.feetSpread <= 6,
          'spread=' + row.feetSpread + 'px bottoms=' + JSON.stringify(row.groundedBottoms));
        ok(row.id + ' heavy punch differs from idle', row.idleVsHp > 1500, 'diff=' + row.idleVsHp);
        ok(row.id + ' walk differs from idle', row.idleVsWalk > 600, 'diff=' + row.idleVsWalk);
        ok(row.id + ' crouch differs from idle', row.idleVsCrouch > 300, 'diff=' + row.idleVsCrouch);
        ok(row.id + ' special differs from idle', row.idleVsSpecial > 1500, 'diff=' + row.idleVsSpecial);
        ok(row.id + ' facing mirrors the drawing', row.mirrorNonEmpty > 900 && row.mirrorDiff > 1500,
          'mirrorDiff=' + row.mirrorDiff);
      }
      // Visual evidence outside the repo.
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      const file = path.join(shotDir, 'afl-sprite-lab-' + ids.join('_') + '.png');
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      console.log('  screenshot: ' + file);

      // Impact cues, measured on the same page so the check needs no fixture.
      const fx = await cdp.send('Runtime.evaluate', {
        expression: cueMirrorSource(BASE), awaitPromise: true, returnByValue: true,
      });
      const cues = fx.result.value || {};
      for (const type of ['hit', 'block', 'armor', 'wakeup']) {
        const r = cues[type];
        ok(type + ' cue opens toward the fighter it belongs to',
          Boolean(r) && r.inkPlus > 40 && r.mirrorExact > 0.95 && r.swapped > 0.15,
          r ? 'mirror=' + r.mirrorExact + ' moved=' + r.swapped
            + ' ink=' + r.inkPlus + '/' + r.inkMinus : 'no measurement');
      }

      // Body height per action, read off the files the browser actually loads.
      const sizes = await cdp.send('Runtime.evaluate', {
        expression: sizeContractSource(BASE), awaitPromise: true, returnByValue: true,
      });
      const bodies = sizes.result.value || {};
      ok('shipped atlases cover every fighter', Object.keys(bodies).length === ids.length,
        Object.keys(bodies).length + '/' + ids.length);
      for (const id of ids) {
        const row = bodies[id];
        if (!row) continue;
        const outOfBand = [];
        for (const [clipId, ratio] of Object.entries(row.ratio)) {
          // A clip drawn from a registered off-model sheet is held to the
          // residual the register promised, not to the general band: that is
          // what turns the art debt from a comment into a checked number.
          const debt = OFF_MODEL_ART[id + '/' + (row.from[clipId] || '')];
          const floor = debt ? +(debt.residualShare - 0.05).toFixed(3) : 0.85;
          if (ratio < floor || ratio > 1.15) outOfBand.push(clipId + '=' + ratio + '(>=' + floor + ')');
        }
        ok(id + ' upright actions keep one body height', outOfBand.length === 0,
          'stance=' + row.stance + 'px ' + JSON.stringify(row.ratio)
          + (outOfBand.length ? ' out=' + outOfBand.join(',') : ''));
      }
    }
    ok('no JS exceptions in the sprite lab', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (err) {
    ok('sprite lab capture', false, err.message);
  } finally {
    if (cdp) cdp.close();
    chrome.kill('SIGTERM');
    await sleep(200);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall sprite checks passed');
process.exitCode = failures.length ? 1 : 0;