import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runKernelChecks } from './verify-parts/kernel.mjs';
import { verifyEndToEnd, waitForServer } from './verify-parts/live.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8799;
const BASE = 'http://127.0.0.1:' + PORT;
const WS = 'ws://127.0.0.1:' + PORT;
// Better Auth pins its baseURL to http://localhost:<PORT>.
const AUTH_BASE = 'http://localhost:' + PORT;
const TEST_DB = process.env.AFL_TEST_DATABASE_URL || '';
const results = [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  |  ' + detail : ''));
}

async function rpc(mcp, method, params = {}) {
  const res = await fetch(mcp, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params }),
  });
  return (await res.json()).result;
}

async function openSpectator(wsBase, roomId, ticks) {
  const ws = new WebSocket(wsBase + '/ws/spectate?room=' + roomId);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
    setTimeout(() => reject(new Error('spectator connect timeout')), 5000);
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'tick') ticks.push(m);
  };
  return ws;
}

const ctx = {
  ROOT, PORT, BASE, WS, AUTH_BASE, TEST_DB,
  check, delay, rpc,
  openSpectator: (roomId, ticks) => openSpectator(WS, roomId, ticks),
  waitForServer: () => waitForServer(BASE),
  session: {},
};

console.log('\n=== Agent Fighting League · end-to-end verification ===\n');
runKernelChecks(check);
await verifyEndToEnd(ctx);
// C23 - team elimination mode has its own gate: pure state-machine math, a
// live 3v3 scrim over MCP + WebSocket, and the real ranked signup loop
// (/api/enter -> matchmaking -> wins-first board). See scripts/verify-team.mjs.
// Pass the test database through: forcing DATABASE_URL:'' made the team gate
// silently skip inside this run, which reads as a green suite that tested less
// than it claims.
const teamGate = spawnSync(process.execPath, ['scripts/verify-team.mjs'], {
  cwd: ROOT, encoding: 'utf8', timeout: 420000,
  env: { ...process.env, DATABASE_URL: '' },
});
const teamSummary = (teamGate.stdout || '').split('\n').filter((l) => /team checks passed/.test(l)).join(' ').trim();
const teamSkipped = /SKIP: AFL_TEST_DATABASE_URL/.test(teamGate.stdout || '');
check('C23 组队赛门禁（T1-T14：回血/淘汰/换人/回放重演/双通道私房/报名匹配/胜场榜）',
  teamGate.status === 0 && !(TEST_DB && teamSkipped),
  teamSummary
  + (teamSkipped ? (TEST_DB ? ' 但实时段被跳过，不算通过' : ' · 实时段 SKIP（未配 AFL_TEST_DATABASE_URL）') : ''));
const passed = results.filter((r) => r.ok).length;
console.log('\n=== ' + passed + '/' + results.length + ' checks passed ===\n');
if (passed !== results.length) process.exitCode = 1;
