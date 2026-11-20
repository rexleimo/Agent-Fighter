/**
 * Server assembly entry point.
 *
 * All route bodies live in src/http/*.js; this file only builds the shared
 * context, wires the request handler and the WebSocket server, starts
 * listening and handles shutdown. The dispatch order is defined in
 * src/http/index.js and is part of the HTTP contract.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toNodeHandler } from 'better-auth/node';
import { League } from './league.js';
import { RoomManager } from './rooms.js';
import { auth } from './auth.js';
import { needsSetup } from './auth-bootstrap.js';
import { getPlayerStore } from './players.js';
import { attachWebSocketServer } from './ws.js';
import { createMCPHandler } from './mcp.js';
import { strategyTemplate } from './strategy-dsl.js';
import { MAX_MODEL_CALLS_PER_MATCH } from './costs.js';
import { applySecurityHeaders, createLimiters, BODY_LIMIT, BodyTooLargeError } from './security.js';
import { json } from './http/shared.js';
import { createStaticServer } from './http/static.js';
import { createRequestHandler } from './http/index.js';
import { createWsConnectionHandler } from './http/ws-wiring.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = path.join(ROOT, 'web');
const WEB_DIST = path.join(WEB_DIR, 'dist');
const WEB_DIST_INDEX = path.join(WEB_DIST, 'index.html');
const PORT = Number(process.env.PORT || 8787);
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
// The version advertised over HTTP is declared here at the assembly boundary
// and consumed by /api/state; keep it in step with package.json and MCP.
const serverInfo = { name: 'Agent Fighting League', version: '0.14.1' };

const league = new League();
const players = auth ? await getPlayerStore() : null;
const handleAuth = auth ? toNodeHandler(auth) : null;
if (auth) {
  if (await needsSetup({ players })) console.log('[afl] no admin yet: open /setup to create the administrator (one-time).');
} else console.log('[afl] DATABASE_URL is not set: Better Auth is disabled; run pnpm db:up && pnpm db:migrate to enable accounts.');
const manager = new RoomManager(league);
const handleMCP = createMCPHandler(league, manager, players);
// The hosted (MCP-only) track stays watchable through the exhibition rotation:
// the official hosted baseline is registered and joined into the always-on demo
// rooms, NOT into the ranked queue. Ranked rooms belong to registered players,
// so the board can never fill up with the league playing itself.
league.ensureHostedDemo(strategyTemplate());

const ctx = {
  ROOT, WEB_DIR, WEB_DIST, WEB_DIST_INDEX, PORT, VERSION, serverInfo,
  league, players, auth, manager, handleAuth, handleMCP,
  MAX_MODEL_CALLS_PER_MATCH,
  limiters: createLimiters(),
};
ctx.serveStatic = createStaticServer(ctx).serveStatic;

const requestHandler = createRequestHandler(ctx);
const server = http.createServer((req, res) => {
  applySecurityHeaders(req, res);
  const url = new URL(req.url, 'http://localhost');
  requestHandler(req, res, url).catch((err) => {
    if (err instanceof BodyTooLargeError) {
      if (!res.headersSent) json(res, 413, { error: 'request body too large', limitBytes: BODY_LIMIT }, { Connection: 'close' });
      return;
    }
    console.error('[afl] request error:', err && err.message);
    if (!res.headersSent) json(res, 500, { error: 'internal server error' });
  });
});

attachWebSocketServer(server, { onConnection: createWsConnectionHandler(ctx) });

server.listen(PORT, () => {
  console.log('[afl] server listening on http://localhost:' + PORT);
  if (auth) console.log('[afl] Better Auth         POST /api/auth/*  (sign-out and session endpoints)');
  if (auth) console.log('[afl] captcha-guarded     GET  /api/captcha  POST /api/login  POST /api/register');
  if (auth) console.log('[afl] first-run setup     GET  /api/setup/status  POST /api/setup  (locked once an admin exists)');
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
