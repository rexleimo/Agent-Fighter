/**
 * Admin console routes. Every handler verifies the session AND the admin role
 * before reading or mutating the player table.
 */
import { normalizeUsername } from '../player-shared.js';
import { ensurePlayerAgent, json, readJson, requestOrigin, sessionPlayer } from './shared.js';

async function requireAdmin(ctx, req, res) {
  if (!ctx.players) { json(res, 503, { error: 'auth is not configured' }); return null; }
  const current = await sessionPlayer(ctx, req);
  if (!current) { json(res, 401, { error: 'not logged in' }); return null; }
  if (current.role !== 'admin') { json(res, 403, { error: 'admin only' }); return null; }
  return current;
}

export async function handleAdminRoutes(ctx, req, res, url, p) {
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
