/**
 * MCP JSON-RPC handler: tool dispatch, resources, prompts and HTTP framing.
 * Static documentation lives in ./content.js.
 */
import { randomUUID } from 'node:crypto';
import { MCP_TOOLS } from '../protocol.js';
import { isValidFighter } from '../fighters.js';
import { parseJsonResult } from '../json-result.js';
import {
  SKILL_MD, QUICKSTART_MD, ADVANCED_MD, COSTS_MD, STAGES_MD,
  TRAINING_MD, ROOMS_MD, TROUBLE_MD, RESOURCES, PROMPTS,
} from './content.js';

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function fail(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * decodeURIComponent without throwing: malformed '%' escapes or invalid UTF-8
 * bytes return '' instead, exactly as the old catch did.
 */
function decodeComponent(value) {
  if (typeof value !== 'string') return '';
  const pieces = [];
  let literal = '';
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== '%') { literal += value[i]; continue; }
    const hex = value.slice(i + 1, i + 3);
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) return '';
    if (literal) { pieces.push(new TextEncoder().encode(literal)); literal = ''; }
    pieces.push(Uint8Array.of(parseInt(hex, 16)));
    i += 2;
  }
  if (literal) pieces.push(new TextEncoder().encode(literal));
  const size = pieces.reduce((sum, piece) => sum + piece.length, 0);
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const piece of pieces) { bytes.set(piece, at); at += piece.length; }
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  // A lenient decoder emits U+FFFD where decodeURIComponent would throw.
  if (!value.includes('\uFFFD') && decoded.includes('\uFFFD')) return '';
  return decoded;
}

export function createMCPHandler(league, manager = null, accounts = null) {
  /**
   * A player MCP service is one URL per player. The key can arrive as
   * /mcp/<key>, ?key=<key>, or an Authorization: Bearer header. A valid key
   * resolves the player and their single agent slot, which lets tools omit
   * the token without ever crossing player boundaries.
   */
  async function authFrom(req) {
    if (!accounts) return { error: 'auth is not configured: set DATABASE_URL, run pnpm db:migrate, then GET /api/me/mcp for your service URL' };
    const url = new URL(req.url, 'http://localhost');
    let key = url.searchParams.get('key') || '';
    if (!key && url.pathname.startsWith('/mcp/')) {
      key = decodeComponent(url.pathname.slice('/mcp/'.length));
    }
    const header = String(req.headers.authorization || '');
    if (!key && header.toLowerCase().startsWith('bearer ')) key = header.slice(7).trim();
    if (!key) return null;
    const player = await accounts.playerByMcpKey(key);
    if (!player) return { error: 'invalid MCP service key' };
    let agent = player.agentId ? league.agentById(player.agentId) : null;
    if (!agent) {
      const created = league.ensurePlayerAgent({
        playerId: player.id,
        name: player.displayName + ' 的 Agent',
      });
      await accounts.linkAgent(player.id, created.agentId);
      agent = league.agentById(created.agentId);
    }
    return { player, agent };
  }

  function agentFor(args, auth) {
    if (!auth || !auth.agent) {
      throw new Error('player MCP service required: log in, get your MCP URL, and connect through /mcp/<player key>');
    }
    if (args.token && args.token !== auth.agent.token) {
      throw new Error('token does not belong to this MCP service');
    }
    return auth.agent;
  }

  function agentSummary(agent) {
    if (!agent) return null;
    return {
      id: agent.id,
      name: agent.name,
      team: agent.team || null,
      teamName: agent.teamName || null,
      source: agent.source,
      versionHash: agent.versionHash,
      fighterId: agent.fighterId,
      rating: Math.round(agent.rating),
      wins: agent.wins,
      losses: agent.losses,
      draws: agent.draws,
      matches: agent.matches,
    };
  }

  const implementations = {
    register_agent: async (args, auth) => {
      if (!auth || !auth.player) {
        throw new Error('player MCP service required: log in, get your MCP URL, and connect through /mcp/<player key>');
      }
      const created = league.ensurePlayerAgent({
        playerId: auth.player.id,
        name: args.name || (auth.player.displayName + ' 的 Agent'),
        source: args.source === 'external' ? 'external' : 'hosted',
      });
      await accounts.linkAgent(auth.player.id, created.agentId);
      const agent = league.agentById(created.agentId);
      if (Array.isArray(args.team)) {
        league.setTeam({ token: agent.token, team: args.team, teamName: args.teamName });
      }
      return {
        agentId: agent.id,
        token: agent.token,
        versionHash: agent.versionHash,
        team: agent.team || null,
        teamName: agent.teamName || null,
        source: agent.source,
        playerId: auth.player.id,
        player: accounts.publicPlayer(auth.player),
        existing: created.existing,
        note: 'This MCP service is bound to one player slot. register_agent is idempotent; next call set_team(teamName, team), then submit_strategy and join_queue(format="team").',
      };
    },
    get_my_profile: (args, auth) => {
      if (!auth || !auth.player) {
        throw new Error('player MCP service required: log in, get your MCP URL, and connect through /mcp/<player key>');
      }
      return {
        player: accounts.publicPlayer(auth.player),
        agent: agentSummary(auth.agent),
        nextSteps: auth.agent && auth.agent.team
          ? 'Roster is set. Submit a strategy, then join_queue(format="team").'
          : 'Call set_team with a teamName and exactly 3 distinct fighter ids, then submit_strategy and join_queue(format="team").',
      };
    },
    set_team: (args, auth) => league.setTeam({ ...args, token: agentFor(args, auth).token }),
    update_strategy: (args, auth) => league.updateStrategy({ ...args, token: agentFor(args, auth).token }),
    submit_strategy: (args, auth) => league.submitStrategy({ ...args, token: agentFor(args, auth).token }),
    get_strategy_template: () => league.getStrategyTemplate(),
    validate_strategy: (args) => league.validateStrategyTool(args),
    simulate_strategy: (args) => league.simulateStrategyTool(args),
    get_cost_model: () => league.costModel(),
    get_stages: () => league.stageModel(),
    list_drills: () => league.listDrills(),
    start_training: (args, auth) => league.runTrainingFor({ agent: agentFor(args, auth), strategy: args.strategy || null, drills: args.drills, seeds: args.seeds, rounds: args.rounds, maxGames: args.maxGames }),
    compare_strategies: (args, auth) => league.compareTraining({ agent: agentFor(args, auth), strategyA: args.strategyA || null, strategyB: args.strategyB, drills: args.drills, seeds: args.seeds, rounds: args.rounds }),
    get_training_report: (args, auth) => league.getTrainingHistory(agentFor(args, auth).id, { limit: args.limit }),
    // MCP requires structuredContent to be an object; a bare array is rejected by strict clients.
    list_fighters: () => ({ fighters: league.listFighters(), count: league.listFighters().length }),
    get_my_matches: (args, auth) => league.getMyMatches({ ...args, token: agentFor(args, auth).token }),
    get_rules: () => league.getRules(),
    get_observation_schema: () => league.getObservationSchema(),
    join_queue: (args, auth) => {
      const agent = agentFor(args, auth);
      const mode = args.mode === 'scrim' ? 'scrim' : 'ranked';
      const format = args.format === 'team' ? 'team' : 'single';
      let out;
      if (mode === 'scrim' && args.roomCode) {
        const room = manager.joinScrim(agent, args.roomCode);
        out = { joined: true, roomId: room.id, code: room.code, mode, ranked: false };
      } else {
        out = manager.enqueue({ agent, conn: manager.agentConns.get(agent.id) || null, mode, code: args.roomCode || null, format });
      }
      return {
        ...out,
        mode,
        format: mode === 'ranked' ? format : undefined,
        realtimePath: mode === 'ranked' && agent.source !== 'hosted' ? '/ws/agent?token=' + agent.token : null,
        note: agent.source === 'hosted'
          ? 'Hosted strategy: the league runs your strategy server-side. No WebSocket needed.'
          : 'External agent: also connect to the realtime WebSocket to receive observe messages.',
      };
    },
    create_room: (args, auth) => {
      const agent = agentFor(args, auth);
      if (args.fighterId && isValidFighter(args.fighterId)) agent.fighterId = args.fighterId;
      const format = args.format === 'team' ? 'team' : 'single';
      const room = manager.createScrim(agent, { format, team: args.team || null });
      return {
        roomId: room.id, code: room.code, mode: 'scrim', format, ranked: false,
        status: 'waiting', watchUrl: '/?view=live&room=' + encodeURIComponent(room.id),
        team: room.teams ? room.teams.a : null,
        note: format === 'team'
          ? 'Team elimination. Share this code; the opponent calls join_room with their own 3-fighter team. Unranked.'
          : 'Share this code. The opponent calls join_room with their own token. Unranked.',
      };
    },
    join_room: (args, auth) => {
      const agent = agentFor(args, auth);
      const room = manager.joinScrim(agent, args.roomCode, { team: args.team || null });
      return { joined: true, roomId: room.id, code: room.code, mode: 'scrim', format: room.format, ranked: false, opponent: room.aAgent.name, watchUrl: '/?view=live&room=' + encodeURIComponent(room.id) };
    },
    set_team_order: (args, auth) => {
      const agent = agentFor(args, auth);
      const room = manager.rooms.get(manager.agentRoom.get(agent.id));
      if (!room || !room.current || room.current.a.id !== agent.id && room.current.b.id !== agent.id) {
        throw new Error('you are not in a live match');
      }
      const side = room.current.a.id === agent.id ? 'a' : 'b';
      const out = room.submitOrder(side, args.order);
      if (!out.ok) throw new Error(out.reason + (out.expected ? '; alive pool: ' + out.expected.join(',') : ''));
      return { ...out, side, roomId: room.id, round: room.current.team.round };
    },
    list_rooms: () => ({ rooms: manager.listRooms(), lobby: manager.state(), note: 'demo = built-in showcase, ranked = wins-first ladder (single or team format), scrim = private unranked room.' }),
    get_match_result: (args) => league.getMatchResult(args.matchId),
    get_leaderboard: (args) => league.getLeaderboard(args),
    get_replay: (args) => {
      const text = league.getReplay(args.matchId);
      if (text === null) throw new Error('replay not found: ' + args.matchId);
      const parsedEnvelope = parseJsonResult(text);
      const envelope = parsedEnvelope.ok ? parsedEnvelope.value : null;
      if (envelope && envelope.format === 'afl-team-replay/1') {
        return { matchId: args.matchId, format: 'afl-team-replay/1', json: text };
      }
      return { matchId: args.matchId, format: 'afl-replay/1', jsonl: text };
    },
    get_agent_stats: (args, auth) => {
      const agentId = args.agentId || (auth && auth.agent ? auth.agent.id : null);
      if (!agentId) throw new Error('agentId is required outside a player MCP service');
      return league.getAgentStats(agentId);
    },
  };

  function resourceText(uri) {
    switch (uri) {
      case 'afl://skill': return { text: SKILL_MD, mimeType: 'text/markdown' };
      case 'afl://strategy-dsl': return { text: league.describeStrategyDsl().markdown, mimeType: 'text/markdown' };
      case 'afl://strategy-template': return { text: JSON.stringify(league.getStrategyTemplate().template, null, 2), mimeType: 'application/json' };
      case 'afl://rules': return { text: JSON.stringify(league.getRules(), null, 2), mimeType: 'application/json' };
      case 'afl://observation-schema': return { text: JSON.stringify(league.getObservationSchema(), null, 2), mimeType: 'application/json' };
      case 'afl://fighters': return { text: JSON.stringify(league.listFighters(), null, 2), mimeType: 'application/json' };
      case 'afl://rooms': return { text: ROOMS_MD, mimeType: 'text/markdown' };
      case 'afl://stages': return { text: STAGES_MD, mimeType: 'text/markdown' };
      case 'afl://costs': return { text: COSTS_MD, mimeType: 'text/markdown' };
      case 'afl://training': return { text: TRAINING_MD, mimeType: 'text/markdown' };
      case 'afl://quickstart': return { text: QUICKSTART_MD, mimeType: 'text/markdown' };
      case 'afl://onboarding': return { text: ADVANCED_MD, mimeType: 'text/markdown' };
      case 'afl://troubleshooting': return { text: TROUBLE_MD, mimeType: 'text/markdown' };
      default: return null;
    }
  }

  async function dispatch(message, auth) {
    const { id, method, params = {} } = message;
    if (method === 'initialize') {
      return ok(id, {
        protocolVersion: params.protocolVersion || '2025-06-18',
        capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false }, prompts: { listChanged: false } },
        serverInfo: { name: 'agent-fighting-league', version: '0.14.1' },
        instructions: [
          'Humans may only spectate; agents do all the fighting.',
          auth && auth.player
            ? 'This MCP service is bound to player "' + auth.player.username + '" and exactly one agent slot. register_agent is idempotent; never create a second identity.'
            // There is no anonymous control plane to describe: without a player
            // key every tool call is refused, so the only honest instruction is
            // how to obtain one.
            : 'No player key on this endpoint, so no tool can act: the league has no anonymous control plane. Log in, call GET /api/me/mcp, and use the returned /mcp/<key> URL.',
          'The ranked game is KOF-style 3v3 team elimination: build your own roster first (set_team with teamName + 3 fighters), then register for matchmaking (join_queue format="team"). The leaderboard ranks by wins.',
          'MCP-only agent clients (Claude Code / CodeBuddy / Cursor / OpenCode / ...) should use the HOSTED track:',
          'get_my_profile -> register_agent (or skip on a bound service) -> set_team -> get_strategy_template -> start_training (free, zero model calls, never on the ladder) -> compare_strategies -> submit_strategy -> join_queue(format="team"). Read afl://costs to see what is free and what is the player\'s own model bill.',
          'The league interprets the declarative strategy server-side, so no long-lived WebSocket process is needed.',
          'Start by reading afl://quickstart for the short path, then afl://skill for the full workflow and afl://onboarding for the advanced manual. First match can take up to ~60s while the current demo room finishes - that is normal, not a stall. ranks are per-room: ranked (wins-first ladder), scrim (unranked by code), demo (showcase).',
          'afl://costs says what costs what: training and every read surface are free, only an external agent calling a model each tick creates a bill and that bill comes from the player\'s provider, not the league. afl://training explains the practice ground (own bot drills, zero LLM, never on the ladder).',
        ].join(' '),
      });
    }
    if (method === 'ping') return ok(id, {});
    if (method === 'tools/list') return ok(id, { tools: MCP_TOOLS });
    if (method === 'resources/list') return ok(id, { resources: RESOURCES });
    if (method === 'resources/templates/list') return ok(id, { resourceTemplates: [] });
    if (method === 'resources/read') {
      const found = resourceText(params.uri);
      if (!found) return fail(id, -32002, 'resource not found: ' + params.uri);
      return ok(id, { contents: [{ uri: params.uri, mimeType: found.mimeType, text: found.text }] });
    }
    if (method === 'prompts/list') {
      return ok(id, { prompts: PROMPTS.map(({ name, description }) => ({ name, description })) });
    }
    if (method === 'prompts/get') {
      const p = PROMPTS.find((x) => x.name === params.name);
      if (!p) return fail(id, -32602, 'prompt not found: ' + params.name);
      return ok(id, { description: p.description, messages: [{ role: 'user', content: { type: 'text', text: p.text } }] });
    }
    if (method === 'tools/call') {
      const name = params.name;
      const impl = implementations[name];
      if (!impl) return fail(id, -32601, 'unknown tool: ' + name);
      return Promise.resolve()
        .then(() => impl(params.arguments || {}, auth))
        .then((raw) => {
          // Contract guard: structuredContent must be a record (object), never an array or scalar.
          const data = Array.isArray(raw) ? { items: raw, count: raw.length }
            : (raw && typeof raw === 'object' ? raw : { value: raw });
          return ok(id, {
            content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
            structuredContent: data,
            isError: false,
          });
        })
        .catch((err) => ok(id, {
          content: [{ type: 'text', text: 'error: ' + err.message }],
          isError: true,
        }));
    }
    if (id === undefined) return null;
    return fail(id, -32601, 'method not found: ' + method);
  }

  return async function handleMCP(req, res, bodyText) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    const auth = await authFrom(req);
    if (auth && auth.error) {
      res.writeHead(401, headers);
      res.end(JSON.stringify(fail(null, -32001, auth.error)));
      return;
    }
    if (req.method === 'GET') {
      res.writeHead(405, { ...headers, Allow: 'POST, DELETE' });
      res.end(JSON.stringify({ error: 'use POST for MCP Streamable HTTP' }));
      return;
    }
    if (req.method === 'DELETE') {
      res.writeHead(204);
      res.end();
      return;
    }
    const parsed = parseJsonResult(bodyText || '{}');
    if (!parsed.ok) {
      res.writeHead(400, headers);
      res.end(JSON.stringify(fail(null, -32700, 'parse error')));
      return;
    }
    const message = parsed.value;
    const isInitialize = !Array.isArray(message) && message.method === 'initialize';
    if (isInitialize) headers['Mcp-Session-Id'] = randomUUID();
    const reply = Array.isArray(message)
      ? (await Promise.all(message.map((item) => dispatch(item, auth)))).filter(Boolean)
      : await dispatch(message, auth);
    if (reply === null || (Array.isArray(reply) && reply.length === 0)) {
      res.writeHead(202);
      res.end();
      return;
    }
    const accept = String(req.headers.accept || '');
    const wantsSSE = accept.includes('text/event-stream') && !accept.includes('application/json');
    if (wantsSSE) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', ...(isInitialize ? { 'Mcp-Session-Id': headers['Mcp-Session-Id'] } : {}) });
      res.write('data: ' + JSON.stringify(reply) + '\n\n');
      res.end();
      return;
    }
    res.writeHead(200, headers);
    res.end(JSON.stringify(reply));
  };
}
