import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { attempt, withFinally, parseOr } from '../lib/no-throw.mjs';
import { League, isLadderCompetitor, isOfficialBaseline } from '../../src/league.js';
import { strategyTemplate } from '../../src/strategy-dsl.js';
import { CONFIG } from '../../src/rules.js';
import { MAX_MODEL_CALLS_PER_MATCH as MAX_MODEL_CALLS_FOR_TEST } from '../../src/costs.js';

import { runRegistrants } from './ladder-registrants.mjs';

export async function runLive(ctx) {
  const { check, record, delay, TEST_DB, ROOT } = ctx;
// ------------------------------------------------------- part B: served surfaces

const PORT = await freePort();
const BASE = 'http://127.0.0.1:' + PORT;
const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'afl-ladder-live-'));
const child = spawn(process.execPath, ['src/server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    AFL_TICK_MS: '8',
    AFL_DATA_DIR: dirB,
    DATABASE_URL: TEST_DB,
    BETTER_AUTH_URL: BASE,
    BETTER_AUTH_TRUSTED_ORIGINS: BASE + ',http://localhost:' + PORT,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const log = ctx.log;
child.stdout.on('data', (d) => { log.text += d; });
child.stderr.on('data', (d) => { log.text += d; });

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function get(pathname) {
  const res = await fetch(BASE + pathname);
  return { status: res.status, data: await res.json() };
}

await withFinally(async () => {
  let up = false;
  for (let i = 0; i < 120 && !up; i += 1) {
    const probe = await attempt(() => fetch(BASE + '/api/state').then((r) => r.ok));
    if (probe.ok) up = probe.value;
    if (!up) await delay(100);
  }
  check('L8 测试服务启动（独立数据目录，无账号库）', up, up ? BASE : log.text.slice(-300));
  if (!up) throw new Error('server did not start');

  await delay(4000);

  await record('L9 无人报名时不伪造排位房，官方基线只在演示房打表演局', async () => {
    const rooms = (await get('/api/rooms')).data.rooms;
    const ranked = rooms.filter((r) => r.mode === 'ranked');
    assert.equal(ranked.length, 0, 'no phantom ranked room while nobody is registered: ' + JSON.stringify(ranked));
    const showcase = rooms.filter((r) => r.mode === 'demo');
    assert.ok(showcase.length >= 1, 'the always-on showcase keeps the screen alive');
    return 'rooms=' + rooms.map((r) => r.roomId + ':' + r.mode + ':' + r.pairing).join(',');
  });

  await record('L10 榜单不含任何官方基线行，且公开统计口径', async () => {
    const board = (await get('/api/leaderboard')).data;
    assert.ok(Array.isArray(board.rows));
    assert.ok(board.rows.every((r) => r.source !== 'builtin' && r.id !== 'demo_hosted'), 'no official rows');
    assert.equal(board.scope, 'registered-players');
    assert.ok(board.officials.length >= 5, 'officials disclosed separately: ' + board.officials.map((o) => o.id).join(','));
    assert.ok(board.rows.length === 0, 'a fresh league has an empty real board');
    return 'rows=' + board.rows.length + ' officials=' + board.officials.length;
  });

  await record('L11 赛程只登记真实打完的对局，官方对局一律 ranked=false', async () => {
    const matches = (await get('/api/matches')).data.matches;
    assert.ok(matches.length > 0, 'the showcase really produced matches');
    assert.ok(matches.every((m) => m.ranked === false), 'no official game is presented as a counting result');
    assert.ok(matches.every((m) => m.a.official === true || m.a.competitor === true));
    const every = matches.every((m) => Boolean(m.matchId) && Number.isFinite(m.hpA) && Number.isFinite(m.hpB) && m.ticks > 0);
    assert.ok(every, 'each record carries real engine numbers');
    return 'matches=' + matches.length + ' latest=' + matches[matches.length - 1].matchId;
  });

  await record('L12 实时通道如实标注对局性质（demo 不冒充 MATCH LIVE）', async () => {
    const state = (await get('/api/state')).data;
    const match = state.match;
    assert.ok(match, 'live feed carries a real match');
    assert.ok(['demo', 'ranked', 'scrim'].includes(match.mode), 'mode published: ' + match.mode);
    assert.ok(match.pairing, 'pairing published: ' + match.pairing);
    assert.equal(match.ranked, false, 'the showcase channel is not a ladder channel');
    assert.ok(match.a && match.b, 'both sides are the agents that actually fought');
    assert.ok(match.a.source === 'builtin' || match.a.source === 'hosted' || match.a.source === 'external');
    assert.ok(match.totalTicks > 0 && match.tickMs > 0, 'clock comes from CONFIG, not from the UI');
    return 'channel=' + match.mode + '/' + match.pairing + ' tick=' + match.tick;
  });

  await record('L13 在线人数只报真实连接，不为凑画面造假', async () => {
    const lobby = (await get('/api/state')).data.lobby;
    assert.equal(lobby.onlineAgents, 0, 'no external agent is connected in this run');
    assert.equal(lobby.waiting, 0, 'queue is empty');
    assert.ok(Array.isArray(lobby.queue) && lobby.queue.length === 0);
    return 'online=' + lobby.onlineAgents + ' waiting=' + lobby.waiting;
  });

  if (TEST_DB) {
    Object.assign(ctx, { BASE, get });
    await runRegistrants(ctx);
  } else {
    console.log('\n  SKIP  L14-L16 两名真实玩家报名的完整排位闭环（需要 AFL_TEST_DATABASE_URL 指向独立测试库）');
  }
}, () => {
  child.kill();
});

}
