/**
 * Painted-art layer acceptance (manifest-driven).
 *
 * Verifies every manifest variant over HTTP + local decoding, then what Chrome
 * actually renders: only the active plates on Live, all 16 cards in the
 * gallery, real canvas pixels, and zero JS exceptions.
 *
 * Usage: node scripts/verify-art.mjs (server must already be running)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { probeImage } from './lib/imageops.mjs';

const BASE = process.env.AFL_BASE || 'http://127.0.0.1:8787';
const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9231;
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

const manifest = await (await fetch(BASE + '/assets/manifest.json')).json();
ok('manifest has 17 assets', manifest.assets.length === 17, String(manifest.assets.length));
ok('16 fighters in manifest', manifest.assets.filter((a) => a.kind === 'fighter-plate').length === 16);
ok('fighters[].art still exposes the legacy field', state.fighters.every((f) => f.art === '/assets/art/' + f.id + '.png'));

// HTTP + local dimensions/alpha -------------------------------------------
let checked = 0;
for (const asset of manifest.assets) {
  for (const variant of asset.variants) {
    const res = await fetch(BASE + variant.path);
    const type = res.headers.get('content-type') || '';
    const local = path.join(ROOT, 'web', variant.path.replace(/^\//, ''));
    const probe = fs.existsSync(local) ? probeImage(local) : null;
    const good = res.ok && type.startsWith('image/')
      && probe && probe.width === variant.width && probe.height === variant.height
      && probe.alpha === variant.alpha;
    if (good) checked += 1;
    else console.log('    坏资源 ' + variant.path + ' -> ' + res.status + ' ' + type + ' ' + JSON.stringify(probe));
  }
}
ok('every manifest variant is reachable and matches dimensions/alpha', checked === 33, `${checked}/33`);

// Chrome -------------------------------------------------------------------
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const exe = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!exe) {
  console.error('未找到 Chrome / Edge；设置 CHROME_PATH');
  process.exit(1);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'afl-art-'));
const chrome = spawn(exe, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--window-size=1440,1400', '--remote-debugging-port=' + PORT,
  '--remote-allow-origins=*', '--user-data-dir=' + profile, 'about:blank',
], { stdio: 'ignore' });

async function waitForDevtools() {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/list'); if (r.ok) return r.json(); } catch { /* wait */ }
    await sleep(150);
  }
  throw new Error('DevTools timeout');
}

function connect(url, exceptions) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let id = 0;
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.exceptionThrown') {
        exceptions.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description || ''));
      }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      }
    };
    ws.onerror = reject;
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          id += 1; pending.set(id, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      close: () => ws.close(),
    });
  });
}

let cdp;
const exceptions = [];
try {
  const targets = await waitForDevtools();
  cdp = await connect(targets.find((t) => t.type === 'page').webSocketDebuggerUrl, exceptions);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1400, deviceScaleFactor: 1, mobile: false });

  await cdp.send('Page.navigate', { url: BASE + '/?view=live' });
  await sleep(5000);
  // What this probe used to read: getImageData over a fixed 260x180 corner, and
  // the DOM ids `tickLabel` / `decisionList`. The corner sits in the darkest
  // part of the real artwork (52 buckets against a >90 threshold), and those two
  // ids were deleted in the React rewrite - so the gate failed on a correctly
  // rendered page, and never proved the stream was advancing.
  // Now it measures two facts that genuinely differ, plus real selectors:
  // the plate was fetched over HTTP (1 url vs 0), and a background-only band
  // (255 buckets vs 5). The full canvas could not discriminate: HUD, impact FX
  // and fighters inflate it to 236 even with no art at all.
  const liveProbe = () => cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify((()=>{
      const res=performance.getEntriesByType('resource').filter(e=>e.name.includes('/assets/'));
      const names=res.map(e=>new URL(e.name).pathname);
      const plays=[...new Set(names.filter(n=>/\\/assets\\/v\\/[a-z0-9-]+\\/play-512\\./.test(n)))];
      const cards=names.filter(n=>/\\/assets\\/v\\/[a-z0-9-]+\\/card-480\\./.test(n));
      const stageFetch=names.filter(n=>/stage_main|\\/stage-/.test(n));
      const cv=document.getElementById('stage');
      const band=cv.getContext('2d').getImageData(300,60,360,150).data;
      const bc=new Set();
      for(let i=0;i<band.length;i+=16) bc.add((band[i]>>4)+'-'+(band[i+1]>>4)+'-'+(band[i+2]>>4));
      const tickText=(document.querySelector('.vs-tick')||{}).textContent||'';
      return { plays, cards, stageFetch, bandColors:bc.size,
        tick:tickText.trim(),
        tickNum:(tickText.match(/TICK\\s*(\\d+)/)||[])[1]||'',
        decisions:document.querySelectorAll('.event-list .ev').length };})())`,
    returnByValue: true,
  }).then((r) => {
    if (!r.result || r.result.value === undefined) {
      throw new Error('live probe returned no value: ' + JSON.stringify(r.exceptionDetails || r));
    }
    return JSON.parse(r.result.value);
  });

  const live = await liveProbe();
  await sleep(2500);
  const live2 = await liveProbe();
  console.log('[Live] ' + JSON.stringify(live));
  ok('Live loads only the active fighters', live.plays.length >= 1 && live.plays.length <= 2, JSON.stringify(live.plays));
  ok('Live does not preload gallery cards', live.cards.length === 0, JSON.stringify(live.cards));
  // Two independent facts, both measured where they can actually differ:
  // the painted plate was fetched over HTTP (255 vs 5 buckets in a background
  // band separates art from the flat procedural fallback; the full-canvas
  // number could not, because HUD and impact FX inflate it either way).
  ok('舞台贴图真的被请求（不是程序化兜底）', live.stageFetch.length >= 1, JSON.stringify(live.stageFetch));
  ok('Canvas is painting the painted stage/art', live.bandColors > 60, `背景带取样色数 ${live.bandColors}`);
  ok('实时推流仍在跑', /^TICK \d+/.test(live.tick) && live2.tickNum !== live.tickNum,
    live.tick + ' -> ' + live2.tick);
  let shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(ROOT, 'docs', 'preview-live.png'), Buffer.from(shot.data, 'base64'));

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 4000, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: BASE + '/?view=fighters' });
  await sleep(3000);
  const gallery = JSON.parse((await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify((()=>{
      const imgs=[...document.querySelectorAll('img.ft-art')];
      return {
        tiles:document.querySelectorAll('.fighter-tile').length,
        teams:document.querySelectorAll('.fighter-team').length,
        imgs:imgs.length,
        loaded:imgs.filter(i=>i.complete && i.naturalWidth>0).length,
        fallbackCanvases:document.querySelectorAll('canvas.ft-portrait').length,
        chip:document.getElementById('fighterCount')?.textContent||''
      };})())`,
    returnByValue: true,
  })).result.value);
  console.log('[Fighters] ' + JSON.stringify(gallery));
  ok('图鉴 4 队 / 16 张 card 立绘', gallery.tiles === 16 && gallery.teams === 4 && gallery.loaded === 16,
    `${gallery.loaded}/${gallery.imgs} 张已加载`);
  ok('未回退到几何头像', gallery.fallbackCanvases === 0);
  shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(ROOT, 'docs', 'preview-fighters.png'), Buffer.from(shot.data, 'base64'));

  ok('浏览器 0 JS 异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | '));
} catch (e) {
  console.error('浏览器检查失败：' + e.message);
  failures.push('浏览器检查');
} finally {
  if (cdp) cdp.close();
  chrome.kill('SIGTERM');
  await sleep(250);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('\n' + (failures.length ? `${failures.length} 项失败：` + failures.join(' / ') : '美术层检查全部通过'));
console.log('截图：docs/preview-live.png, docs/preview-fighters.png');
process.exitCode = failures.length ? 1 : 0;
