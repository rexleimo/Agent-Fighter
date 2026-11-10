/**
 * Sprite animation verification.
 *
 * The old rig "worked" while showing a dislocated sticker. These checks assert
 * the two things the playtest complained about, in real Chrome:
 *
 *   1. every pose renders a whole body (no empty frame),
 *   2. grounded poses share ONE feet baseline (no vertical dislocation),
 *   3. attacks / walk / crouch / special actually differ from idle (motion),
 *   4. facing -1 mirrors the drawing (left/right both read).
 *
 * Usage: node scripts/verify-sprites.mjs   (server must already be running)
 *        node scripts/verify-sprites.mjs --ids ember,cinder
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

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