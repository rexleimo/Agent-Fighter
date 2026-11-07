import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

function serveStatic(req, res, pathname) {
  const prefix = Object.keys(ROOT_DIRS).find((p) => pathname.startsWith(p));
  const baseDir = prefix ? ROOT_DIRS[prefix] : WEB_DIR;
  const rel = prefix
    ? pathname.slice(prefix.length)
    : (pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
  const file = path.resolve(baseDir, rel);
  if (!file.startsWith(baseDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
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
