/**
 * Authenticated API routes: player session, training ground and admin console.
 * One adapter module handles the whole authenticated API surface; the three
 * internal groups stay separate functions because they fail independently.
 */
import { fromNodeHeaders } from 'better-auth/node';
import { normalizeUsername } from '../player-shared.js';
import {
  authUnavailable, ensurePlayerAgent, json, playerCost, playerView,
  readJson, requestOrigin, sessionPlayer,
} from './shared.js';

/**
 * Session-bound player routes: profile, agent, MCP key, match feed, strategy,
 * training summary and account deletion. Every one of these is authenticated
 * by the Better Auth session; nothing here is a public demo list.
 */

const NOT_LOGGED_IN = { error: 'not logged in' };
const AGENT_NOT_READY = { error: 'agent not ready' };

async function handleMeRoutes(ctx, req, res, url, p) {
  const { players, auth, league, manager } = ctx;

  if (p === '/api/me' && req.method === 'GET') {
    if (!players) { authUnavailable(res); return true; }
    let player = await sessionPlayer(ctx, req);
    if (!player) { json(res, 401, NOT_LOGGED_IN); return true; }
    player = await ensurePlayerAgent(ctx, player);
    json(res, 200, playerView(ctx, req, player));
    return true;
  }

  if (p === '/api/me/mcp' && req.method === 'POST') {
    if (!players) { authUnavailable(res); return true; }
    let player = await sessionPlayer(ctx, req);
    if (!player) { json(res, 401, NOT_LOGGED_IN); return true; }
    player = await ensurePlayerAgent(ctx, player);
    const issued = await players.issueMcp(player.id);
    json(res, 200, { mcp: { ...issued, url: requestOrigin(req, ctx.PORT) + issued.path } });
    return true;
  }

  if (p === '/api/me/agent' && req.method === 'GET') {
    if (!players) { authUnavailable(res); return true; }
    let player = await sessionPlayer(ctx, req);
    if (!player) { json(res, 401, NOT_LOGGED_IN); return true; }
    player = await ensurePlayerAgent(ctx, player);
    const agent = player.agentId ? league.agentById(player.agentId) : null;
    if (!agent) { json(res, 404, AGENT_NOT_READY); return true; }
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
        ratingHistory: (agent.history || []).slice(-24).map((h) => ({ matchId: h.matchId, result: h.result, rating: h.rating })),
      },
      queue,
      room,
      recentMatches: league.getMyMatches({ token: agent.token, limit: 8 }).matches,
      training: league.getTrainingHistory(agent.id, { limit: 8 }),
      cost: playerCost(ctx, agent.id),
    });
    return true;
  }

  /* Account deletion with league-side cleanup. Better Auth removes the user
     (the player profile cascades in Postgres); this also forgets the agent,
     its token, match record and replay files so no orphan data is published. */
  if (p === '/api/me/delete' && req.method === 'POST') {
    if (!auth || !players) { authUnavailable(res); return true; }
    const player = await sessionPlayer(ctx, req);
    if (!player) { json(res, 401, NOT_LOGGED_IN); return true; }
    const body = await readJson(req);
    const agentId = player.agentId || null;
    await auth.api.deleteUser({
      body: { password: String(body?.password || ''), callbackURL: '/' },
      headers: fromNodeHeaders(req.headers),
      returnHeaders: true,
    }).then(
      (deleted) => {
        const purged = agentId ? league.purgeAgentData(agentId) : { matches: 0 };
        const cookies = typeof deleted?.headers?.getSetCookie === 'function' ? deleted.headers.getSetCookie() : [];
        json(res, 200, { ok: true, purged }, cookies.length ? { 'Set-Cookie': cookies } : {});
      },
      (err) => { json(res, 400, { error: err?.message || 'account deletion failed' }); },
    );
    return true;
  }

  /* Player's own replay feed — session-bound, never a public demo list. The
     match rows are the real records written by recordMatch, filtered to this
     account's agent; the replay file is fetched on demand by matchId. */
  if (p === '/api/me/matches' && req.method === 'GET') {
    if (!players) { authUnavailable(res); return true; }
    const player = await sessionPlayer(ctx, req);
    if (!player) { json(res, 401, NOT_LOGGED_IN); return true; }
    const agent = player.agentId ? league.agentById(player.agentId) : null;
    if (!agent) { json(res, 200, { agentId: player.agentId || null, matches: [] }); return true; }
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
    json(res, 200, league.getMyMatches({ token: agent.token, limit }));
    return true;
  }

  /* Profile fields owned by Better Auth (not the game profile store). */
  if (p === '/api/me/profile' && req.method === 'GET') {
    if (!auth || !players) { json(res, 503, { error: 'auth is not configured' }); return true; }
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session?.user) { json(res, 401, NOT_LOGGED_IN); return true; }
    json(res, 200, { email: session.user.email, image: session.user.image || '' });
    return true;
  }

  /* View/edit the submitted hosted strategy from the user center. Validation
     uses the same DSL as submit_strategy; the session authenticates the owner. */
  if (p === '/api/me/strategy') {
    if (!players) { json(res, 503, { error: 'auth is not configured' }); return true; }
    const player = await sessionPlayer(ctx, req);
    if (!player) { json(res, 401, NOT_LOGGED_IN); return true; }
    const ready = await ensurePlayerAgent(ctx, player);
    const agent = ready.agentId ? league.agentById(ready.agentId) : null;
    if (!agent) { json(res, 404, AGENT_NOT_READY); return true; }
    if (req.method === 'GET') {
      json(res, 200, { strategy: agent.hostedStrategy || null, versionHash: agent.versionHash, ruleCount: agent.hostedStrategy?.rules?.length ?? 0 });
      return true;
    }
    if (req.method === 'PUT') {
      const body = await readJson(req);
      await Promise.resolve().then(() => league.submitStrategy({
        token: agent.token,
        strategy: body.strategy,
        autoRequeue: body.autoRequeue !== false,
      })).then(
        (result) => { json(res, 200, result); },
        (err) => { json(res, 400, { error: err?.message || 'invalid strategy' }); },
      );
      return true;
    }
  }

  return false;
}


/**
 * Training ground routes. This is the player's own sandbox: it runs league bot
 * algorithms on the deterministic kernel, calls no model, and never reaches
 * recordMatch — the ladder, the schedule and the replay store stay untouched.
 */

async function handleTrainingRoutes(ctx, req, res, url, p) {
  const { league, players } = ctx;

  if (p === '/api/training/drills' && req.method === 'GET') {
    json(res, 200, league.listDrills());
    return true;
  }

  if (p.startsWith('/api/training/') && req.method === 'POST') {
    if (!players) { authUnavailable(res); return true; }
    let player = await sessionPlayer(ctx, req);
    if (!player) { json(res, 401, { error: 'not logged in' }); return true; }
    player = await ensurePlayerAgent(ctx, player);
    const agent = player.agentId ? league.agentById(player.agentId) : null;
    if (!agent) { json(res, 404, { error: 'agent not ready' }); return true; }
    const body = await readJson(req);
    await Promise.resolve().then(() => {
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
    }).then(undefined, (err) => {
      json(res, 400, { error: String(err && err.message || err) });
    });
    return true;
  }

  if (p === '/api/training/history' && req.method === 'GET') {
    if (!players) { json(res, 503, { error: 'auth is not configured' }); return true; }
    let player = await sessionPlayer(ctx, req);
    if (!player) { json(res, 401, { error: 'not logged in' }); return true; }
    player = await ensurePlayerAgent(ctx, player);
    const agent = player.agentId ? league.agentById(player.agentId) : null;
    if (!agent) { json(res, 404, { error: 'agent not ready' }); return true; }
    json(res, 200, league.getTrainingHistory(agent.id, { limit: url.searchParams.get('limit') }));
    return true;
  }

  return false;
}


/**
 * Admin console routes. Every handler verifies the session AND the admin role
 * before reading or mutating the player table.
 */

async function requireAdmin(ctx, req, res) {
  if (!ctx.players) { json(res, 503, { error: 'auth is not configured' }); return null; }
  const current = await sessionPlayer(ctx, req);
  if (!current) { json(res, 401, { error: 'not logged in' }); return null; }
  if (current.role !== 'admin') { json(res, 403, { error: 'admin only' }); return null; }
  return current;
}

async function handleAdminRoutes(ctx, req, res, url, p) {
  const { players, auth, league } = ctx;

  if (p === '/api/admin/players' && req.method === 'GET') {
    const current = await requireAdmin(ctx, req, res);
    if (!current) return true;
    const rows = (await players.listPlayers({ includeMcpKey: true })).map((row) => {
      const agent = row.agentId ? league.agentById(row.agentId) : null;
      return {
        ...row,
        mcp: row.mcp.assigned
          ? { ...row.mcp, url: requestOrigin(req, ctx.PORT) + row.mcp.path }
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
    return true;
  }

  if (p === '/api/admin/players' && req.method === 'POST') {
    const current = await requireAdmin(ctx, req, res);
    if (!current) return true;
    const args = await readJson(req);
    await Promise.resolve().then(async () => {
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
      profile = await ensurePlayerAgent(ctx, profile);
      json(res, 200, { player: players.publicPlayer(profile, { includeMcpKey: true }) });
    }).then(undefined, (err) => {
      json(res, 400, { error: err.message });
    });
    return true;
  }

  if (p.startsWith('/api/admin/players/') && p.endsWith('/mcp') && req.method === 'POST') {
    const current = await requireAdmin(ctx, req, res);
    if (!current) return true;
    const playerId = decodeURIComponent(p.slice('/api/admin/players/'.length, -'/mcp'.length));
    let player = await players.playerById(playerId);
    if (!player) { json(res, 404, { error: 'player not found' }); return true; }
    player = await ensurePlayerAgent(ctx, player);
    const issued = await players.issueMcp(player.id);
    const refreshed = await players.playerById(player.id);
    json(res, 200, {
      player: players.publicPlayer(refreshed, { includeMcpKey: true }),
      mcp: { ...issued, url: requestOrigin(req, ctx.PORT) + issued.path },
    });
    return true;
  }

  return false;
}


/** Returns true when this module produced a response. */
export async function handleApiRoutes(ctx, req, res, url, p) {
  if (await handleMeRoutes(ctx, req, res, url, p)) return true;
  if (await handleTrainingRoutes(ctx, req, res, url, p)) return true;
  if (await handleAdminRoutes(ctx, req, res, url, p)) return true;
  return false;
}
