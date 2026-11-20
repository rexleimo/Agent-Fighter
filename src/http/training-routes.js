/**
 * Training ground routes. This is the player's own sandbox: it runs league bot
 * algorithms on the deterministic kernel, calls no model, and never reaches
 * recordMatch — the ladder, the schedule and the replay store stay untouched.
 */
import { authUnavailable, ensurePlayerAgent, json, readJson, sessionPlayer } from './shared.js';

export async function handleTrainingRoutes(ctx, req, res, url, p) {
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
