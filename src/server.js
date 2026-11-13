import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  assetsRoot, assetsState, criticalPreloadTags, getManifest, isHashedAssetPath, legacyAssetPath,
} from './assets.js';
import { CONFIG } from './rules.js';
import { League } from './league.js';
import { RoomManager } from './rooms.js';
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node';
import { auth } from './auth.js';
import { bootstrapAdmin } from './auth-bootstrap.js';
import { getPlayerStore } from './players.js';
import { normalizeUsername } from './player-shared.js';
import { attachWebSocketServer } from './ws.js';
import { createMCPHandler } from './mcp.js';
import { strategyTemplate } from './strategy-dsl.js';
import { MAX_MODEL_CALLS_PER_MATCH } from './costs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = path.join(ROOT, 'web');
const WEB_DIST = path.join(WEB_DIR, 'dist');
const WEB_DIST_INDEX = path.join(WEB_DIST, 'index.html');
// Client-side routes served by the React app. The game assets and the
// read-only docs/sdk trees below keep their own prefixes.
const SPA_ROUTES = new Set(['/lobby', '/fighters', '/board', '/replay', '/connect', '/account', '/guide', '/training']);
const PORT = Number(process.env.PORT || 8787);
const league = new League();
const players = auth ? await getPlayerStore() : null;
const handleAuth = auth ? toNodeHandler(auth) : null;
if (auth) await bootstrapAdmin({ auth, players });
else console.log('[afl] DATABASE_URL is not set: Better Auth is disabled; run pnpm db:up && pnpm db:migrate to enable accounts.');
const manager = new RoomManager(league);
const handleMCP = createMCPHandler(league, manager, players);
// The hosted (MCP-only) track stays watchable through the exhibition rotation:
// the official hosted baseline is registered and joined into the always-on demo
// rooms, NOT into the ranked queue. Ranked rooms belong to registered players,
// so the board can never fill up with the league playing itself.
league.ensureHostedDemo(strategyTemplate());

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function json(res, status, data, extra = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

async function readJson(req) {
  try { return JSON.parse(await readBody(req) || '{}'); } catch { return {}; }
}

function isSecureRequest(req) {
  return Boolean(req.socket && req.socket.encrypted)
    || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

async function sessionPlayer(req) {
  if (!auth || !players) return null;
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session?.user) return null;
  return players.playerByUserId(session.user.id);
}

function requestOrigin(req) {
  const proto = isSecureRequest(req) ? 'https' : 'http';
  return proto + '://' + (req.headers.host || ('localhost:' + PORT));
}

async function ensurePlayerAgent(player) {
  if (player.agentId) return player;
  const created = league.ensurePlayerAgent({
    playerId: player.id,
    name: (player.displayName || player.username) + ' 的 Agent',
  });
  return players.linkAgent(player.id, created.agentId);
}

function playerView(req, player) {
  const agent = player.agentId ? league.agentById(player.agentId) : null;
  const publicPlayer = players.publicPlayer(player, { includeMcpKey: true });
  const mcp = player.mcpKey
    ? {
      assigned: true,
      issuedAt: player.mcpIssuedAt,
      key: player.mcpKey,
      path: '/mcp/' + player.mcpKey,
      url: requestOrigin(req) + '/mcp/' + player.mcpKey,
    }
    : { assigned: false };
  return {
    player: { ...publicPlayer, mcp: { assigned: mcp.assigned, issuedAt: mcp.issuedAt } },
    agent: agent ? {
      id: agent.id,
      name: agent.name,
      team: agent.team || null,
      teamName: agent.teamName || null,
      source: agent.source,
      versionHash: agent.versionHash,
      rating: Math.round(agent.rating),
      wins: agent.wins,
      losses: agent.losses,
      draws: agent.draws,
      matches: agent.matches,
    } : null,
    mcp,
  };
}

// Public, read-only subtrees served from the project root. Everything else
// comes from web/. Each subtree is resolved against its own directory so
// /docs/../data/league.json cannot leak tokens.
const ROOT_DIRS = {
  '/sdk/': path.join(ROOT, 'sdk'),
  // Read-only game source. The pose lab (web/rig-lab.html) imports the same
  // skeleton code the kernel uses, so the preview cannot drift from the game.
  '/src/': path.join(ROOT, 'src'),
  '/docs/': path.join(ROOT, 'docs'),
  '/examples/': path.join(ROOT, 'examples'),
  '/skills/': path.join(ROOT, 'skills'),
};

const GZIP_CACHE = new Map();
const TEXT_EXT = new Set(['.html', '.css', '.js', '.mjs', '.json', '.md', '.svg']);
const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'public, max-age=3600, must-revalidate';

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('404');
}

function canGzip(req, type) {
  return /^(text\/|application\/json|image\/svg)/i.test(type)
    && String(req.headers['accept-encoding'] || '').includes('gzip');
}

function sendBuffer(req, res, buf, { type, cache, etag }) {
  const headers = {
    'Content-Type': type,
    'Cache-Control': cache,
    'ETag': etag,
    'X-Content-Type-Options': 'nosniff',
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  let body = buf;
  if (canGzip(req, type) && buf.length > 512) {
    const key = etag + ':' + buf.length;
    body = GZIP_CACHE.get(key);
    if (!body) {
      body = zlib.gzipSync(buf, { level: 9 });
      if (GZIP_CACHE.size > 200) GZIP_CACHE.clear();
      GZIP_CACHE.set(key, body);
    }
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end(); else res.end(body);
}

function serveFile(req, res, file, { cache = 'no-cache' } = {}) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    notFound(res);
    return;
  }
  if (!stat.isFile()) { notFound(res); return; }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const etag = '"' + stat.size.toString(16) + '-' + Math.floor(stat.mtimeMs).toString(16) + '"';
  if (TEXT_EXT.has(path.extname(file).toLowerCase())) {
    sendBuffer(req, res, fs.readFileSync(file), { type, cache, etag });
    return;
  }
  const headers = {
    'Content-Type': type,
    'Cache-Control': cache,
    'Content-Length': stat.size,
    'ETag': etag,
    'X-Content-Type-Options': 'nosniff',
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(file).pipe(res);
}

function serveIndex(req, res) {
  const file = WEB_DIST_INDEX;
  if (!fs.existsSync(file)) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('web/dist is missing. Run `pnpm build:web` (or `npm start`, which builds first).');
    return;
  }
  const html = fs.readFileSync(file, 'utf8').replace('<!--ASSET_PRELOAD-->', criticalPreloadTags());
  const buf = Buffer.from(html);
  const etag = '"' + crypto.createHash('sha1').update(buf).digest('hex') + '"';
  sendBuffer(req, res, buf, { type: 'text/html; charset=utf-8', cache: 'no-cache', etag });
}

function serveStatic(req, res, pathname) {
  if (pathname === '/assets/manifest.json') {
    serveFile(req, res, path.join(assetsRoot(), 'manifest.json'), { cache: 'no-cache' });
    return;
  }
  if (pathname === '/assets/sprites.json') {
    serveFile(req, res, path.join(assetsRoot(), 'sprites.json'), { cache: 'no-cache' });
    return;
  }
  if (pathname.startsWith('/assets/v/')) {
    if (!isHashedAssetPath(pathname)) { notFound(res); return; }
    const file = path.resolve(assetsRoot(), pathname.slice('/assets/'.length));
    if (!file.startsWith(assetsRoot() + path.sep)) { notFound(res); return; }
    serveFile(req, res, file, { cache: IMMUTABLE });
    return;
  }
  if (pathname.startsWith('/assets/')) {
    const legacy = legacyAssetPath(pathname);
    if (legacy) { serveFile(req, res, legacy, { cache: REVALIDATE }); return; }
    notFound(res);
    return;
  }
  if (pathname.startsWith('/app/')) {
    const appRoot = path.join(WEB_DIST, 'app');
    const file = path.resolve(appRoot, pathname.slice('/app/'.length));
    if (!file.startsWith(appRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      notFound(res);
      return;
    }
    serveFile(req, res, file, { cache: IMMUTABLE });
    return;
  }
  if (pathname === '/' || pathname === '/index.html' || SPA_ROUTES.has(pathname)) {
    serveIndex(req, res);
    return;
  }
  const prefix = Object.keys(ROOT_DIRS).find((p) => pathname.startsWith(p));
  const baseDir = prefix ? ROOT_DIRS[prefix] : WEB_DIR;
  const rel = prefix ? pathname.slice(prefix.length) : pathname.replace(/^\/+/, '');
  const file = path.resolve(baseDir, rel);
  if (!file.startsWith(baseDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    notFound(res);
    return;
  }
  serveFile(req, res, file, { cache: 'no-cache' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p.startsWith('/api/auth/')) {
    if (!handleAuth) {
      json(res, 503, { error: 'auth is not configured: set DATABASE_URL and run pnpm db:migrate' });
      return;
    }
    await handleAuth(req, res);
    return;
  }
  // Anonymous /mcp is a local dev sandbox only while no player store is
  // configured. Once accounts exist, MCP must go through /mcp/<player key>
  // (see docs/player-accounts.md). The refusal is shaped as JSON-RPC 2.0 on
  // purpose: this is an MCP endpoint, and a bare { error: "<string>" } body is
  // not a JSON-RPC error object, so standard clients - and our own SDK, which
  // reads error.message - surfaced it as an empty message instead of the reason.
  if (p === '/mcp' && players) {
    json(res, 401, {
      jsonrpc: '2.0', id: null,
      error: { code: -32001, message: 'player MCP service required: log in, get your MCP URL, and use /mcp/<player key>' },
    });
    return;
  }
  if (p === '/mcp' || p.startsWith('/mcp/')) {
    const body = await readBody(req);
    handleMCP(req, res, body).catch((err) => {
      console.error('[afl] MCP handler failed:', err);
      if (!res.headersSent) json(res, 500, { error: 'MCP handler failed' });
      else res.end();
    });
    return;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
    res.end();
    return;
  }
  /* ------------------------------------------------- player session */
  if (p === '/api/me' && req.method === 'GET') {
    if (!players) { json(res, 503, { error: 'auth is not configured: set DATABASE_URL and run pnpm db:migrate' }); return; }
    let player = await sessionPlayer(req);
    if (!player) { json(res, 401, { error: 'not logged in' }); return; }
    player = await ensurePlayerAgent(player);
    json(res, 200, playerView(req, player));
    return;
  }
  if (p === '/api/me/mcp' && req.method === 'POST') {
    if (!players) { json(res, 503, { error: 'auth is not configured: set DATABASE_URL and run pnpm db:migrate' }); return; }
    let player = await sessionPlayer(req);
    if (!player) { json(res, 401, { error: 'not logged in' }); return; }
    player = await ensurePlayerAgent(player);
    const issued = await players.issueMcp(player.id);
    json(res, 200, { mcp: { ...issued, url: requestOrigin(req) + issued.path } });
    return;
  }
  if (p === '/api/me/agent' && req.method === 'GET') {
    if (!players) { json(res, 503, { error: 'auth is not configured: set DATABASE_URL and run pnpm db:migrate' }); return; }
    let player = await sessionPlayer(req);
    if (!player) { json(res, 401, { error: 'not logged in' }); return; }
    player = await ensurePlayerAgent(player);
    const agent = player.agentId ? league.agentById(player.agentId) : null;
    if (!agent) { json(res, 404, { error: 'agent not ready' }); return; }
    const presence = manager.presence();
    const queue = presence.queue.find((w) => w.agentId === agent.id) || null;
    const room = manager.listRooms().find((r) => (r.a && r.a.id === agent.id) || (r.b && r.b.id === agent.id)) || null;
    json(res, 200, {
      agent: {
        id: agent.id,
        name: agent.name,
        team: agent.team || null,
        teamName: agent.teamName || null,
        source: agent.source,
        versionHash: agent.versionHash,
        rating: Math.round(agent.rating),
        wins: agent.wins,
        losses: agent.losses,
        draws: agent.draws,
        matches: agent.matches,
        practiceMatches: agent.practiceMatches || 0,
        trainingRuns: agent.trainingRuns || 0,
        // A player account gets an agent before it has a strategy; the training
        // ground needs one, so say which state we are in instead of failing raw.
        hasStrategy: Boolean(agent.hostedStrategy),
        ruleCount: agent.hostedStrategy ? agent.hostedStrategy.rules.length : 0,
      },
      queue,
      room,
      recentMatches: league.getMyMatches({ token: agent.token, limit: 8 }).matches,
      training: league.getTrainingHistory(agent.id, { limit: 8 }),
      cost: playerCost(agent.id),
    });
    return;
  }
  /** What this agent actually consumed, from server-observed counters only. */
  function playerCost(agentId) {
    const st = league.getAgentStats(agentId);
    if (!st) return null;
    return {
      declaredModelCalls: st.modelCalls,
      timeouts: st.timeouts,
      budgetExceeded: st.budgetExceeded,
      hostedTicksEvaluated: st.hostedTicksEvaluated,
      trainingRuns: st.trainingRuns,
      budgetLimit: MAX_MODEL_CALLS_PER_MATCH,
      hosted: st.hosted,
    };
  }
  /* ---------------------------------------------------------- cost model */
  if (p === '/api/costs' && req.method === 'GET') {
    // The cost model plus what the platform is actually spending right now.
    json(res, 200, { ...league.costModel(), platformUsage: { replays: league.replayStore() } });
    return;
  }
  if (p === '/api/stages' && req.method === 'GET') {
    // The stage registry plus how an arena is chosen. Published as data so the
    // client renders what the server declared instead of inventing a scene.
    json(res, 200, league.stageModel());
    return;
  }
  if (p === '/api/training/drills' && req.method === 'GET') {
    json(res, 200, league.listDrills());
    return;
  }
  /* ------------------------------------------------------- training ground
   * Training is the player's own sandbox: it runs the league bot algorithms on
   * the deterministic kernel, calls no model, and never reaches recordMatch -
   * so the ladder, the schedule and the replay store stay untouched.
   */
  if (p.startsWith('/api/training/') && req.method === 'POST') {
    if (!players) { json(res, 503, { error: 'auth is not configured: set DATABASE_URL and run pnpm db:migrate' }); return; }
    let player = await sessionPlayer(req);
    if (!player) { json(res, 401, { error: 'not logged in' }); return; }
    player = await ensurePlayerAgent(player);
    const agent = player.agentId ? league.agentById(player.agentId) : null;
    if (!agent) { json(res, 404, { error: 'agent not ready' }); return; }
    const body = await readJson(req);
    try {
      if (p === '/api/training/run') {
        json(res, 200, league.runTrainingFor({ agent, strategy: body.strategy || null, drills: body.drills, seeds: body.seeds, rounds: body.rounds, maxGames: body.maxGames }));
        return;
      }
      if (p === '/api/training/compare') {
        if (!body.strategyB) { json(res, 400, { error: 'strategyB is required' }); return; }
        json(res, 200, league.compareTraining({ agent, strategyA: body.strategyA || null, strategyB: body.strategyB, drills: body.drills, seeds: body.seeds, rounds: body.rounds }));
        return;
      }
      json(res, 404, { error: 'unknown training route' });
    } catch (err) {
      json(res, 400, { error: String(err && err.message || err) });
    }
    return;
  }
  if (p === '/api/training/history' && req.method === 'GET') {
    if (!players) { json(res, 503, { error: 'auth is not configured' }); return; }
    let player = await sessionPlayer(req);
    if (!player) { json(res, 401, { error: 'not logged in' }); return; }
    player = await ensurePlayerAgent(player);
    const agent = player.agentId ? league.agentById(player.agentId) : null;
    if (!agent) { json(res, 404, { error: 'agent not ready' }); return; }
    json(res, 200, league.getTrainingHistory(agent.id, { limit: url.searchParams.get('limit') }));
    return;
  }
  /* ------------------------------------------------------- admin console */
  if (p === '/api/admin/players' && req.method === 'GET') {
    if (!players) { json(res, 503, { error: 'auth is not configured' }); return; }
    const current = await sessionPlayer(req);
    if (!current) { json(res, 401, { error: 'not logged in' }); return; }
    if (current.role !== 'admin') { json(res, 403, { error: 'admin only' }); return; }
    const rows = (await players.listPlayers({ includeMcpKey: true })).map((row) => {
      const agent = row.agentId ? league.agentById(row.agentId) : null;
      return {
        ...row,
        mcp: row.mcp.assigned
          ? { ...row.mcp, url: requestOrigin(req) + row.mcp.path }
          : row.mcp,
        agent: agent ? {
          id: agent.id,
          name: agent.name,
          team: agent.team || null,
          teamName: agent.teamName || null,
          rating: Math.round(agent.rating),
          wins: agent.wins,
          losses: agent.losses,
          matches: agent.matches,
        } : null,
      };
    });
    json(res, 200, { players: rows });
    return;
  }
  if (p === '/api/admin/players' && req.method === 'POST') {
    if (!players) { json(res, 503, { error: 'auth is not configured' }); return; }
    const current = await sessionPlayer(req);
    if (!current) { json(res, 401, { error: 'not logged in' }); return; }
    if (current.role !== 'admin') { json(res, 403, { error: 'admin only' }); return; }
    const args = await readJson(req);
    try {
      const username = normalizeUsername(args.username);
      const password = String(args.password || '');
      if (password.length < 8) throw new Error('password must be at least 8 characters');
      const displayName = String(args.displayName || '').trim() || username;
      const email = String(args.email || `${username}@players.local`);
      const result = await auth.api.signUpEmail({
        body: { email, password, name: displayName, username },
      });
      let profile = await players.playerByUserId(result.user.id);
      if (!profile) {
        profile = await players.createProfile({
          userId: result.user.id,
          username,
          displayName,
          role: 'player',
        });
      }
      profile = await ensurePlayerAgent(profile);
      json(res, 200, { player: players.publicPlayer(profile, { includeMcpKey: true }) });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
    return;
  }
  if (p.startsWith('/api/admin/players/') && p.endsWith('/mcp') && req.method === 'POST') {
    if (!players) { json(res, 503, { error: 'auth is not configured' }); return; }
    const current = await sessionPlayer(req);
    if (!current) { json(res, 401, { error: 'not logged in' }); return; }
    if (current.role !== 'admin') { json(res, 403, { error: 'admin only' }); return; }
    const playerId = decodeURIComponent(p.slice('/api/admin/players/'.length, -'/mcp'.length));
    let player = await players.playerById(playerId);
    if (!player) { json(res, 404, { error: 'player not found' }); return; }
    player = await ensurePlayerAgent(player);
    const issued = await players.issueMcp(player.id);
    const refreshed = await players.playerById(player.id);
    json(res, 200, {
      player: players.publicPlayer(refreshed, { includeMcpKey: true }),
      mcp: { ...issued, url: requestOrigin(req) + issued.path },
    });
    return;
  }
  // One URL an AI agent client can read to learn the entire game.
  if (p === '/SKILL.md' || p === '/skill.md') {
    const file = path.join(ROOT, 'skills', 'afl-league', 'SKILL.md');
    if (!fs.existsSync(file)) { json(res, 404, { error: 'skill not found' }); return; }
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
    res.end(fs.readFileSync(file, 'utf8'));
    return;
  }
  if (p === '/api/state') {
    json(res, 200, {
      server: { name: 'Agent Fighting League', season: league.season, tickMs: CONFIG.TICK_MS, framesPerTick: CONFIG.FRAMES_PER_TICK, matchTicks: CONFIG.MATCH_TICKS, version: '0.10.0' },
      assets: assetsState(),
      // The stage registry travels with the state so a viewer can resolve the
      // `stage` id it was handed (name, plate, seed-driven layer parameters)
      // without a second request. It is reference data, not per-match state.
      stages: league.stageModel(),
      match: manager.meta(),
      rooms: manager.listRooms(),
      lobby: manager.state(),
      leaderboard: league.getLeaderboard(),
      costs: { ...league.costModel(), platformUsage: { replays: league.replayStore() } },
      recentMatches: league.recentMatches(12),
      agents: league.listAgents(),
      fighters: league.listFighters(),
      teams: league.listTeams(),
      queue: manager.waiting.length,
      spectators: manager.state().spectators,
      onlineAgents: manager.agentConns.size,
    });
    return;
  }
  if (p === '/api/assets') {
    const manifest = getManifest();
    if (!manifest) { json(res, 503, { error: 'asset manifest unavailable' }); return; }
    json(res, 200, manifest);
    return;
  }
  if (p === '/api/rooms') {
    json(res, 200, { rooms: manager.listRooms(), lobby: manager.state() });
    return;
  }
  if (p === '/api/fighters') {
    json(res, 200, { fighters: league.listFighters(), teams: league.listTeams() });
    return;
  }
  if (p === '/api/leaderboard') {
    json(res, 200, league.getLeaderboard({ track: url.searchParams.get('track') }));
    return;
  }
  if (p === '/api/matches') {
    json(res, 200, { matches: league.recentMatches(40) });
    return;
  }
  if (p === '/api/agents') {
    json(res, 200, { agents: league.listAgents() });
    return;
  }
  if (p === '/api/rules') {
    json(res, 200, league.getRules());
    return;
  }
  if (p.startsWith('/api/replay/')) {
    const matchId = decodeURIComponent(p.slice('/api/replay/'.length));
    if (url.searchParams.get('render') === '1') {
      const rendered = manager.getRenderedReplay(matchId);
      if (!rendered) { json(res, 404, { error: 'replay not found' }); return; }
      json(res, 200, { matchId, match: league.getMatchResult(matchId), ticks: rendered });
      return;
    }
    const text = league.getReplay(matchId);
    if (text === null) { json(res, 404, { error: 'replay not found' }); return; }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(text);
    return;
  }
  serveStatic(req, res, p);
});

attachWebSocketServer(server, {
  onConnection: (conn, url) => {
    if (url.pathname === '/ws/spectate') {
      manager.spectate(conn, url.searchParams.get('room'));
      return;
    }
    if (url.pathname === '/ws/agent') {
      const token = url.searchParams.get('token');
      const agent = league.agentByToken(token);
      if (!agent) {
        conn.send({ type: 'error', code: 'invalid_token', message: 'Invalid token. Connect through a player MCP service.' });
        conn.close();
        return;
      }
      if (!agent.playerId) {
        conn.send({ type: 'error', code: 'player_login_required', message: 'Player login required: anonymous agents cannot enter matches.' });
        conn.close();
        return;
      }
      conn.meta.token = token;
      conn.meta.agentId = agent.id;
      manager.joinAgent(conn, agent, {
        mode: url.searchParams.get('mode') || 'ranked',
        code: url.searchParams.get('room'),
        format: url.searchParams.get('format') === 'team' ? 'team' : 'single',
      });
      return;
    }
    conn.close();
  },
});

server.listen(PORT, () => {
  console.log('[afl] server listening on http://localhost:' + PORT);
  if (auth) console.log('[afl] Better Auth         POST /api/auth/*  (sign-up/email, sign-in/username, sign-out)');
  console.log('[afl] per-player MCP     POST /mcp/<key>  (assign in 玩家入口)');
  console.log('[afl] ' + (auth ? 'legacy MCP         POST /mcp  (closed: player accounts active)' : 'legacy MCP         POST /mcp  (anonymous dev sandbox)'));
  console.log('[afl] Agent skill         GET  http://localhost:' + PORT + '/SKILL.md');
  console.log('[afl] spectator websocket ws://localhost:' + PORT + '/ws/spectate?room=<roomId>');
  console.log('[afl] agent websocket     ws://localhost:' + PORT + '/ws/agent?token=...');
  console.log('[afl] lobby               ' + manager.listRooms().length + ' rooms, demo running');
});

process.on('SIGINT', () => {
  manager.shutdown();
  server.close(() => process.exit(0));
});
