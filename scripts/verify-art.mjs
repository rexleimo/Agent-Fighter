/**
 * End-to-end check for the painted art layer.
 * Verifies the asset pipeline (HTTP + real alpha) AND what Chrome actually
 * renders (loaded images, canvas pixels, gallery DOM, zero JS exceptions).
 *
 * Usage: node scripts/verify-art.mjs   (server must already be running)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = process.env.AFL_BASE || 'http://127.0.0.1:8787';
const ROOT = path.resolve(import.meta.dirname, '..');
const ART = path.join(ROOT, 'web', 'assets', 'art');
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

const ids = state.fighters.map((f) => f.id);
ok('角色数据带 art 路径', ids.length === 16 && state.fighters.every((f) => f.art === '/assets/art/' + f.id + '.png'), `${ids.length} 位`);

// --- HTTP + PNG alpha -----------------------------------------------------
let alphaOk = 0;
for (const p of ['/assets/art/stage_main.png', ...ids.map((id) => '/assets/art/' + id + '.png')]) {
  const res = await fetch(BASE + p);
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = res.headers.get('content-type') || '';
  const isPng = buf.readUInt32BE(0) === 0x89504E47;
  const hasAlpha = isPng && buf[25] === 6;
  if (res.ok && mime.includes('image/png') && hasAlpha) alphaOk += 1;
  else console.log('    坏资源 ' + p + ' -> ' + res.status + ' ' + mime + ' alpha=' + hasAlpha);
}
ok('17 张素材 HTTP 可达且带 alpha 通道', alphaOk === 17, `${alphaOk}/17`);

// --- Chrome ---------------------------------------------------------------
const exe = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));
if (!exe) { console.error('未找到 Chrome / Edge'); process.exit(1); }

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

  // Live view ---------------------------------------------------------------
  await cdp.send('Page.navigate', { url: BASE + '/?view=live' });
  await sleep(4500);
  const live = JSON.parse((await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify((()=>{
      const res=performance.getEntriesByType('resource').filter(e=>e.name.includes('/assets/art/'));
      const stage=res.filter(e=>e.name.includes('stage_main.png'));
      const sprites=res.filter(e=>/\\/assets\\/art\\/[a-z]+\\.png/.test(e.name)&&!e.name.includes('stage_main'));
      const cv=document.getElementById('stage');
      const d=cv.getContext('2d').getImageData(60,120,260,180).data;
      const colors=new Set();
      for(let i=0;i<d.length;i+=16) colors.add((d[i]>>4)+'-'+(d[i+1]>>4)+'-'+(d[i+2]>>4));
      return {
        stageLoaded: stage.length>0,
        sprites: sprites.length,
        assetRequests: res.length,
        paletteColors: colors.size,
        tick: document.getElementById('tickLabel')?.textContent || '',
        decisions: document.getElementById('decisionList')?.children.length || 0
      };})())`,
    returnByValue: true,
  })).result.value);
  console.log('[Live] ' + JSON.stringify(live));
  ok('舞台背景板被浏览器实际请求', live.stageLoaded);
  ok('16 张角色立绘被浏览器实际请求', live.sprites === 16, `${live.sprites}/16`);
  ok('17 张素材全部发起请求并解码', live.assetRequests === 17, `${live.assetRequests}/17`);
  ok('Canvas 已绘制图片而非纯色几何', live.paletteColors > 90, `取样色数 ${live.paletteColors}`);
  ok('实时推流仍在跑', live.decisions > 0, live.tick);
  let shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(ROOT, 'docs', 'preview-live.png'), Buffer.from(shot.data, 'base64'));

  // Fighter gallery ---------------------------------------------------------
  await cdp.send('Page.navigate', { url: BASE + '/?view=fighters' });
  await sleep(3200);
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
  ok('图鉴 4 队 / 16 张真实立绘', gallery.tiles === 16 && gallery.teams === 4 && gallery.loaded === 16, `${gallery.loaded}/${gallery.imgs} 张已加载`);
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
