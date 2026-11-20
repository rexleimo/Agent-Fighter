import { CONFIG, ACTIONS } from '../../src/rules.js';
import { initialize, listTools, callTool, registerAgent, joinQueue, AgentClient, templatePolicy } from '../../sdk/agent-client.mjs';
import { attempt } from '../lib/no-throw.mjs';
import { onboardPlayer } from '../lib/harness-auth.mjs';


/** C5–C10: become a player, drive MCP + the external SDK agent, watch the match. */
export async function runControlChecks(ctx) {
  const { check, delay, BASE, WS, AUTH_BASE, TEST_DB, session, rpc, openSpectator } = ctx;
  
    // Become a player the way the docs tell an agent to: sign up, read your own
    // service URL, then talk to /mcp/<key>.
    const pilot = await onboardPlayer(AUTH_BASE, 'Verify Pilot');
    const MCP = pilot.endpoint;

    // MCP control plane
    const init = await initialize(MCP);
    const tools = await listTools(MCP);
    check('C5 标准 MCP 客户端连通 initialize + tools/list', Boolean(init.serverInfo) && tools.length >= 9, 'protocol=' + init.protocolVersion + ' tools=' + tools.length);
    const reg = await registerAgent(MCP, { name: 'Verify Bot' });
    await joinQueue(MCP, reg.token);
    const rules = await callTool(MCP, 'get_rules');
    const schema = await callTool(MCP, 'get_observation_schema');
    check('C6 MCP 控制面 register_agent / join_queue / get_rules / schema', Boolean(reg.token) && rules.actions.length === ACTIONS.length && Boolean(schema.properties.derived), 'agentId=' + reg.agentId);

    // External agent process via the official SDK
    const client = new AgentClient({
      url: WS + '/ws/agent',
      token: reg.token,
      policy: templatePolicy,
      defaultAction: 'block',
      onLog: () => {},
    });
    await client.connect();

    // Rooms are independent: subscribe to THIS agent's ranked room, not the
    // always-on demo room, otherwise spectator frames belong to another match.
    let roomId = null;
    for (let i = 0; i < 60; i += 1) {
      const lr = await callTool(MCP, 'list_rooms');
      const found = lr.rooms.find((r) => r.mode === 'ranked' && ((r.a && r.a.id === reg.agentId) || (r.b && r.b.id === reg.agentId)));
      if (found) { roomId = found.roomId; break; }
      await delay(100);
    }
    const spectatorTicks = [];
    const spectator = new WebSocket(WS + '/ws/spectate' + (roomId ? '?room=' + roomId : ''));
    await new Promise((resolve, reject) => {
      spectator.onopen = resolve;
      spectator.onerror = reject;
      setTimeout(() => reject(new Error('spectator connect timeout')), 5000);
    });
    spectator.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'tick' && (!roomId || m.roomId === roomId)) spectatorTicks.push(m);
    };

    const end = await client.waitForMatchEnd(45000);
    const matchId = end.matchId;
    client.close();
    spectator.close();

    return { reg, matchId, spectatorTicks, mcp: MCP };
}
