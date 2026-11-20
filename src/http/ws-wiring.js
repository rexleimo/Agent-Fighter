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
