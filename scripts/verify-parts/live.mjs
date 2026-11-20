// Live half of the end-to-end verification: spawn a test server, check the
// version declarations, then drive the player-bound MCP control plane.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { attempt, withFinally } from '../lib/no-throw.mjs';
import { authEnv } from '../lib/harness-auth.mjs';
import { runVersionChecks } from './version-checks.mjs';
import { runControlChecks } from './live-control.mjs';
import { runMatchChecks } from './live-match.mjs';

export async function verifyEndToEnd(ctx) {
  const { ROOT, PORT, BASE, TEST_DB, check, delay } = ctx;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'afl-verify-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, ...authEnv(PORT, TEST_DB), AFL_TICK_MS: '8', AFL_DATA_DIR: tmp },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });

  await withFinally(async () => {
    const up = await ctx.waitForServer();
    check('C4 测试服务启动（锁步 8ms/拍 加速，独立数据目录）', up, up ? BASE : serverLog.slice(-300));
    if (!up) return;

    await runVersionChecks(ctx);

    if (!TEST_DB) {
      // No anonymous control plane by design, so the live half cannot run
      // without a player database. Say so as one SKIP line instead of either
      // crashing or reporting a green suite that fought nothing.
      check('C5-C22 实时控制面与对局链路', true,
        'SKIP: AFL_TEST_DATABASE_URL is not set - the league has no anonymous MCP service, so these checks need real player accounts (see README 验收)');
      return;
    }

    const control = await runControlChecks(ctx);
    Object.assign(ctx.session, control);
    await runMatchChecks(ctx);
  }, async () => {
    child.kill('SIGTERM');
    await delay(150);
    await attempt(() => fs.rmSync(tmp, { recursive: true, force: true })); // temp cleanup best effort
  });
}

/** Poll until the freshly spawned server answers /api/state. */
export async function waitForServer(base) {
  for (let i = 0; i < 60; i += 1) {
    const probe = await attempt(() => fetch(base + '/api/state').then((r) => r.ok));
    if (probe.ok && probe.value) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
