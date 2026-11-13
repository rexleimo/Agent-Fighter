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
// The stage registry is what says how many arenas exist. Hardcoding "17 assets"
// made this gate rot the moment the league grew another arena, and a number
// copied from today's build proves nothing about tomorrow's.
const stageModel = await (await fetch(BASE + '/api/stages')).json();
const wantStages = stageModel.stages.length;
const plateAssets = manifest.assets.filter((a) => a.kind === 'stage-plate');
ok('manifest publishes one plate per registered stage',
  plateAssets.length === wantStages,
  `${plateAssets.length}/${wantStages} 个舞台 plate`);
ok('asset count matches roster + registry',
  manifest.assets.length === 16 + wantStages,
  `${manifest.assets.length} 资产 = 16 角色 + ${wantStages} 舞台`);
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
const wantVariants = manifest.assets.reduce((n, a) => n + (a.variants ? a.variants.length : 0), 0);
ok('every manifest variant is reachable and matches dimensions/alpha', checked === wantVariants, `${checked}/${wantVariants}`);

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
      const stageFetch=names.filter(n=>/\\/assets\\/v\\/stage_[a-z0-9_]+\\/stage-/.test(n));
      const cv=document.getElementById('stage');
      const band=cv.getContext('2d').getImageData(300,60,360,150).data;
      const bc=new Set();
      for(let i=0;i<band.length;i+=16) bc.add((band[i]>>4)+'-'+(band[i+1]>>4)+'-'+(band[i+2]>>4));
      const tickText=(document.querySelector('.vs-tick')||{}).textContent||'';
      const stageCv=document.getElementById('stage');
      const stageMode=(stageCv&&stageCv.dataset?stageCv.dataset.stageMode:'')||'';
      const stageDeclared=(stageCv&&stageCv.dataset?stageCv.dataset.stageDeclared:'')||'';
      const stageFailed=(stageCv&&stageCv.dataset?stageCv.dataset.stageFailed:'')||'';
      const stageMatch=(stageCv&&stageCv.dataset?stageCv.dataset.stageMatch:'')||'';
      return { plays, cards, stageFetch, bandColors:bc.size, stageMode, stageDeclared, stageFailed, stageMatch,
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
  const allMatches = (await (await fetch(BASE + '/api/matches')).json()).matches;
  const wantStage = state.match && state.match.stage;

  // Per-frame DOM writes are a cost class the pixel and fetch checks cannot
  // see: assigning the same string to a dataset key still queues an
  // attribute-mutation record, and doing that on the element being repainted
  // 60x/second forces style invalidation every frame. The stage self-report
  // was measured at 217 attribute mutations/s (5/s before stages existed) and
  // cost ~1.7fps; writing only on change brought it back to 4/s. Budget keeps
  // the honest-but-expensive version from coming back.
  const MUT_WINDOW_MS = 4000;
  await cdp.send('Runtime.evaluate', {
    expression: `(function(){
    window.__mut = { attr: 0, child: 0 };
    if (window.__mutObs) window.__mutObs.disconnect();
    window.__mutObs = new MutationObserver(function(ms){
      ms.forEach(function(m){
        if (m.type === 'attributes') window.__mut.attr += 1;
        else window.__mut.child += m.addedNodes.length + m.removedNodes.length;
      });
    });
    window.__mutObs.observe(document.body, { childList: true, subtree: true, attributes: true });
    window.__mutT0 = performance.now();
    return 1;
  })()`,
    returnByValue: true,
  });
  await sleep(MUT_WINDOW_MS);
  const mutRes = await cdp.send('Runtime.evaluate', {
    expression: `(function(){
    var secs = (performance.now() - window.__mutT0) / 1000;
    if (window.__mutObs) window.__mutObs.disconnect();
    return JSON.stringify({ attrPerSec: Math.round(window.__mut.attr / secs),
      childPerSec: Math.round(window.__mut.child / secs), secs: +secs.toFixed(1) });
  })()`,
    returnByValue: true,
  });
  const mut = JSON.parse(mutRes.result.value);
  ok('每帧渲染不产生 DOM 写入风暴（属性变更在预算内）',
    mut.attrPerSec <= 40,
    `属性 ${mut.attrPerSec}/s、节点 ${mut.childPerSec}/s / 预算 40/s，采样 ${mut.secs}s`);
  const plateOf = (u) => (u.match(/\/v\/(stage_[a-z0-9_]+)\//) || [])[1] || null;
  const fetched = live.stageFetch.map(plateOf).filter(Boolean);
  console.log('[Live] ' + JSON.stringify(live));
  ok('Live loads only the active fighters', live.plays.length >= 1 && live.plays.length <= 2, JSON.stringify(live.plays));
  ok('Live does not preload gallery cards', live.cards.length === 0, JSON.stringify(live.cards));
  // Two independent facts, both measured where they can actually differ:
  // the painted plate was fetched over HTTP (255 vs 5 buckets in a background
  // band separates art from the flat procedural fallback; the full-canvas
  // number could not, because HUD and impact FX inflate it either way).
  // Primary evidence: the renderer declares which branch painted the
  // background, and which arena it was told to paint. This replaced a color
  // bucket threshold, which stopped being discriminative once the league had
  // five arenas (real arenas measured 34-249 buckets, fallback 5-18).
  ok('背景由美术 plate 绘制（不是程序化兜底几何）', live.stageMode === 'art',
    `渲染分支 ${live.stageMode || '未声明'}`);
  ok('舞台贴图真的被请求（不是程序化兜底）', live.stageFetch.length >= 1, JSON.stringify(live.stageFetch));
  // Reconcile against the record of the match the canvas says it is painting,
  // not against a state snapshot taken before the probe: the demo room can roll
  // into a new match mid-probe, and comparing across that gap fails a render
  // that was correct the whole time.
  // Reconcile against the match the canvas says it is painting, looked up at
  // probe time. Two sources, because a live match is not in /api/matches yet
  // (the record is written when the match ends), while a finished one is no
  // longer in /api/state. Either way the stage must come from that match's own
  // data - never from a snapshot taken before the probe, which is how a match
  // rolling mid-probe turned a correct render into a false failure.
  const liveStateNow = await (await fetch(BASE + '/api/state')).json();
  const paintedRecord = allMatches.find((m) => m.matchId === live.stageMatch)
    || (liveStateNow.match && liveStateNow.match.matchId === live.stageMatch ? liveStateNow.match : null);
  ok('画布自报的对局确实是当前或已登记的真实对局',
    Boolean(paintedRecord),
    `matchId=${live.stageMatch || '空'}`);
  ok('渲染器绘制的是它所渲染那一局声明的场地',
    Boolean(paintedRecord) && paintedRecord.stage === live.stageDeclared,
    `局 ${live.stageMatch || '—'} 声明 ${paintedRecord ? String(paintedRecord.stage) : '无'} / 绘制 ${live.stageDeclared}`);
  ok('没有发生 plate 加载失败回退', live.stageFailed !== '1', `stageFailed=${live.stageFailed}`);
  // Secondary: a painted arena is never a flat fill. Kept low on purpose -
  // this only catches "solid color canvas", not "wrong arena".
  ok('背景不是平涂（美术内容存在）', live.bandColors > 25, `背景带取样色数 ${live.bandColors}`);
  ok('实时推流仍在跑', /^TICK \d+/.test(live.tick) && live2.tickNum !== live.tickNum,
    live.tick + ' -> ' + live2.tick);

  // The acceptance criterion for the whole multi-scene feature: the arena a
  // match declares must be the arena that gets painted, in the live view AND in
  // the replay, from the same record. Anything else means one of the two is
  // choosing a stage on its own.
  const staged = allMatches.filter((m) => m.stage);
  const teamMatch = staged.find((m) => m.stage !== 'stage_main');
  ok('真实对局里出现了队风主场（多场景不是纸面能力）', Boolean(teamMatch),
    teamMatch ? `${teamMatch.matchId} -> ${teamMatch.stage}` : '全部仍是 stage_main');
  ok('同一局的记录与回放文件头部声明同一场地', await (async () => {
    if (!teamMatch) return false;
    const text = await (await fetch(`${BASE}/api/replay/${encodeURIComponent(teamMatch.matchId)}`)).text();
    const header = JSON.parse(text.split('\n')[0]);
    return header.stage === teamMatch.stage && header.seed === teamMatch.seed;
  })(), teamMatch ? `${teamMatch.stage} + seed ${teamMatch.seed}` : 'n/a');

  if (teamMatch) {
    await cdp.send('Page.navigate', { url: `${BASE}/replay?match=${encodeURIComponent(teamMatch.matchId)}` });
    await sleep(4500);
    const replayEval = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify((()=>{
        const names=performance.getEntriesByType('resource').map(e=>new URL(e.name).pathname);
        const rc=document.getElementById('replayCanvas');
        return { stageFetch: names.filter(n=>/\\/assets\\/v\\/stage_[a-z0-9_]+\\/stage-/.test(n)),
          mode: (rc&&rc.dataset?rc.dataset.stageMode:'')||'',
          declared: (rc&&rc.dataset?rc.dataset.stageDeclared:'')||'',
          cv: Boolean(rc) };})())`,
      returnByValue: true,
    });
    if (!replayEval.result || replayEval.result.value === undefined) {
      throw new Error('replay probe returned no value: ' + JSON.stringify(replayEval.exceptionDetails || replayEval));
    }
    const replayProbe = JSON.parse(replayEval.result.value);
    const replayPlates = replayProbe.stageFetch.map(plateOf).filter(Boolean);
    ok('回放页请求的正是该局声明的场地',
      replayPlates.includes(teamMatch.stage),
      `声明 ${teamMatch.stage} / 回放实际请求 ${JSON.stringify(replayPlates)}`);
    ok('回放背景由美术 plate 绘制，且绘制的就是该局场地',
      replayProbe.mode === 'art' && replayProbe.declared === teamMatch.stage,
      `分支 ${replayProbe.mode || '未声明'} / 绘制 ${replayProbe.declared || '—'}`);
    // Live and replay must not disagree: both derive from the record, so if one
    // of them kept its own default the two would differ on this exact match.
    ok('直播与回放对同一局的场地一致',
      replayPlates.length > 0 && replayPlates.every((p) => p === teamMatch.stage),
      `直播 ${JSON.stringify(fetched)} vs 回放 ${JSON.stringify(replayPlates)}`);
    await cdp.send('Page.navigate', { url: BASE + '/?view=live' });
    await sleep(3000);
  }
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
