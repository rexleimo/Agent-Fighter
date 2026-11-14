import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'preview-live.png');
const URL_TO_OPEN = process.env.AFL_URL || 'http://localhost:8787/';
const PORT = 9223;
const WAIT_MS = Number(process.env.AFL_CAPTURE_WAIT || 9000);
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].filter(Boolean);
const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chromePath) {
  console.error('Chrome / Edge not found. Set CHROME_PATH to the browser executable.');
  process.exit(1);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'afl-capture-'));
const chrome = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
  '--hide-scrollbars', '--window-size=1440,1250',
  '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  '--user-data-dir=' + profile, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/json/list');
      if (res.ok) return res.json();
    } catch { /* browser is starting */ }
    await sleep(150);
  }
  throw new Error('devtools endpoint did not come up');
}

function connectCDP(wsUrl, exceptions) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === 'Runtime.exceptionThrown') {
        exceptions.push(msg.params.exceptionDetails.text + ' ' + (msg.params.exceptionDetails.exception?.description || ''));
      }
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
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

let cdp;
const exceptions = [];
try {
  const targets = await waitForDevtools();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  cdp = await connectCDP(page.webSocketDebuggerUrl, exceptions);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1250, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: URL_TO_OPEN });
  console.log('Waiting ' + WAIT_MS + 'ms of real time for live websocket ticks...');
  await sleep(WAIT_MS);
  const probe = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      decisions: document.getElementById('decisionList').children.length,
      combat: document.getElementById('combatList').children.length,
      frame: document.getElementById('frameLabel').textContent,
      tick: document.getElementById('tickLabel').textContent,
      conn: document.getElementById('connText').textContent,
      hp: document.getElementById('hudHpA').textContent + ' / ' + document.getElementById('hudHpB').textContent
    })`,
    returnByValue: true,
  });
  console.log('Live DOM: ' + probe.result.value);
  console.log('JS exceptions: ' + exceptions.length + (exceptions.length ? '\n  ' + exceptions.slice(0, 3).join('\n  ') : ''));
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('Screenshot saved: ' + OUT);
} catch (err) {
  console.error('capture failed:', err.message);
  process.exitCode = 1;
} finally {
  if (cdp) cdp.close();
  chrome.kill('SIGTERM');
  await sleep(200);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
}
