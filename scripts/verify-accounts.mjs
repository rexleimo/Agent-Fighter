/**
 * Player-account acceptance: the human registers a username/password, gets a
 * per-player MCP service URL, and the Agent does everything else through it.
 *
 *   admin login -> create player -> player login -> issue MCP key
 *   -> MCP initialize -> get_my_profile -> register_agent (twice, idempotent)
 *   -> set_team(teamName, roster) -> submit_strategy -> join_queue(team)
 *   -> rotate key: old URL 401, new URL works
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = { username: 'admin', password: 'admin-test-pass-123' };
const PLAYER = { username: 'rex_player', password: 'player-pass-123', displayName: 'Rex Player' };

const TEST_DB = process.env.AFL_TEST_DATABASE_URL || '';
if (!TEST_DB) {
  console.error('AFL_TEST_DATABASE_URL is required: point it at a dedicated Postgres database, not your dev database.');
  process.exit(1);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  |  ' + detail : ''));
  return ok;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(base, child) {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    if (child.exitCode != null) throw new Error('server exited with code ' + child.exitCode);
    try {
      const res = await fetch(base + '/api/state');
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not become ready');
}

function cookieHeader(res) {
  const lines = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  return lines.map((line) => line.split(';')[0]).join('; ');
}

const PORT = await freePort();
const BASE = 'http://127.0.0.1:' + PORT;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'afl-accounts-'));
let child = null;
let rpcId = 0;

async function request(pathname, { method = 'GET', body, cookie, key } = {}) {
  const headers = { 'Content-Type': 'application/json', Origin: BASE };
  if (cookie) headers.Cookie = cookie;
  if (key) headers.Authorization = 'Bearer ' + key;
  const res = await fetch(BASE + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { res, data, cookie: cookieHeader(res) };
}

async function login(credentials) {
  const { res, data, cookie } = await request('/api/auth/sign-in/username', {
    method: 'POST',
    body: credentials,
  });
  assert.equal(res.status, 200, 'login failed: ' + JSON.stringify(data));
  return { data, cookie };
}

async function rpc(method, params, key) {
  const pathname = key ? '/mcp/' + encodeURIComponent(key) : '/mcp';
  const { res, data } = await request(pathname, {
    method: 'POST',
    body: { jsonrpc: '2.0', id: ++rpcId, method, params },
    key,
  });
  return { res, data };
}

async function tool(name, args, key) {
  const { res, data } = await rpc('tools/call', { name, arguments: args }, key);
  assert.equal(res.status, 200, 'tools/call transport: ' + res.status);
  const result = data.result;
  assert.ok(result, 'tools/call result missing: ' + JSON.stringify(data));
  if (result.isError) throw new Error(name + ': ' + (result.content?.[0]?.text || 'tool error'));
  return result.structuredContent;
}

async function run() {
  child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      AFL_DATA_DIR: TMP,
      AFL_ADMIN_USERNAME: ADMIN.username,
      AFL_ADMIN_PASSWORD: ADMIN.password,
      AFL_TICK_MS: '20',
      DATABASE_URL: TEST_DB,
      BETTER_AUTH_URL: BASE,
      BETTER_AUTH_TRUSTED_ORIGINS: BASE + ',http://localhost:' + PORT + ',http://localhost:5173,http://localhost:5174',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (chunk) => { serverLog += chunk; });
  child.stderr.on('data', (chunk) => { serverLog += chunk; });
  await waitForServer(BASE, child);

  const adminLogin = await login(ADMIN);
  const adminMe = await request('/api/me', { cookie: adminLogin.cookie });
  check('A1 admin bootstrap login', adminMe.data.player?.role === 'admin', adminMe.data.player?.username);
  const admin = { cookie: adminLogin.cookie };

  const created = await request('/api/admin/players', {
    method: 'POST',
    cookie: admin.cookie,
    body: PLAYER,
  });
  check('A2 admin creates a player (no roster)', created.res.status === 200
    && created.data.player.username === PLAYER.username
    && Boolean(created.data.player.agentId)
    && created.data.player.mcp.assigned === false, JSON.stringify(created.data.player?.mcp));

  const dup = await request('/api/admin/players', {
    method: 'POST',
    cookie: admin.cookie,
    body: PLAYER,
  });
  check('A3 duplicate username rejected', dup.res.status === 400, JSON.stringify(dup.data));

  const playerLogin = await login(PLAYER);
  const player = { cookie: playerLogin.cookie };
  const playerMe = await request('/api/me', { cookie: player.cookie });
  check('A4 player login', playerMe.data.player.username === PLAYER.username
    && playerMe.data.player.role === 'player' && Boolean(playerMe.data.player.agentId), playerMe.data.player.agentId);

  const meBefore = await request('/api/me', { cookie: player.cookie });
  check('A5 registration has no team yet', meBefore.data.mcp.assigned === false
    && meBefore.data.agent.team === null, JSON.stringify(meBefore.data.agent));

  const issued = await request('/api/me/mcp', { method: 'POST', body: {}, cookie: player.cookie });
  const key = issued.data.mcp?.key;
  check('A6 self-service MCP service issued', issued.res.status === 200
    && typeof key === 'string' && key.startsWith('mcp_')
    && issued.data.mcp.url.includes('/mcp/' + key), issued.data.mcp?.url);

  const init = await rpc('initialize', { protocolVersion: '2025-06-18' }, key);
  check('A7 MCP initialize resolves the player identity', init.res.status === 200
    && String(init.data.result?.instructions || '').includes(PLAYER.username), init.res.status);

  const listed = await rpc('tools/list', {}, key);
  const toolNames = (listed.data.result?.tools || []).map((t) => t.name);
  check('A8 get_my_profile is exposed', toolNames.includes('get_my_profile'), toolNames.length + ' tools');

  const profile0 = await tool('get_my_profile', {}, key);
  check('A9 profile shows the bound player and empty roster',
    profile0.player.username === PLAYER.username && profile0.agent.team === null,
    profile0.agent?.id);

  const reg1 = await tool('register_agent', {}, key);
  const reg2 = await tool('register_agent', {}, key);
  check('A10 register_agent is idempotent on a player MCP service',
    reg1.agentId === reg2.agentId && reg1.agentId === profile0.agent.id && reg2.existing === true,
    reg1.agentId);

  const team = await tool('set_team', {
    teamName: '疾风怒涛队',
    team: ['ember', 'tide', 'basalt'],
  }, key);
  check('A11 Agent builds the team and names it',
    team.teamName === '疾风怒涛队' && team.team.length === 3
    && team.team[0] === 'ember', JSON.stringify(team.team));

  const profile1 = await tool('get_my_profile', {}, key);
  check('A12 profile reflects the agent-built team',
    profile1.agent.teamName === '疾风怒涛队' && profile1.agent.team?.length === 3,
    profile1.nextSteps);

  const template = await tool('get_strategy_template', {}, key);
  const submitted = await tool('submit_strategy', { strategy: template.template }, key);
  check('A13 Agent submits a hosted strategy', Boolean(submitted.versionHash), submitted.versionHash);

  const queued = await tool('join_queue', { format: 'team' }, key);
  check('A14 Agent signs up for ranked team matchmaking',
    queued.joined === true && queued.format === 'team', JSON.stringify(queued));

  const agents = await request('/api/agents');
  const row = agents.data.agents.find((a) => a.id === reg1.agentId);
  check('A15 public agent list carries the team name', row?.teamName === '疾风怒涛队', row?.teamName);

  const rotated = await request('/api/me/mcp', { method: 'POST', body: {}, cookie: player.cookie });
  const nextKey = rotated.data.mcp?.key;
  const oldInit = await rpc('initialize', {}, key);
  const newInit = await rpc('initialize', {}, nextKey);
  check('A16 rotating the MCP URL invalidates the old one',
    oldInit.res.status === 401 && nextKey !== key && nextKey.startsWith('mcp_') && newInit.res.status === 200,
    'old=' + oldInit.res.status + ' new=' + newInit.res.status);

  const wrong = await request('/api/auth/sign-in/username', {
    method: 'POST',
    body: { username: PLAYER.username, password: 'wrong-password' },
  });
  check('A17 wrong password rejected', wrong.res.status === 401, wrong.res.status);

  const logout = await request('/api/auth/sign-out', { method: 'POST', body: {}, cookie: player.cookie });
  const after = await request('/api/me', { cookie: player.cookie });
  check('A18 logout invalidates the session', logout.res.status === 200 && after.res.status === 401, after.res.status);

  const legacy = await tool('register_agent', { name: 'Legacy Anonymous' });
  check('A19 legacy anonymous /mcp still works', Boolean(legacy.token) && legacy.existing === false,
    String(legacy.agentId));
}

try {
  await run();
} catch (err) {
  check('fatal', false, err.message);
} finally {
  if (child) {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
      child.on('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  fs.rmSync(TMP, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
if (failed.length) {
  console.error('FAILED: ' + failed.map((r) => r.name).join(', '));
  process.exit(1);
}
