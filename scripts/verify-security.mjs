/**
 * verify-security.mjs — evidence that the production hardening actually fires.
 *
 * Spawns an isolated server with STRICT limits (so 413/429 trigger) and accounts
 * disabled, then asserts: health probe, security headers, conditional HSTS,
 * request-body cap (413), and per-IP rate limiting (429 + Retry-After) on both
 * the global and auth tiers. Run: node scripts/verify-security.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8801;
const BASE = `http://127.0.0.1:${PORT}`;
const pkgV = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}${detail ? '  |  ' + detail : ''}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? '  |  ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(process.execPath, ['src/server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    DATABASE_URL: '',            // force accounts off (dotenv won't override a set var)
    AFL_MAX_BODY_BYTES: '2048',  // tiny cap so 413 is easy to trigger
    AFL_RATE_GLOBAL: '20',       // strict global tier
    AFL_RATE_AUTH: '3',          // strict auth tier
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/healthz'); if (r.ok) return true; } catch { /* not up yet */ }
    await sleep(200);
  }
  return false;
}

try {
  if (!(await waitReady())) { console.error('server did not start:\n' + serverLog); process.exit(1); }

  // S1 — health probe
  const h = await fetch(BASE + '/healthz');
  const hj = await h.json();
  check('S1 健康检查 /healthz 返回 200 + 版本', h.status === 200 && hj.status === 'ok' && hj.version === pkgV,
    `status=${h.status} version=${hj.version} accounts=${hj.accounts}`);

  // S2 — baseline security headers on a normal response
  const r2 = await fetch(BASE + '/');
  const need = ['x-frame-options', 'x-content-type-options', 'referrer-policy', 'content-security-policy', 'permissions-policy'];
  const missing = need.filter((k) => !r2.headers.get(k));
  check('S2 安全头齐全（X-Frame/nosniff/Referrer/CSP/Permissions）', missing.length === 0,
    missing.length ? '缺=' + missing.join(',') : `X-Frame=${r2.headers.get('x-frame-options')}`);

  // S3 — HSTS only over TLS (signalled by trusted x-forwarded-proto)
  const secure = await fetch(BASE + '/', { headers: { 'x-forwarded-proto': 'https' } });
  const plain = await fetch(BASE + '/');
  check('S3 HSTS 仅在 HTTPS 时下发', Boolean(secure.headers.get('strict-transport-security')) && !plain.headers.get('strict-transport-security'),
    `https=${secure.headers.get('strict-transport-security') || '无'} http=${plain.headers.get('strict-transport-security') || '无'}`);

  // S4 — request-body cap → 413 (and a small body is NOT rejected)
  let bigStatus = 0, bigErr = '';
  try {
    const big = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(4096) });
    bigStatus = big.status;
  } catch (e) { bigErr = e.message; }
  const small = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
  check('S4 请求体超限返回 413，小 body 不被拒', bigStatus === 413 && small.status !== 413,
    `big=${bigStatus || bigErr} small=${small.status} cap=2048B`);

  // S5 — global rate limit → some 200 then 429 with Retry-After
  let ok = 0, limited = 0, retryAfter = null;
  for (let i = 0; i < 30; i++) {
    const r = await fetch(BASE + '/api/state');
    if (r.status === 200) ok++;
    if (r.status === 429) { limited++; retryAfter = r.headers.get('retry-after'); }
  }
  check('S5 全局限流触发 429 + Retry-After', ok > 0 && limited > 0 && retryAfter !== null,
    `200×${ok} 429×${limited} Retry-After=${retryAfter}`);

  // S6 — auth tier is stricter (3/min) and independent of the global tier
  let authLimited = 0;
  for (let i = 0; i < 8; i++) {
    const r = await fetch(BASE + '/api/auth/sign-in/username', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (r.status === 429) authLimited++;
  }
  check('S6 认证端点独立限流（更严格）触发 429', authLimited > 0, `429×${authLimited}/8 (auth=3/min)`);
} finally {
  child.kill('SIGTERM');
}

console.log(`\n=== ${passed}/${passed + failed} security checks passed ===`);
process.exit(failed ? 1 : 0);