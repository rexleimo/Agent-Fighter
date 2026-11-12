// Shared harness helper for the live gates.
//
// Since v0.9 the league has no anonymous control plane: a service that can read
// and move a player's agent is bound to that player, so every gate that drives
// MCP must first become a player. This module does that once, the same way the
// documented onboarding does it:
//
//   1. sign up through Better Auth, keeping the session cookie
//   2. POST /api/me/mcp to mint this player's single service key
//   3. call /mcp/<key> - the endpoint the official SDK already accepts
//
// Origin matters: Better Auth rejects cross-origin POSTs and its baseURL
// defaults to http://localhost:<PORT>, so callers must use that exact origin.
//
// Only four names are public surface: authEnv, onboardPlayer, mcpTool,
// mcpInitialize. Everything else here is internal to this flow.

/** Env block for spawning a test server that has auth configured. */
export function authEnv(port, testDatabaseUrl) {
  const origin = 'http://localhost:' + port;
  return {
    PORT: String(port),
    DATABASE_URL: testDatabaseUrl,
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_TRUSTED_ORIGINS: origin,
  };
}

function stamp() {
  return new Date().toISOString().slice(11, 23).replace(/[:.]/g, '');
}

async function post(base, pathName, body, cookie) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', Origin: base };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + pathName, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }
  const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return { res, data, cookie: setCookie.map((c) => c.split(';')[0]).join('; ') };
}

async function signUpPlayer(base, { username, password, displayName }) {
  const r = await post(base, '/api/auth/sign-up/email', {
    email: username + '@league.test', username, name: displayName, displayName, password,
  });
  if (r.res.ok && r.cookie) return r.cookie;
  throw new Error('signup failed ' + r.res.status + ' ' + JSON.stringify(r.data).slice(0, 160));
}

/** Mint (or re-issue) this player's key. POST is the only way to get one. */
async function issueMcpKey(base, cookie) {
  const r = await post(base, '/api/me/mcp', {}, cookie);
  if (!r.res.ok) throw new Error('issue key failed ' + r.res.status + ' ' + JSON.stringify(r.data).slice(0, 160));
  const key = r.data?.mcp?.key;
  if (!key) throw new Error('no key in POST /api/me/mcp response: ' + JSON.stringify(r.data).slice(0, 160));
  return key;
}

/**
 * One JSON-RPC tools/call against a player endpoint. Failures come back as the
 * league's own message instead of a crash on an undefined `result` - the old
 * gates died with "Cannot read properties of undefined" and hid the real cause.
 */
export async function mcpTool(endpoint, name, args = {}) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const text = (body && (body.error?.message || body.error || body.message)) || body;
    throw new Error('MCP ' + name + ' http ' + res.status + ': ' + String(JSON.stringify(text)).slice(0, 200));
  }
  const r = body && body.result;
  if (!r) {
    throw new Error('MCP ' + name + ': no JSON-RPC result. ' + String(JSON.stringify(body)).slice(0, 200)
      + '\n  hint: a player-bound service URL is required (GET /api/me/mcp -> /mcp/<key>).');
  }
  if (r.isError) throw new Error('MCP ' + name + ' isError: ' + String(r.content?.[0]?.text || '').slice(0, 240));
  return r.structuredContent;
}

export async function mcpInitialize(endpoint) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'afl-gate', version: '1' } } }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.result) {
    throw new Error('MCP initialize http ' + res.status + ': ' + String(JSON.stringify(body)).slice(0, 200));
  }
  return body.result;
}

/**
 * Full onboarding for one throwaway player: sign up, mint the key, register
 * nothing else. Returns the session cookie, the service endpoint, and a bound
 * `tool()` so a gate never has to think about which player owns a call.
 */
export async function onboardPlayer(base, label) {
  const password = 'gate-pass-123';
  // Better Auth enforces a username pattern (lowercase alnum plus -/_), so the
  // human-readable label must be slugged before it becomes an identifier.
  const slug = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'player';
  const username = 'gate_' + slug + '_' + stamp() + Math.random().toString(36).slice(2, 6);
  const cookie = await signUpPlayer(base, { username, password, displayName: label });
  const key = await issueMcpKey(base, cookie);
  return {
    username,
    password,
    cookie,
    key,
    endpoint: base + '/mcp/' + key,
    tool: (name, args = {}) => mcpTool(base + '/mcp/' + key, name, args),
  };
}
