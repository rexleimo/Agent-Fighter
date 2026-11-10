/**
 * Asset delivery acceptance.
 *
 * Proves the things the old art verifier could not:
 *   - live view requests only the two active fighters + stage + rig;
 *   - no full-size /assets/art or mask.png requests on the new client;
 *   - live transfer stays inside the byte budget;
 *   - gallery cards load only when the gallery view is active;
 *   - manifest is no-cache + ETag, hashed assets are immutable;
 *   - legacy URLs still resolve.
 *
 * Usage: node scripts/verify-assets.mjs (server must already be running)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.AFL_BASE || 'http://127.0.0.1:8787';
const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9261;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const ok = (label, cond, detail = '') => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (detail ? '  ' + detail : ''));
  if (!cond) failures.push(label);
};

let state;
for (let i = 0; i < 40; i += 1) {
  try { const r = await fetch(BASE + '/api/state'); if (r.ok) { state = await r.json(); break; } } catch { /* starting */ }
  await sleep(200);
}
if (!state) { console.error('服务未启动：' + BASE); process.exit(1); }
ok('server advertises the asset manifest', state.assets && state.assets.ok === true, JSON.stringify(state.assets || null));

const manifest = await (await fetch(BASE + '/assets/manifest.json')).json();
ok('manifest has 16 fighters + stage', manifest.assets.length === 17
  && manifest.assets.filter((a) => a.kind === 'fighter-plate').length === 16);

// Header checks -------------------------------------------------------------
{
  const res = await fetch(BASE + '/assets/manifest.json');
  const headers = res.headers;
  ok('manifest is no-cache', /no-cache/.test(headers.get('cache-control') || ''));
  ok('manifest has ETag', Boolean(headers.get('etag')));
  const etag = headers.get('etag');
  const cached = await fetch(BASE + '/assets/manifest.json', { headers: { 'If-None-Match': etag } });
  ok('manifest If-None-Match -> 304', cached.status === 304, String(cached.status));
  const gz = await fetch(BASE + '/assets/manifest.json', { headers: { 'Accept-Encoding': 'gzip' } });
  ok('manifest gzip', gz.headers.get('content-encoding') === 'gzip', gz.headers.get('content-encoding') || '');

  const variant = manifest.assets.find((a) => a.kind === 'fighter-plate').variants[0];
  const asset = await fetch(BASE + variant.path);
  ok('hashed asset immutable', /immutable/.test(asset.headers.get('cache-control') || ''), asset.headers.get('cache-control') || '');
  ok('hashed asset has Content-Length', Boolean(asset.headers.get('content-length')));
  const legacy = await fetch(BASE + '/assets/art/ember.png');
  ok('legacy /assets/art/<id>.png still resolves', legacy.status === 200, String(legacy.status));
  const oldRig = await fetch(BASE + '/assets/rig/ember/rig.json');
  ok('legacy /assets/rig/<id>/rig.json still resolves', oldRig.status === 200, String(oldRig.status));
}

// Browser checks ------------------------------------------------------------
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chromePath) {
  ok('headless browser available', false, 'set CHROME_PATH');
} else {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'afl-assets-'));
  const chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=1440,1250', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
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
    cdp = await new Promise((resolve, reject) => {
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      const pending = new Map();
      let id = 0;
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.method === 'Runtime.exceptionThrown') {
          errors.push(msg.params.exceptionDetails.text + ' ' + (msg.params.exceptionDetails.exception?.description || ''));
        }
        if (msg.id && pending.has(msg.id)) {
          const p = pending.get(msg.id); pending.delete(msg.id);
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
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1250, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: BASE + '/' });
    await sleep(5500);

    const live = JSON.parse((await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify((()=>{
        const entries = performance.getEntriesByType('resource').filter(e => e.name.includes('/assets/'));
        const names = entries.map(e => new URL(e.name).pathname);
        const plays = [...new Set(names.filter(n => /\\/assets\\/v\\/[a-z0-9-]+\\/play-512\\./.test(n)))];
        const rigs = names.filter(n => /\\/assets\\/v\\/rig\\//.test(n));
        const cards = names.filter(n => /\\/assets\\/v\\/[a-z0-9-]+\\/card-480\\./.test(n));
        return {
          names,
          plays,
          rigs,
          cards,
          masks: names.filter(n => /mask\\.png$/.test(n)),
          legacyArt: names.filter(n => /^\\/assets\\/art\\//.test(n)),
          bytes: entries.reduce((n, e) => n + (e.transferSize || 0), 0),
        };})())`,
      returnByValue: true,
    })).result.value);

    // Ranked/demo rooms mirror one fighter, so a matchup is 1–2 unique plates.
    ok('live requests only the active fighter plates', live.plays.length >= 1 && live.plays.length <= 2, JSON.stringify(live.plays));
    ok('live requests only the active rig data/atlas files', live.rigs.length >= 2 && live.rigs.length <= 4, String(live.rigs.length));
    ok('live does not request mask.png', live.masks.length === 0, JSON.stringify(live.masks));
    ok('live does not request /assets/art', live.legacyArt.length === 0, JSON.stringify(live.legacyArt));
    ok('live does not preload gallery cards', live.cards.length === 0, JSON.stringify(live.cards));
    ok('live transfer under 1.5 MB', live.bytes <= 1500000, live.bytes + ' B');
    ok('live has no JS exceptions', errors.length === 0, errors.slice(0, 2).join(' | '));

    // Gallery: a tall viewport makes every lazy tile visible; then wait for IO.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 4000, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: BASE + '/?view=fighters' });
    await sleep(2500);
    const gallery = JSON.parse((await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify((()=>{
        const entries = performance.getEntriesByType('resource').filter(e => e.name.includes('/assets/'));
        const names = entries.map(e => new URL(e.name).pathname);
        const cards = names.filter(n => /\\/assets\\/v\\/[a-z0-9-]+\\/card-480\\./.test(n));
        const imgs = [...document.querySelectorAll('img.ft-art')];
        return { cards, loaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length, total: imgs.length,
          sample: imgs.slice(0, 3).map(i => ({ src: i.src, data: i.dataset.src })) };})())`,
      returnByValue: true,
    })).result.value);
    console.log('  [gallery sample] ' + JSON.stringify(gallery.sample));
    ok('gallery loads 16 cards on activation', gallery.cards.length === 16, gallery.cards.length + '/16');
    ok('gallery img elements decoded', gallery.loaded === 16, gallery.loaded + '/' + gallery.total);
    ok('gallery has no JS exceptions', errors.length === 0, errors.slice(0, 2).join(' | '));
  } catch (err) {
    ok('browser asset probe', false, err.message);
  } finally {
    if (cdp) cdp.close();
    chrome.kill('SIGTERM');
    await sleep(200);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

console.log(failures.length ? `\n${failures.length} asset delivery failure(s)` : '\nall asset delivery checks passed');
process.exitCode = failures.length ? 1 : 0;
