/**
 * Request dispatch. The order here is the routing contract: more specific or
 * guarded endpoints run first and the static server is the final fallback.
 * Each group returns true when it produced a response.
 */
import { clientIp } from '../security.js';
import { json } from './shared.js';
import { handleCredentialRoutes, handleSetupRoutes } from './auth-routes.js';
import { handleMcpRoutes } from './mcp-routes.js';
import { handleMeRoutes } from './me-routes.js';
import { handleTrainingRoutes } from './training-routes.js';
import { handleAdminRoutes } from './admin-routes.js';
import { handlePublicRoutes } from './public-routes.js';

const GROUPS = [
  handleMeRoutes,
  handleTrainingRoutes,
  handleAdminRoutes,
  handlePublicRoutes,
];

export function createRequestHandler(ctx) {
  return async function requestHandler(req, res, url) {
    const p = url.pathname;

    // Liveness probe: unauthenticated, exempt from rate limiting.
    if (p === '/healthz' || p === '/api/health') {
      json(res, 200, { status: 'ok', version: ctx.VERSION, uptimeSec: Math.round(process.uptime()), accounts: Boolean(ctx.players) });
      return;
    }

    // Per-IP rate limit: stricter on auth + first-run setup (brute force /
    // land-grab), generous elsewhere.
    const guardedAuth = p.startsWith('/api/auth/') || p === '/api/setup'
      || p === '/api/login' || p === '/api/register' || p === '/api/captcha';
    const limiter = guardedAuth ? ctx.limiters.auth : ctx.limiters.global;
    const rl = limiter.check(clientIp(req));
    if (!rl.allowed) {
      json(res, 429, { error: 'rate limit exceeded', retryAfterSec: rl.retryAfter }, { 'Retry-After': String(rl.retryAfter) });
      return;
    }

    // Credential routes first, then MCP, then the CORS preflight, then setup
    // (which must stay ahead of the generic /api/me and static fallbacks).
    if (await handleCredentialRoutes(ctx, req, res, url, p)) return;
    if (await handleMcpRoutes(ctx, req, res, url, p)) return;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
      res.end();
      return;
    }

    if (await handleSetupRoutes(ctx, req, res, url, p)) return;
    for (const group of GROUPS) {
      if (await group(ctx, req, res, url, p)) return;
    }
    ctx.serveStatic(req, res, p);
  };
}
