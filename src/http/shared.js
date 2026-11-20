/**
 * Shared HTTP helpers used by the route groups in this directory.
 * All state lives in the `ctx` object assembled by server.js; helpers stay pure
 * with respect to module globals so the request handler is easy to reason about.
 */
import { fromNodeHeaders } from 'better-auth/node';
import { readBodyCapped, BODY_LIMIT, isSecure } from '../security.js';
import { parseJsonResult } from '../json-result.js';

export function json(res, status, data, extra = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(JSON.stringify(data));
}

export function readBody(req) {
  return readBodyCapped(req, BODY_LIMIT);
}

/** Malformed JSON is an empty object; an oversized body still rejects to the caller. */
export async function readJson(req) {
  const raw = await readBody(req);
  const parsed = parseJsonResult(raw || '{}');
  return parsed.ok ? parsed.value : {};
}

export const isSecureRequest = isSecure;

export function requestOrigin(req, port) {
  const proto = isSecureRequest(req) ? 'https' : 'http';
  return proto + '://' + (req.headers.host || ('localhost:' + port));
}

export async function sessionPlayer(ctx, req) {
  if (!ctx.auth || !ctx.players) return null;
  const session = await ctx.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session?.user) return null;
  return ctx.players.playerByUserId(session.user.id);
}

export async function ensurePlayerAgent(ctx, player) {
  if (player.agentId) return player;
  const created = ctx.league.ensurePlayerAgent({
    playerId: player.id,
    name: (player.displayName || player.username) + ' 的 Agent',
  });
  return ctx.players.linkAgent(player.id, created.agentId);
}

export function playerView(ctx, req, player) {
  const agent = player.agentId ? ctx.league.agentById(player.agentId) : null;
  const publicPlayer = ctx.players.publicPlayer(player, { includeMcpKey: true });
  const mcp = player.mcpKey
    ? {
      assigned: true,
      issuedAt: player.mcpIssuedAt,
      key: player.mcpKey,
      path: '/mcp/' + player.mcpKey,
      url: requestOrigin(req, ctx.PORT) + '/mcp/' + player.mcpKey,
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

/** What this agent actually consumed, from server-observed counters only. */
export function playerCost(ctx, agentId) {
  const st = ctx.league.getAgentStats(agentId);
  if (!st) return null;
  return {
    declaredModelCalls: st.modelCalls,
    timeouts: st.timeouts,
    budgetExceeded: st.budgetExceeded,
    hostedTicksEvaluated: st.hostedTicksEvaluated,
    trainingRuns: st.trainingRuns,
    budgetLimit: ctx.MAX_MODEL_CALLS_PER_MATCH,
    hosted: st.hosted,
  };
}

/** Uniform 503 used when accounts have not been configured. */
export function authUnavailable(res) {
  json(res, 503, { error: 'auth is not configured: set DATABASE_URL and run pnpm db:migrate' });
}
