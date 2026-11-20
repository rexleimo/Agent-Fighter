/**
 * Session-bound player routes: profile, agent, MCP key, match feed, strategy,
 * training summary and account deletion. Every one of these is authenticated
 * by the Better Auth session; nothing here is a public demo list.
 */
import { fromNodeHeaders } from 'better-auth/node';
import { authUnavailable, ensurePlayerAgent, json, playerCost, playerView, readJson, requestOrigin, sessionPlayer } from './shared.js';

const NOT_LOGGED_IN = { error: 'not logged in' };
const AGENT_NOT_READY = { error: 'agent not ready' };

export async function handleMeRoutes(ctx, req, res, url, p) {
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
