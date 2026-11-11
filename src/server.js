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
import { attachWebSocketServer } from './ws.js';
import { createMCPHandler } from './mcp.js';
import { strategyTemplate } from './strategy-dsl.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = path.join(ROOT, 'web');
const PORT = Number(process.env.PORT || 8787);
const league = new League();
const manager = new RoomManager(league);
const handleMCP = createMCPHandler(league, manager);
// Always-on example of the MCP-only hosted track, so the lobby shows a real
// ranked room running concurrently with the demo showcase room.
manager.enqueue({ agent: league.ensureHostedDemo(strategyTemplate()), mode: 'ranked' });

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
  const file = path.join(WEB_DIR, 'index.html');
  if (!fs.existsSync(file)) { notFound(res); return; }
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
  if (pathname === '/' || pathname === '/index.html') {
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

  if (p === '/mcp') {
    const body = await readBody(req);
    handleMCP(req, res, body);
    return;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
    res.end();
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
      server: { name: 'Agent Fighting League', season: league.season, tickMs: CONFIG.TICK_MS, framesPerTick: CONFIG.FRAMES_PER_TICK, matchTicks: CONFIG.MATCH_TICKS, version: '0.2.0' },
      assets: assetsState(),
      match: manager.meta(),
      rooms: manager.listRooms(),
      lobby: manager.state(),
      leaderboard: league.getLeaderboard(),
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
  if (p === '/api/team-exhibition' && req.method === 'POST') {
    let args = {};
    try { args = JSON.parse(await readBody(req) || '{}'); } catch { /* defaults */ }
    try {
      const room = manager.createExhibition({ teamA: args.teamA, teamB: args.teamB });
      json(res, 200, {
        roomId: room.id, code: room.code, format: 'team', team: room.teams,
        watchUrl: '/?view=live&room=' + encodeURIComponent(room.id),
        note: 'Exhibition: built-in agents pilot the teams you picked. Unranked.',
      });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
    return;
  }
  if (p === '/api/token' && req.method === 'POST') {
    let args = {};
    try { args = JSON.parse(await readBody(req) || '{}'); } catch { /* defaults */ }
    try {
      const created = league.registerAgent({ name: args.name || 'My Agent', kind: args.kind || 'rule', fighterId: args.fighterId, source: 'external' });
      json(res, 200, { ...created, wsUrl: '/ws/agent?token=' + created.token, httpOrigin: 'http://localhost:' + PORT, note: 'Connect a realtime process, or use MCP submit_strategy for the hosted track.' });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
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
        conn.send({ type: 'error', code: 'invalid_token', message: 'Register first via MCP register_agent or /api/token' });
        conn.close();
        return;
      }
      conn.meta.token = token;
      conn.meta.agentId = agent.id;
      manager.joinAgent(conn, agent, {
        mode: url.searchParams.get('mode') || 'ranked',
        code: url.searchParams.get('room'),
      });
      return;
    }
    conn.close();
  },
});

server.listen(PORT, () => {
  console.log('[afl] server listening on http://localhost:' + PORT);
  console.log('[afl] MCP endpoint        POST http://localhost:' + PORT + '/mcp');
  console.log('[afl] Agent skill         GET  http://localhost:' + PORT + '/SKILL.md');
  console.log('[afl] spectator websocket ws://localhost:' + PORT + '/ws/spectate?room=<roomId>');
  console.log('[afl] agent websocket     ws://localhost:' + PORT + '/ws/agent?token=...');
  console.log('[afl] lobby               ' + manager.listRooms().length + ' rooms, demo running');
});

process.on('SIGINT', () => {
  manager.shutdown();
  server.close(() => process.exit(0));
});
