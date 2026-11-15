/**
 * First-run setup acceptance (S1–S8, docs/plans/2026-11-15-first-run-setup.test-design.md).
 *
 * Real process + real Postgres: a throwaway database is created on the test
 * server, migrated, and probed through public HTTP only. The setup page/API is
 * the ONE way an admin is created; once an admin exists it is locked forever
 * (409), including across restarts.
 *
 *   S1 empty DB -> needsSetup=true
 *   S6 weak password -> 400, still needsSetup
 *   S2 POST /api/setup -> admin created, session cookie, /api/me role=admin
 *   S3 status -> needsSetup=false
 *   S4 second POST -> 409, exactly one admin
 *   S5 restart same DB -> still locked (status false, POST 409)
 *   S7 auth disabled (DATABASE_URL='') -> status false, POST 503
 *   S8 strict spawn -> oversized body 413, auth-limiter 429 + Retry-After
 *
 * Requires AFL_TEST_DATABASE_URL (or DATABASE_URL) pointing at a disposable
 * Postgres server; the script CREATEs/DROPs its own databases and never touches
 * the source database.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DB = process.env.AFL_TEST_DATABASE_URL || process.env.DATABASE_URL || '';
if (!SOURCE_DB) {
  console.error('AFL_TEST_DATABASE_URL (or DATABASE_URL) is required: a disposable Postgres server URL.');
  process.exit(1);
}

const RUN = Date.now().toString(36).slice(-6);
const ADMIN = { username: 'setup_admin_' + RUN, password: 'setup-pass-123', displayName: 'Setup Admin ' + RUN };
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  |  ' + detail : ''));
  return ok;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function cookieHeader(res) {
  const lines = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  return lines.map((line) => line.split(';')[0]).join('; ');
}

async function waitForServer(base, child) {
  const started = Date.now();
  while (Date.now() - started < 20000) {
    if (child.exitCode != null) throw new Error('server exited with code ' + child.exitCode);
    try {
      const res = await fetch(base + '/api/state');
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not become ready');
}

function withDatabase(url, name) {
  const u = new URL(url);
  u.pathname = '/' + name;
  return u.toString();
}

async function adminQuery(sql) {
  // Connect to the built-in 'postgres' database to CREATE/DROP throwaway DBs.
  const client = new pg.Client({ connectionString: withDatabase(SOURCE_DB, 'postgres') });
  await client.connect();
  try { return await client.query(sql); } finally { await client.end(); }
}

async function createDatabase(name) {
  await adminQuery('CREATE DATABASE ' + name);
  const url = withDatabase(SOURCE_DB, name);
  await new Promise((resolve, reject) => {
    const mig = spawn(process.execPath, ['run', 'db:migrate'], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: url },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    mig.stdout.on('data', (d) => { log += d; });
    mig.stderr.on('data', (d) => { log += d; });
    mig.on('exit', (code) => code === 0 ? resolve() : reject(new Error('db:migrate exited ' + code + '\n' + log)));
  });
  return url;
}

const children = new Set();
async function spawnServer({ dbUrl, extraEnv = {} }) {
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afl-setup-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      AFL_DATA_DIR: dir,
      AFL_TICK_MS: '20',
      DATABASE_URL: dbUrl,
      BETTER_AUTH_SECRET: 'setup-test-secret-setup-test-secret-32',
      BETTER_AUTH_URL: base,
      BETTER_AUTH_TRUSTED_ORIGINS: base,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  await waitForServer(base, child);
  return { child, base, log: () => log };
}

function stopServer(server) {
  children.delete(server.child);
  server.child.kill();
}

async function request(base, pathname, { method = 'GET', body, cookie, rawBody } = {}) {
  const headers = { 'Content-Type': 'application/json', Origin: base };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + pathname, {
    method,
    headers,
    body: rawBody !== undefined ? rawBody : (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { res, data, cookie: cookieHeader(res) };
}

const databases = [];
async function run() {
  const dbMain = 'afl_setup_' + RUN;
  const dbStrict = 'afl_setup_strict_' + RUN;
  databases.push(dbMain, dbStrict);
  const mainUrl = await createDatabase(dbMain);

  // ---- S1/S6/S2/S3/S4 on a fresh, empty database --------------------------
  let server = await spawnServer({ dbUrl: mainUrl });
  const base = server.base;

  const s1 = await request(base, '/api/setup/status');
  check('S1 empty DB needs setup', s1.res.status === 200 && s1.data.needsSetup === true,
    'status=' + s1.res.status + ' body=' + JSON.stringify(s1.data));

  const weak = await request(base, '/api/setup', { method: 'POST', body: { username: ADMIN.username, password: 'short' } });
  const still = await request(base, '/api/setup/status');
  check('S6 weak password rejected, no half-state', weak.res.status === 400 && still.data.needsSetup === true,
    'status=' + weak.res.status);

  const created = await request(base, '/api/setup', { method: 'POST', body: ADMIN });
  let adminCookie = created.cookie;
  const me = adminCookie ? await request(base, '/api/me', { cookie: adminCookie }) : { data: {} };
  check('S2 setup creates admin and signs in', created.res.status === 200
    && Boolean(adminCookie) && me.data.player?.role === 'admin'
    && me.data.player?.username === ADMIN.username,
    'status=' + created.res.status + ' role=' + me.data.player?.role);

  const s3 = await request(base, '/api/setup/status');
  check('S3 status closes after setup', s3.res.status === 200 && s3.data.needsSetup === false,
    JSON.stringify(s3.data));

  const again = await request(base, '/api/setup', {
    method: 'POST',
    body: { username: 'intruder_' + RUN, password: 'intruder-pass-123' },
  });
  const roster = adminCookie ? await request(base, '/api/admin/players', { cookie: adminCookie }) : { data: {} };
  const admins = (roster.data.players || []).filter((p) => p.role === 'admin');
  check('S4 second setup locked with 409, one admin', again.res.status === 409 && admins.length === 1,
    'status=' + again.res.status + ' admins=' + admins.length);

  // ---- S5: lock survives a restart on the same database -------------------
  stopServer(server);
  server = await spawnServer({ dbUrl: mainUrl });
  const s5status = await request(server.base, '/api/setup/status');
  const s5post = await request(server.base, '/api/setup', {
    method: 'POST',
    body: { username: 'restart_' + RUN, password: 'restart-pass-123' },
  });
  check('S5 restart keeps setup locked', s5status.data.needsSetup === false && s5post.res.status === 409,
    'needsSetup=' + s5status.data.needsSetup + ' post=' + s5post.res.status);
  stopServer(server);

  // ---- S7: auth disabled -> setup inert -----------------------------------
  server = await spawnServer({ dbUrl: '', extraEnv: { DATABASE_URL: '' } });
  const s7status = await request(server.base, '/api/setup/status');
  const s7post = await request(server.base, '/api/setup', { method: 'POST', body: ADMIN });
  check('S7 auth off: status false, POST 503', s7status.res.status === 200
    && s7status.data.needsSetup === false && s7post.res.status === 503,
    'status=' + s7status.res.status + '/' + s7post.res.status);
  stopServer(server);

  // ---- S8: body cap and auth rate limiter really fire ---------------------
  const strictUrl = await createDatabase(dbStrict);
  server = await spawnServer({
    dbUrl: strictUrl,
    extraEnv: { AFL_RATE_AUTH: '3', AFL_RATE_GLOBAL: '0', AFL_MAX_BODY_BYTES: '2048' },
  });
  const big = await request(server.base, '/api/setup', {
    method: 'POST',
    rawBody: JSON.stringify({ username: 'big_' + RUN, password: 'x'.repeat(4096) }),
  });
  check('S8a oversized setup body -> 413', big.res.status === 413, 'status=' + big.res.status);
  let got429 = null;
  for (let i = 0; i < 6 && !got429; i++) {
    const attempt = await request(server.base, '/api/setup', {
      method: 'POST', body: { username: 'flood_' + RUN + '_' + i, password: 'flood-pass-123' },
    });
    if (attempt.res.status === 429) got429 = attempt;
  }
  check('S8b setup floods -> 429 + Retry-After', Boolean(got429) && Boolean(got429.res.headers.get('retry-after')),
    got429 ? 'retry-after=' + got429.res.headers.get('retry-after') : 'no 429 within 6 attempts');
  stopServer(server);
}

let failure = null;
try {
  await run();
} catch (err) {
  failure = err;
  console.error('verify-setup aborted:', err?.message ?? err);
} finally {
  for (const child of children) child.kill();
  for (const name of databases) {
    try { await adminQuery('DROP DATABASE IF EXISTS ' + name + ' WITH (FORCE)'); }
    catch (err) { console.error('cleanup failed for ' + name + ':', err?.message ?? err); }
  }
}

const passed = results.filter((r) => r.ok).length;
console.log('\nverify-setup: ' + passed + '/' + results.length + ' passed');
if (failure || passed !== results.length || results.length === 0) process.exit(1);
console.log('first-run setup acceptance: OK');
