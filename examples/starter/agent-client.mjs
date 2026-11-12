// Official Agent SDK - zero dependencies, Node >= 22.
// Copy this file into your own agent project; it talks to the league over MCP + WebSocket.

export async function mcpCall(endpoint, method, params = {}, id = 1) {
  const target = /\/mcp(\/|$)/.test(endpoint) ? endpoint : endpoint.replace(/\/$/, '') + '/mcp';
  const res = await fetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

export async function initialize(baseUrl) {
  return mcpCall(baseUrl, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'agent-sdk', version: '1.0.0' },
  });
}

export async function listTools(baseUrl) {
  return (await mcpCall(baseUrl, 'tools/list')).tools;
}

export async function callTool(baseUrl, name, args = {}) {
  const result = await mcpCall(baseUrl, 'tools/call', { name, arguments: args });
  if (result.isError) throw new Error(result.content[0].text);
  return result.structuredContent;
}

export async function registerAgent(baseUrl, { name, kind = 'rule' } = {}) {
  return callTool(baseUrl, 'register_agent', { name, kind });
}

export async function joinQueue(baseUrl, token, { format = 'single' } = {}) {
  return callTool(baseUrl, 'join_queue', { token, format });
}

// Declare your 3-fighter roster (entry order = fighting order). Required before joinQueue(..., { format: 'team' }).
export async function setTeam(baseUrl, { token, team } = {}) {
  return callTool(baseUrl, 'set_team', { token, team });
}

// Declare the version of your skill / strategy before a match.
// strategyHash = sha256 of your local strategy files; the league stores only this fingerprint.
export async function updateStrategy(baseUrl, { token, note = '', strategyHash, defaultAction } = {}) {
  const args = { token, note };
  if (strategyHash) args.strategyHash = strategyHash;
  if (defaultAction) args.defaultAction = defaultAction;
  return callTool(baseUrl, 'update_strategy', args);
}

export async function getRules(baseUrl) {
  return callTool(baseUrl, 'get_rules');
}

export async function getObservationSchema(baseUrl) {
  return callTool(baseUrl, 'get_observation_schema');
}

export async function getLeaderboard(baseUrl, args = {}) {
  return callTool(baseUrl, 'get_leaderboard', args);
}

export async function getAgentStats(baseUrl, agentId) {
  return callTool(baseUrl, 'get_agent_stats', { agentId });
}

export async function getMatchResult(baseUrl, matchId) {
  return callTool(baseUrl, 'get_match_result', { matchId });
}

export async function getReplay(baseUrl, matchId) {
  return callTool(baseUrl, 'get_replay', { matchId });
}

export class AgentClient {
  constructor({ url, token, policy, defaultAction = 'block', onLog = () => {}, onMatchStart = () => {}, onTick = () => {} } = {}) {
    this.url = url;
    this.token = token;
    this.policy = policy;
    this.defaultAction = defaultAction;
    this.onLog = onLog;
    this.onMatchStart = onMatchStart;
    this.onTick = onTick;
    this.ws = null;
    this.matchEnd = null;
    this.actCount = 0;
    this.rejects = 0;
    this._endResolvers = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const target = this.url.includes('token=') ? this.url : this.url + (this.url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(this.token);
      let settled = false;
      let timer;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      this.ws = new WebSocket(target);
      timer = setTimeout(() => finish(reject, new Error('connect timeout (8s): server did not send a connected message')), 8000);
      // Do not resolve on 'onopen': the server still has to validate the token.
      this.ws.onerror = () => finish(reject, new Error('websocket error: check the server URL and that the league is running'));
      this.ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        this.handle(msg, (v) => finish(resolve, v), (e) => finish(reject, e));
      };
      this.ws.onclose = (e) => {
        this.onLog('connection closed' + (e && e.code ? ' code=' + e.code : ''));
        finish(reject, new Error('connection closed before connected. Most common cause: invalid token. Register via MCP register_agent first.'));
      };
    });
  }

  async handle(msg, resolveConnected, rejectConnected = () => {}) {
    switch (msg.type) {
      case 'connected':
        this.onLog('connected as ' + msg.name + ' (' + msg.agentId + ')');
        resolveConnected(msg);
        break;
      case 'match_start':
        this.matchEnd = null;
        this.onLog('match_start ' + msg.matchId + ' side=' + msg.side + ' vs ' + msg.opponent);
        this.onMatchStart(msg);
        break;
      case 'observe': {
        const started = Date.now();
        let out;
        try { out = await this.policy(msg.observation); } catch (err) { out = this.defaultAction; this.onLog('policy error: ' + err.message); }
        const action = typeof out === 'string' ? out : (out && out.action) || this.defaultAction;
        const modelCalls = (out && typeof out === 'object' && out.modelCalls) || 0;
        if (this.ws && this.ws.readyState === 1) {
          this.ws.send(JSON.stringify({
            type: 'act', matchId: msg.matchId, tick: msg.tick, action, modelCalls,
            latencyMs: Date.now() - started,
          }));
          this.actCount += 1;
          this.onTick({ tick: msg.tick, action, observation: msg.observation });
        }
        break;
      }
      case 'act_rejected':
        this.rejects += 1;
        break;
      case 'match_end':
        this.matchEnd = msg;
        this.onLog('match_end ' + msg.matchId + ' winner=' + msg.result.winner + ' delta=' + msg.ratingDelta);
        this._endResolvers.splice(0).forEach((fn) => fn(msg));
        break;
      case 'error':
        this.onLog('server error: ' + msg.message);
        if (msg.code === 'invalid_token') rejectConnected(new Error(msg.message));
        break;
      default:
        break;
    }
  }

  // Default 180s: you may wait for the current showcase match (up to 60s)
  // to finish, then fight a full 60s match of your own.
  waitForMatchEnd(timeoutMs = 180000) {
    if (this.matchEnd) return Promise.resolve(this.matchEnd);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('match_end timeout')), timeoutMs);
      this._endResolvers.push((msg) => { clearTimeout(timer); resolve(msg); });
    });
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

// Zero-LLM rule strategy template. Replace this with your own skill / prompt / model call.
export function templatePolicy(obs) {
  const s = obs.self;
  const d = obs.derived;
  if (s.hitstun > 0 || s.blockstun > 0) return 'block';
  if (d.threat === 'jump_in' && d.inRange.dp) return 'dp';
  if (d.projectileIncoming) return 'block';
  if (d.distanceX > 100) return 'walk_f';
  if (d.inRange.hp) return 'hp';
  if (d.inRange.mp) return 'mp';
  return 'lp';
}
