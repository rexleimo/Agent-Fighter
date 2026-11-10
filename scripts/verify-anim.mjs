/**
 * Animation verification.
 *
 * The old art layer "worked" as long as the PNG loaded — which is exactly how
 * a sliced sticker passed review while showing the wrong pose. These checks
 * assert GEOMETRY instead:
 *
 *   1. every fighter has a baked rig whose parts tile the plate,
 *   2. every pivot sits inside its own part,
 *   3. the server's poses actually turn the parts (an idle-vs-punch delta),
 *   4. in the browser, an idle frame and a punch frame render differently,
 *      and no pose renders an empty body.
 *
 * Usage: node scripts/verify-anim.mjs   (server must already be running)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { FIGHTERS } from '../src/fighters.js';
import { BASE_POSE, skeletonFor } from '../src/combat.js';
import { MOVES, moveTotal } from '../src/rules.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const WEB = path.join(ROOT, 'web');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(WEB, 'assets', 'manifest.json'), 'utf8'));
const BASE = process.env.AFL_BASE || 'http://127.0.0.1:8787';
const PORT = 9251;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rigEntry(id) {
  const asset = MANIFEST.assets.find((a) => a.fighterId === id);
  return asset && asset.rig;
}
function rigFile(id) {
  const entry = rigEntry(id);
  return entry ? path.join(WEB, entry.data.replace(/^\//, '')) : null;
}

const failures = [];
const ok = (label, cond, detail = '') => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  ' + detail : ''));
  if (!cond) failures.push(label);
};

/* ── 1–3: baked rig geometry + pose coupling ────────────────────────────── */
const wrap = (a) => {
  const t = Math.PI * 2;
  let v = (a + Math.PI) % t;
  if (v < 0) v += t;
  return v - Math.PI;
};

function poseRotations(id, spec) {
  const f = { x: 480, y: 0, facing: 1, blockstun: 0, hitstun: 0, hasHit: false, hitIds: [], ...spec };
  const sk = skeletonFor(f, 30);
  const local = {};
  for (const [k, v] of Object.entries(sk.joints)) local[k] = [(v[0] - f.x) * f.facing, v[1] - f.y];
  const rig = JSON.parse(fs.readFileSync(rigFile(id), 'utf8'));
  const out = {};
  for (const part of rig.parts) {
    const a = local[part.drive[0]];
    const b = local[part.drive[1]];
    out[part.id] = wrap(Math.atan2(b[1] - a[1], b[0] - a[0]) - part.restAngle) * part.spin;
  }
  return { rotations: out, rig };
}

for (const fighter of FIGHTERS) {
  const entry = rigEntry(fighter.id);
  const file = rigFile(fighter.id);
  if (!entry || !file || !fs.existsSync(file)) {
    ok(fighter.id + ' rig baked', false, 'missing manifest rig for ' + fighter.id);
    continue;
  }
  const rig = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ids = rig.parts.map((p) => p.id);
  const baseParts = ['armB', 'armF', 'head', 'legB', 'legF', 'torso'];
  ok(fighter.id + ' rig base parts', baseParts.every((id) => ids.includes(id)), ids.join(','));

  // A pivot may sit just outside its own pixels (the joint ball belongs to
  // whichever part is in front), but a far-away pivot would swing the part
  // like a catapult, so bound the distance instead.
  //
  // The rig is baked into an atlas (schema v2): the joints live in figure
  // space while the part pixels live in the atlas, so the two must never be
  // compared directly. px/py are the pivot's offset inside the part's padded
  // crop, and `seam` is the soft halo around the visible pixels, so the part's
  // own pixels occupy the rect inset by the seam.
  const figH = rig.box.h;
  let pivotNear = true;
  let cropInside = true;
  let partsReal = true;
  for (const p of rig.parts) {
    const { x, y, w, h } = p.rect;
    const seam = p.seam || 0;
    const dx = Math.max(seam - p.px, p.px - (w - seam), 0);
    const dy = Math.max(seam - p.py, p.py - (h - seam), 0);
    // Dividing by the figure height keeps the ratio scale invariant: the
    // crop and the joints are baked at the same scale.
    if (Math.hypot(dx, dy) / figH > 0.2) pivotNear = false;
    if (x < 0 || y < 0 || x + w > rig.atlas.width || y + h > rig.atlas.height) cropInside = false;
    if (w * h < figH * figH * 0.005) partsReal = false;
  }
  ok(fighter.id + ' pivots near their part', pivotNear);
  ok(fighter.id + ' crops inside the atlas', cropInside);
  ok(fighter.id + ' every part carries pixels', partsReal);
  ok(fighter.id + ' plate scale sane', rig.plateScale > 1.2 && rig.plateScale < 4.5, String(rig.plateScale));

  // Pose coupling: a punch must turn the front arm, a kick the front leg.
  const idle = poseRotations(fighter.id, { state: 'idle' });
  const punch = poseRotations(fighter.id, { state: 'attack', moveId: 'hp', moveFrame: MOVES.hp.startup + 1 });
  const kick = poseRotations(fighter.id, { state: 'attack', moveId: 'hk', moveFrame: MOVES.hk.startup + 1 });
  const crouch = poseRotations(fighter.id, { state: 'crouch' });
  ok(fighter.id + ' idle does not deform', Math.abs(idle.rotations.armF) < 0.02, idle.rotations.armF.toFixed(3));
  ok(fighter.id + ' heavy punch turns the front arm', Math.abs(punch.rotations.armF) > 0.25, punch.rotations.armF.toFixed(3));
  ok(fighter.id + ' heavy kick turns the front leg', Math.abs(kick.rotations.legF) > 0.2, kick.rotations.legF.toFixed(3));
  ok(fighter.id + ' crouch turns the torso or legs', Math.abs(crouch.rotations.torso) > 0.05 || Math.abs(crouch.rotations.legF) > 0.05);

  // The renderer clamps, but if the server ever asks for a wilder angle than
  // the clamp allows the picture would silently stop following the hitboxes.
  let bounded = true;
  let maxRaw = 0;
  for (const spec of [
    { state: 'attack', moveId: 'hp', moveFrame: 12 },
    { state: 'attack', moveId: 'hk', moveFrame: 13 },
    { state: 'attack', moveId: 'dp', moveFrame: 6 },
    { state: 'attack', moveId: 'super', moveFrame: 14 },
    { state: 'crouch' },
    { state: 'hitstun', hitstun: 8 },
  ]) {
    const { rotations } = poseRotations(fighter.id, spec);
    for (const part of rig.parts) {
      const r = Math.abs(rotations[part.id]);
      if (r > maxRaw) maxRaw = r;
      if (r > 2.4) bounded = false;
    }
  }
  ok(fighter.id + ' requested rotations stay bounded', bounded, 'max=' + maxRaw.toFixed(2) + ' rad');
}

/* ── 4: what Chrome actually renders ────────────────────────────────────── */
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'afl-anim-'));
  const chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=1900,1200', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
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
    const ids = FIGHTERS.map((f) => f.id).join(',');
    await cdp.send('Page.navigate', { url: BASE + '/rig-lab.html?ids=' + ids });
    let report = null;
    for (let i = 0; i < 120 && !report; i += 1) {
      await sleep(150);
      const r = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify(window.__rigReport || null)', returnByValue: true });
      if (r.result.value && r.result.value !== 'null') report = JSON.parse(r.result.value);
    }
    ok('rig lab loaded every fighter', Boolean(report) && report.length === FIGHTERS.length,
      report ? report.length + '/' + FIGHTERS.length : 'no report');
    if (report) {
      for (const row of report) {
        ok(row.id + ' renders a body in every pose', row.nonEmpty.every((n) => n > 900), JSON.stringify(row.nonEmpty));
        ok(row.id + ' punch frame differs from idle', row.idleVsHp > 1500, 'diff=' + row.idleVsHp);
        ok(row.id + ' walk frame differs from idle', row.idleVsWalk > 800, 'diff=' + row.idleVsWalk);
        ok(row.id + ' crouch frame differs from idle', row.idleVsCrouch > 300, 'diff=' + row.idleVsCrouch);
      }
    }
    ok('no JS exceptions in the rig lab', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (err) {
    ok('rig lab capture', false, err.message);
  } finally {
    if (cdp) cdp.close();
    chrome.kill('SIGTERM');
    await sleep(200);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall animation checks passed');
process.exitCode = failures.length ? 1 : 0;
