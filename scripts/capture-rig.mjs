/**
 * Screenshot the rig lab (or any AFL page) with headless Chrome + CDP.
 * No npm dependencies: same approach as scripts/capture.mjs.
 *
 * Usage: node scripts/capture-rig.mjs [path] [out] [width] [height]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE = process.env.AFL_BASE || 'http://127.0.0.1:8787';
const PAGE = process.argv[2] || '/rig-lab.html?ids=abyss,gale,prism,forge';
const OUT = path.resolve(ROOT, process.argv[3] || '.tmp-rig/lab.png');
const W = Number(process.argv[4] || 1900);
const H = Number(process.argv[5] || 1200);
const PORT = 9241;
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
const exe = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!exe) {
  console.error('Chrome / Edge not found. Set CHROME_PATH.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'afl-rig-'));
const chrome = spawn(exe, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--window-size=' + W + ',' + H,
  '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  '--user-data-dir=' + profile, 'about:blank',
], { stdio: 'ignore' });

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
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        sink.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
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
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: BASE + PAGE });
  for (let i = 0; i < 80; i += 1) {
    await sleep(150);
    const r = await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
    if (String(r.result.value).includes('ready')) break;
  }
  await sleep(400);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('saved ' + path.relative(ROOT, OUT) + (errors.length ? '\n  errors:\n  ' + errors.slice(0, 5).join('\n  ') : ''));
  if (errors.length) process.exitCode = 1;
} catch (err) {
  console.error('capture failed:', err.message);
  process.exitCode = 1;
} finally {
  if (cdp) cdp.close();
  chrome.kill('SIGTERM');
  await sleep(200);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
}
