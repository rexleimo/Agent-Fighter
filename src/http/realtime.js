/**
 * MCP entry points. Anonymous /mcp is a local dev sandbox only while no player
 * store is configured; once accounts exist every client must use a per-player
 * key. The refusal is shaped as JSON-RPC 2.0 so standard clients surface the
 * actual message instead of an empty one.
 */
import { json, readBody } from './shared.js';

export async function handleMcpRoutes(ctx, req, res, url, p) {
  if (p === '/mcp' && ctx.players) {
    json(res, 401, {
      jsonrpc: '2.0', id: null,
      error: { code: -32001, message: 'player MCP service required: log in, get your MCP URL, and use /mcp/<player key>' },
    });
    return true;
  }

  if (p === '/mcp' || p.startsWith('/mcp/')) {
    const body = await readBody(req);
    ctx.handleMCP(req, res, body).catch((err) => {
      console.error('[afl] MCP handler failed:', err);
      if (!res.headersSent) json(res, 500, { error: 'MCP handler failed' });
      else res.end();
    });
    return true;
  }

  return false;
}

/** WebSocket connection routing: spectator sockets and authenticated agent sockets. */
export function createWsConnectionHandler(ctx) {
  return (conn, url) => {
    if (url.pathname === '/ws/spectate') {
      ctx.manager.spectate(conn, url.searchParams.get('room'));
      return;
    }
    if (url.pathname === '/ws/agent') {
      const token = url.searchParams.get('token');
      const agent = ctx.league.agentByToken(token);
      if (!agent) {
        conn.send({ type: 'error', code: 'invalid_token', message: 'Invalid token. Connect through a player MCP service.' });
        conn.close();
        return;
      }
      if (!agent.playerId) {
        conn.send({ type: 'error', code: 'player_login_required', message: 'Player login required: anonymous agents cannot enter matches.' });
        conn.close();
        return;
      }
      conn.meta.token = token;
      conn.meta.agentId = agent.id;
      ctx.manager.joinAgent(conn, agent, {
        mode: url.searchParams.get('mode') || 'ranked',
        code: url.searchParams.get('room'),
        format: url.searchParams.get('format') === 'team' ? 'team' : 'single',
      });
      return;
    }
    conn.close();
  };
}
