/**
 * Public read-only routes: state snapshot, reference data, replay files, the
 * agent skill document and docs manifest. No session required.
 */
import fs from 'node:fs';
import path from 'node:path';
import { assetsState, getManifest } from '../assets.js';
import { CONFIG } from '../rules.js';
import { docsManifest } from '../docs-index.js';
import { json } from './shared.js';

export async function handlePublicRoutes(ctx, req, res, url, p) {
  const { league, manager, ROOT } = ctx;

  if (p === '/api/costs' && req.method === 'GET') {
    // The cost model plus what the platform is actually spending right now.
    json(res, 200, { ...league.costModel(), platformUsage: { replays: league.replayStore() } });
    return true;
  }

  if (p === '/api/stages' && req.method === 'GET') {
    // The stage registry plus how an arena is chosen. Published as data so the
    // client renders what the server declared instead of inventing a scene.
    json(res, 200, league.stageModel());
    return true;
  }

  // One URL an AI agent client can read to learn the entire game. Agents (curl /
  // MCP / fetch, Accept: */*) get the raw markdown; a human browser navigating
  // here (Accept: text/html) is sent to the in-app library reader rather than a
  // bare markdown page.
  if (p === '/SKILL.md' || p === '/skill.md') {
    const accept = String(req.headers.accept || '');
    if (accept.includes('text/html')) {
      res.writeHead(302, { Location: '/library?file=' + encodeURIComponent('skills/afl-league/SKILL.md'), 'Cache-Control': 'no-cache' });
      res.end();
      return true;
    }
    const file = path.join(ROOT, 'skills', 'afl-league', 'SKILL.md');
    if (!fs.existsSync(file)) { json(res, 404, { error: 'skill not found' }); return true; }
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
    res.end(fs.readFileSync(file, 'utf8'));
    return true;
  }

  if (p === '/api/state') {
    json(res, 200, {
      server: { name: ctx.serverInfo.name, season: league.season, tickMs: CONFIG.TICK_MS, framesPerTick: CONFIG.FRAMES_PER_TICK, matchTicks: CONFIG.MATCH_TICKS, version: ctx.serverInfo.version },
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
    return true;
  }

  if (p === '/api/assets') {
    const manifest = getManifest();
    if (!manifest) { json(res, 503, { error: 'asset manifest unavailable' }); return true; }
    json(res, 200, manifest);
    return true;
  }

  if (p === '/api/rooms') {
    json(res, 200, { rooms: manager.listRooms(), lobby: manager.state() });
    return true;
  }

  if (p === '/api/fighters') {
    json(res, 200, { fighters: league.listFighters(), teams: league.listTeams() });
    return true;
  }

  if (p === '/api/leaderboard') {
    json(res, 200, league.getLeaderboard({ track: url.searchParams.get('track') }));
    return true;
  }

  if (p === '/api/matches') {
    // The replay page asks for the player-only feed; the unfiltered endpoint
    // stays the default so verification scripts still see demo exhibitions.
    const playerOnly = url.searchParams.get('scope') === 'player';
    json(res, 200, { matches: playerOnly ? league.recentPlayerMatches(40) : league.recentMatches(40) });
    return true;
  }

  if (p === '/api/agents') {
    json(res, 200, { agents: league.listAgents() });
    return true;
  }

  if (p === '/api/rules') {
    json(res, 200, league.getRules());
    return true;
  }

  if (p === '/api/docs') {
    await Promise.resolve().then(() => docsManifest()).then(
      (manifest) => { json(res, 200, manifest); },
      () => { json(res, 503, { error: 'docs manifest unavailable' }); },
    );
    return true;
  }

  if (p.startsWith('/api/replay/')) {
    const matchId = decodeURIComponent(p.slice('/api/replay/'.length));
    if (url.searchParams.get('render') === '1') {
      const rendered = manager.getRenderedReplay(matchId);
      if (!rendered) { json(res, 404, { error: 'replay not found' }); return true; }
      json(res, 200, { matchId, match: league.getMatchResult(matchId), ticks: rendered });
      return true;
    }
    const text = league.getReplay(matchId);
    if (text === null) { json(res, 404, { error: 'replay not found' }); return true; }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(text);
    return true;
  }

  return false;
}
