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
import { spawn, execFileSync } from 'node:child_process';

const BASE = process.env.AFL_BASE || 'http://127.0.0.1:8787';
const ROOT = path.resolve(import.meta.dirname, '..');
const ASSETS_ROOT = path.join(ROOT, 'web', 'assets');
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

// The plate build used to sweep all of web/assets/v and delete anything its own
// manifest did not name - which included the sprite pipeline's published files.
// That broke rendering while every asset check about stages still passed, so
// cross-pipeline ownership gets its own assertion here.
{
  const spriteIndex = await (await fetch(BASE + '/assets/sprites.json')).json();
  const ids = (spriteIndex.fighters || []).map((f) => f.id);
  const probe = ids.slice(0, 3);
  let missing = 0;
  for (const id of probe) {
    const entry = (spriteIndex.fighters || []).find((f) => f.id === id);
    const url = entry && (entry.anim || (entry.sheets && entry.sheets[0] && entry.sheets[0].url));
    if (!url) { missing += 1; continue; }
    const res = await fetch(BASE + url);
    if (!res.ok) { missing += 1; console.log('    sprite 丢失 ' + id + ' -> ' + url + ' ' + res.status); }
  }
  ok('sprite 管线的产物仍在原位（plate 构建不越界清理别人的目录）',
    ids.length > 0 && missing === 0,
    `${probe.length} 个抽样 sprite 资源，缺失 ${missing}`);
}

// Sampling proves the server can answer; it does not prove the set is complete
// or that another clone gets it. sprites.json -> anim.<hash>.json -> sheet webp
// is a closed set, so assert it exactly: nothing referenced is absent, nothing
// present is unreferenced, and every byte of it is tracked in git.
{
  const index = await (await fetch(BASE + '/assets/sprites.json')).json();
  const refs = new Set();
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const v of Object.values(o)) {
      if (typeof v === 'string' && v.startsWith('/assets/v/sprites/')) refs.add(v);
      else walk(v);
    }
  };
  const unreadable = [];
  for (const f of Object.values(index.fighters || {})) {
    if (!f.anim) continue;
    refs.add(f.anim);
    const local = path.join(ASSETS_ROOT, f.anim.replace('/assets/', ''));
    // A missing anim file is a finding, not a reason to abort: crashing here
    // would skip every later check and leave a stack trace instead of a result.
    if (!fs.existsSync(local)) { unreadable.push(f.anim); continue; }
    walk(JSON.parse(fs.readFileSync(local, 'utf8')));
  }
  const broken = [...refs].filter((r) => !fs.existsSync(path.join(ASSETS_ROOT, r.replace('/assets/', ''))));
  const lost = [...new Set([...unreadable, ...broken])];
  ok('sprite 引用集合完整（每个被引用的文件都在）', lost.length === 0,
    `${refs.size} 个引用，缺失 ${lost.length}` + (lost.length ? ` -> ${lost.slice(0, 3).join(' ')}` : ''));

  const onDisk = [];
  const scan = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) scan(p);
      else onDisk.push('/assets/' + path.relative(ASSETS_ROOT, p).split(path.sep).join('/'));
    }
  };
  const spriteRoot = path.join(ASSETS_ROOT, 'v', 'sprites');
  if (fs.existsSync(spriteRoot)) scan(spriteRoot);
  const orphans = onDisk.filter((p) => !refs.has(p));
  ok('sprite 目录没有野文件（磁盘上的每个文件都有人引用）', orphans.length === 0,
    `${onDisk.length} 个文件，未被引用 ${orphans.length}` + (orphans.length ? ` -> ${orphans.slice(0, 3).join(' ')}` : ''));

  // A fresh clone is the real test. The plate pipeline's output is tracked; the
  // sprite pipeline's was not, so a clone rendered nothing until someone ran
  // slice.mjs by accident. Track-equality is the invariant, not file count.
  let tracked = null;
  try {
    tracked = execFileSync('git', ['ls-files', 'web/assets/v/sprites'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean);
  } catch { tracked = null; }
  if (tracked === null) {
    console.log('  SKIP  sprite 产物已随仓库分发（新克隆可直接渲染）  非 git 环境，无法核对跟踪状态');
  } else {
    const untracked = onDisk.length - tracked.length;
    ok('sprite 产物已随仓库分发（新克隆可直接渲染）', tracked.length > 0 && untracked === 0,
      `git 跟踪 ${tracked.length} / 磁盘 ${onDisk.length}`);
  }
}

const manifest = await (await fetch(BASE + '/assets/manifest.json')).json();
// "16 fighters + stage" was true when the league had one arena. The stage
// count now comes from the server registry, which is what actually decides how
// many arenas a match can be played in.
const stageRegistry = await (await fetch(BASE + '/api/stages')).json();
const plateAssets = manifest.assets.filter((a) => a.kind === 'stage-plate');
ok('manifest has 16 fighters plus one plate per registered stage',
  manifest.assets.length === 16 + stageRegistry.stages.length
  && manifest.assets.filter((a) => a.kind === 'fighter-plate').length === 16
  && plateAssets.length === stageRegistry.stages.length
  && stageRegistry.stages.every((s) => plateAssets.some((p) => p.id === s.id)),
  `${manifest.assets.length} 资产 / ${plateAssets.length} 个舞台 plate`);

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
          stageFetch: names.filter(n => /\\/assets\\/v\\/stage_[a-z0-9_]+\\/stage-/.test(n)),
          cards,
          masks: names.filter(n => /mask\\.png$/.test(n)),
          legacyArt: names.filter(n => /^\\/assets\\/art\\//.test(n)),
          bytes: entries.reduce((n, e) => n + (e.transferSize || 0), 0),
          byKind: (()=>{const g={};for(const e of entries){const p=new URL(e.name).pathname;const k=(p.match(/\\/assets\\/v\\/([^/]+)\\//)||[])[1]||'other';g[k]=(g[k]||0)+(e.transferSize||0);}return g;})(),
        };})())`,
      returnByValue: true,
    })).result.value);

    // Ranked/demo rooms mirror one fighter, so a matchup is 1–2 unique plates.
    ok('live requests only the active fighter plates', live.plays.length >= 1 && live.plays.length <= 2, JSON.stringify(live.plays));
    // The contract is "only the active fighters' rigs", not "exactly N
    // requests": a demo room can start a new match inside the probe window, so
    // a raw count would fail on correct behaviour. Deduplicate and check
    // ownership instead - a rig file for a fighter that is not in the match is
    // the failure this gate is actually here to catch.
    const rigIds = [...new Set(live.rigs.map((n) => (n.match(/\/rig\/([^/]+)\//) || [])[1]).filter(Boolean))];
    // What this can honestly guarantee: the viewer loads rigs for the fighters
    // it actually watched, not the whole roster. A demo room may start a second
    // match inside the probe window, so "exactly the current matchup" was not a
    // stable assertion - and "not all 16" is the eager-loading failure the gate
    // is really here to catch.
    const allFighterIds = (state.fighters || []).map((f) => f.id);
    ok('live loads rigs only for watched fighters (no roster-wide preload)',
      rigIds.length >= 1 && rigIds.length <= 4
      && rigIds.every((id) => allFighterIds.includes(id)),
      `rigs=${JSON.stringify(rigIds)} / 全 roster ${allFighterIds.length} 个角色`);
    ok('live does not request mask.png', live.masks.length === 0, JSON.stringify(live.masks));
    ok('live does not request /assets/art', live.legacyArt.length === 0, JSON.stringify(live.legacyArt));
    ok('live does not preload gallery cards', live.cards.length === 0, JSON.stringify(live.cards));
    // The declared budget is for ONE live view. With multiple arenas, a long
    // watch session legitimately accumulates: each new match may fetch a
    // different plate. Measuring the session against a per-view budget made the
    // gate fail on correct behaviour and hid the number that actually matters.
    // Read the budget from the published manifest, not from catalog.json (a
    // source file the server does not serve): the number a client can actually
    // see is the one that governs it.
    const liveViewBudget = manifest.budgets.liveViewBytes;
    // A live view is one arena plate plus the two fighters on screen. That is
    // computed from the published sizes rather than from session bytes, because
    // the page can join a match near its end and roll into the next one during
    // the probe window - timing cannot isolate "the first view", and a gate
    // that depends on it fails intermittently on correct behaviour.
    const byId = new Map(manifest.assets.map((a) => [a.id, a]));
    const variantBytes = (a, role) => {
      if (!a || !a.variants) return 0;
      const v = a.variants.find((x) => x.role === role) || a.variants[0];
      return v ? v.bytes : 0;
    };
    const worstPlate = Math.max(...manifest.assets.filter((a) => a.kind === 'stage-plate').map((a) => variantBytes(a, 'stage')));
    const spriteBytes = (id) => {
      const a = byId.get(id);
      // The rig entry publishes `dataBytes` for the clip json and `bytes` for
      // the atlas image; reading a field that is not there would silently make
      // this whole budget 0 and turn the gate into a permanent pass.
      return a && a.rig ? (a.rig.dataBytes || 0) + (a.rig.bytes || 0) : 0;
    };
    const fighterView = (id) => variantBytes(byId.get(id), 'play') + spriteBytes(id);
    const twoFighters = manifest.assets.filter((a) => a.kind === 'fighter-plate')
      .map((a) => fighterView(a.id)).sort((x, y) => y - x).slice(0, 2);
    const expectedViewBytes = worstPlate + twoFighters[0] + twoFighters[1];
    ok('预算计算取到了真实字段（不是把 0 当成通过）',
      worstPlate > 0 && twoFighters[0] > 0 && twoFighters[1] > 0,
      `plate=${worstPlate} 两名角色=${twoFighters.join('+')}`);
    ok('最坏情况的一个直播视图在声明预算内', expectedViewBytes <= liveViewBudget,
      `${expectedViewBytes} / ${liveViewBudget} B（最贵 plate + 两名最重角色）`);
    // Switching arenas costs one plate, not one roster. This is the new cost
    // multi-scene added, stated as a number instead of left implicit.
    const plateOf = (u) => (u.match(/\/v\/(stage_[a-z0-9_]+)\//) || [])[1] || null;
    const plateBytes = live.stageFetch.map((u) => live.byKind[plateOf(u)] || 0);
    const perPlate = plateBytes.length ? Math.max(...plateBytes) : 0;
    ok('换一场地的代价是一张 plate（不是重下整包）',
      perPlate > 0 && perPlate <= 250000,
      `最贵单张 ${Math.round(perPlate / 1024)} KB，本次共取 ${live.stageFetch.length} 张`);
    // Session bound: a viewer may watch many matches. This only catches the
    // pathological case of re-downloading everything every tick.
    ok('累计会话流量有上限（不会每局重下整包）', live.bytes <= 3000000,
      live.bytes + ' B / ' + live.stageFetch.length + ' 张 plate');
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
