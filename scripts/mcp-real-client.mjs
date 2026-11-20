#!/usr/bin/env node
/**
 * 独立 MCP 客户端实测（不是自写 fetch 封装，也不是直接调内部函数）。
 *
 * 使用官方 @modelcontextprotocol/sdk 的 Client + StreamableHTTPClientTransport
 * 连接本站 /mcp，完成 initialize / notifications/initialized 握手，然后：
 *   listTools / listResources / listPrompts / readResource / getPrompt
 *   -> register_agent -> get_rules -> get_strategy_template -> validate_strategy
 *   -> simulate_strategy -> submit_strategy -> join_queue -> 打完一整局
 *   -> get_my_matches -> get_match_result -> get_replay -> get_leaderboard
 *
 * 同时用 WebSocket 观战抓服务端实拍帧，与回放离线重算帧逐拍比对，
 * 并用 replayMatch 验证状态哈希链，证明观战页数字不是随机数。
 *
 * 复现：
 *   npm install --prefix /tmp/afl-mcp-probe @modelcontextprotocol/sdk
 *   AFL_MCP_SDK_ROOT=/tmp/afl-mcp-probe/node_modules \
 *     AFL_MCP_URL=http://127.0.0.1:8787/mcp/<player key> node scripts/mcp-real-client.mjs
 *
 * 用 AFL_MCP_URL 而不是 AFL_BASE：控制面绑定玩家，真实服务地址是 /mcp/<key>。
 * 只给 AFL_BASE 时探测的是匿名沙箱（仅未配置账号库时存在），报告会写清探测的是哪一个。
 *
 * Windows 下把 /tmp 换成任意目录，AFL_MCP_SDK_ROOT 指向其 node_modules。
 * 输出：docs/mcp-client-probe.json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { replayMatch, renderReplay } from '../src/engine.js';
import { parseReplay } from '../src/replay.js';
import { attempt, withFinally } from './lib/no-throw.mjs';
import { createReporter } from './verify-parts/mcp-client-core.mjs';
import { runProbe } from './verify-parts/mcp-probe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.AFL_BASE || 'http://127.0.0.1:8787').replace(/\/+$/, '');
// Prefer the player service URL; fall back to the sandbox path and label it.
const MCP_URL = (process.env.AFL_MCP_URL || '').replace(/\/+$/, '') || BASE + '/mcp';
const PROBE_MODE = /\/mcp(\/|$)/.test(MCP_URL) && MCP_URL !== BASE + '/mcp' ? 'player-service' : 'anonymous-sandbox';
const WS_BASE = BASE.replace(/^http/, 'ws');
const REPORT_PATH = path.join(ROOT, 'docs', 'mcp-client-probe.json');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const { report, state, check } = createReporter(
  BASE,
  'official @modelcontextprotocol/sdk Client + StreamableHTTPClientTransport',
);

function sdkRoot() {
  const candidates = [
    process.env.AFL_MCP_SDK_ROOT,
    path.join(ROOT, 'node_modules'),
    path.join(os.tmpdir(), 'afl-mcp-probe', 'node_modules'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', 'streamableHttp.js'))) return dir;
  }
  return null;
}

const root = sdkRoot();
if (!root) {
  console.error('找不到官方 MCP SDK。先执行：');
  console.error('  npm install --prefix /tmp/afl-mcp-probe @modelcontextprotocol/sdk');
  console.error('然后设置 AFL_MCP_SDK_ROOT=/tmp/afl-mcp-probe/node_modules');
  process.exit(2);
}
report.sdkRoot = root;
const versionResult = await attempt(() => JSON.parse(
  fs.readFileSync(path.join(root, '@modelcontextprotocol', 'sdk', 'package.json'), 'utf8'),
).version);
const sdkVersion = versionResult.ok ? versionResult.value : 'unknown';
report.sdkVersion = sdkVersion;

const esm = (p) => pathToFileURL(path.join(root, '@modelcontextprotocol', 'sdk', 'dist', 'esm', p)).href;
const { Client } = await import(esm('client/index.js'));
const { StreamableHTTPClientTransport } = await import(esm('client/streamableHttp.js'));

const client = new Client({ name: 'afl-independent-probe', version: '1.0.0' }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));

const ctx = {
  report, state, check, client, transport, sdkVersion,
  BASE, MCP_URL, PROBE_MODE, WS_BASE, delay,
  replayMatch, renderReplay, parseReplay, fs, path,
};

await withFinally(async () => {
  const outcome = await attempt(() => runProbe(ctx));
  if (!outcome.ok) {
    check('M0 真实 MCP 客户端全程无异常', false, String(outcome.error?.stack || outcome.error).slice(0, 500));
    await attempt(() => client.close()); // noop on failure
  }
}, async () => {
  report.summary = {
    total: report.checks.length,
    passed: report.checks.length - state.failed,
    failed: state.failed,
    connected: state.connected,
  };
  // This report is committed as evidence, so it must never carry a live
  // credential: an MCP key is a full control plane for one player's agent, and
  // an agent token authorises realtime control. Scrub on write, not on trust.
  const SECRET = /((?:mcp_|ag_|usr_)[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g;
  const redacted = JSON.parse(JSON.stringify(report).replace(SECRET, '$1…'));
  redacted.redaction = 'MCP keys and agent tokens are truncated to their first 6 payload characters.';
  fs.writeFileSync(REPORT_PATH, JSON.stringify(redacted, null, 2), 'utf8');
  console.log('\n' + (state.failed ? 'FAILED ' : 'PASSED ') + (report.checks.length - state.failed) + '/' + report.checks.length
    + '  |  报告: docs/mcp-client-probe.json');
  process.exit(state.failed ? 1 : 0);
});
