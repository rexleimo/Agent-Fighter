// Team verification — extracted from scripts/verify-team.mjs by responsibility.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CONFIG } from '../../src/config.js';
import { createMatch } from '../../src/engine.js';
import { BUILTIN_AGENTS } from '../../src/agents.js';
import { templatePolicy } from '../../sdk/agent-client.mjs';
import { authEnv, mcpTool, mcpInitialize, onboardPlayer } from '../lib/harness-auth.mjs';
import {
  TEAM_SIZE, TEAM_HEAL, TEAM_MAX_ROUNDS,
  normalizeTeam, createTeamState, teamRoundStart, applyRoundResult,
  isValidOrder, applyOrder, teamView, teamResult,
  createTeamReplay, appendTeamRound, replayTeamMatch, renderTeamReplay,
  flattenTeamReplay, parseTeamReplay,
} from '../../src/team.js';
import { attempt, bestEffort, withFinally } from '../lib/no-throw.mjs';

export function makeLiveHelpers(ctx) {
  const { SERVICES, AUTH_BASE, WS, BASE, delay } = ctx;

  async function call(name, args = {}) {
    const endpoint = (args.token && SERVICES.get(args.token)) || ctx.readEp;
    if (!endpoint) throw new Error('no player service resolved for ' + name + ': onboard a player first');
    return mcpTool(endpoint, name, args);
  }

  /** A real player with a real agent slot - the only identity the league accepts. */
  async function playerAgent(label, { team, source } = {}) {
    const player = await onboardPlayer(AUTH_BASE, label);
    const reg = await mcpTool(player.endpoint, 'register_agent', {
      name: label, ...(team ? { team } : {}), ...(source ? { source } : {}),
    });
    // The bound service knows its own agent, but the pilots still connect with
    // the agent token, and call() routes by token, so keep the pair registered.
    SERVICES.set(reg.token, player.endpoint);
    return { ...player, ...reg, endpoint: player.endpoint };
  }

  function connectPilot(token, { policy, onIntermission = () => {} }) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS + '/ws/agent?token=' + token);
      const pilot = { ws, messages: [], acts: 0, intermissions: 0, orderReplies: [] };
      const timer = setTimeout(() => reject(new Error('pilot connect timeout')), 8000);
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        pilot.messages.push(m);
        if (m.type === 'connected') { clearTimeout(timer); resolve(pilot); return; }
        if (m.type === 'observe') {
          const out = policy(m.observation);
          const action = typeof out === 'string' ? out : (out && out.action) || 'block';
          ws.send(JSON.stringify({ type: 'act', matchId: m.matchId, tick: m.tick, action }));
          pilot.acts += 1;
        } else if (m.type === 'intermission') {
          pilot.intermissions += 1;
          onIntermission(pilot, m);
        } else if (m.type === 'order_locked' || m.type === 'order_rejected') {
          pilot.orderReplies.push(m);
        }
      };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('pilot websocket error')); };
    });
  }

  function connectSpectator(roomId, onMessage = () => {}) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS + '/ws/spectate?room=' + roomId);
      const messages = [];
      const timer = setTimeout(() => reject(new Error('spectator connect timeout')), 8000);
      ws.onopen = () => { clearTimeout(timer); resolve({ ws, messages }); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('spectator websocket error')); };
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        messages.push(m);
        onMessage(m);
      };
    });
  }

  async function waitForServer() {
    for (let i = 0; i < 60; i += 1) {
      const probe = await attempt(() => fetch(BASE + '/api/state').then((r) => r.ok));
      if (probe.ok && probe.value) return true;
      await delay(100);
    }
    return false;
  }

  return { call, playerAgent, connectPilot, connectSpectator, waitForServer };
}
