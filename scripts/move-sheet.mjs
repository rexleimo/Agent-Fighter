/**
 * Generates docs/frame-data-sheet.svg from the REAL kernel geometry.
 * Each panel calls skeletonFor() / boxesFor() / framePhase() on an actual
 * fighter state at an active frame, so the sheet is a faithful dump of what
 * the browser draws and what the kernel resolves hits with.
 *
 *   node scripts/move-sheet.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInitialState } from '../src/engine.js';
import { MOVES, moveTotal } from '../src/rules.js';
import { skeletonFor, boxesFor, framePhase } from '../src/combat.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'frame-data-sheet.svg');

const PANELS = [
  { id: null, state: 'idle', name: '待机', note: '中立骨架，三段受击框' },
  { id: null, state: 'crouch', name: '蹲防', note: '头框降到 -121，上段拳打空' },
  { id: 'hp', state: 'attack', name: '重拳', note: 'handF 前伸，中上段单发框' },
  { id: 'hk', state: 'attack', name: '重脚', note: 'footF 高踢，高段破蹲防' },
  { id: 'dp', state: 'attack', name: '升龙', note: '纵向框覆盖 -176..0，可对空' },
  { id: 'super', state: 'attack', name: '超必杀', note: '三段独立 hitId，耗 100 气' },
];

function fighterFor(p) {
  const f = createInitialState(1, 'sheet').a;
  f.x = 0; f.y = 0; f.facing = 1;
  f.state = p.state;
  f.moveId = p.id;
  const m = p.id ? MOVES[p.id] : null;
  f.moveFrame = m ? m.startup + 1 : 0;
  f.hasHit = false;
  f.hitIds = [];
  return f;
}

const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

function panel(p, index) {
  const W = 320, H = 182;
  const col = index % 2, row = Math.floor(index / 2);
  const x = 12 + col * 332;
  const y = 54 + row * 190;
  const f = fighterFor(p);
  const sk = skeletonFor(f, 0);
  const bx = boxesFor(f, 0);
  const ph = framePhase(f);
  const k = 0.46;
  const ox = x + W * 0.42, oy = y + H - 34;
  const X = (v) => (ox + v * k).toFixed(1);
  const Y = (v) => (oy + v * k).toFixed(1);
  const parts = [];
  parts.push(`<rect x="${x}" y="${y}" width="${W}" height="${H}" rx="7" fill="#101b27" stroke="#22384c"/>`);
  parts.push(`<text x="${x + 12}" y="${y + 20}" fill="#e7eef6" font-size="12" font-weight="600" font-family="ui-monospace,monospace">${esc(p.name)} <tspan fill="#7f94a8" font-size="10">${p.id || p.state}</tspan></text>`);
  parts.push(`<line x1="${x + 8}" y1="${oy}" x2="${x + W - 8}" y2="${oy}" stroke="#31465a" stroke-width="1"/>`);

  const pb = bx.push;
  parts.push(`<rect x="${X(pb.x)}" y="${Y(pb.y)}" width="${(pb.w * k).toFixed(1)}" height="${(pb.h * k).toFixed(1)}" fill="none" stroke="#8ea3b8" stroke-width="1" stroke-dasharray="3 3" opacity=".7"/>`);
  for (const b of bx.hurt) {
    parts.push(`<rect x="${X(b.x)}" y="${Y(b.y)}" width="${(b.w * k).toFixed(1)}" height="${(b.h * k).toFixed(1)}" fill="rgba(56,217,192,.07)" stroke="#38d9c0" stroke-width="1.1"/>`);
  }
  for (const b of bx.hit) {
    parts.push(`<rect x="${X(b.x)}" y="${Y(b.y)}" width="${(b.w * k).toFixed(1)}" height="${(b.h * k).toFixed(1)}" fill="rgba(255,93,108,.20)" stroke="#ff5d6c" stroke-width="1.6"/>`);
  }
  for (const [x1, y1, x2, y2] of sk.bones) {
    parts.push(`<line x1="${X(x1)}" y1="${Y(y1)}" x2="${X(x2)}" y2="${Y(y2)}" stroke="#ffd166" stroke-width="1.3" opacity=".85"/>`);
  }
  for (const [name, v] of Object.entries(sk.joints)) {
    parts.push(`<circle cx="${X(v[0])}" cy="${Y(v[1])}" r="${name === 'head' ? 2.2 : 1.4}" fill="${name === 'handF' || name === 'footF' ? '#ff9f6b' : '#ffe1a2'}"/>`);
  }

  const total = Math.max(1, ph.total || 1);
  const barX = x + 150, barY = y + 34, barW = W - 162;
  const seg = (n) => ((n / total) * barW).toFixed(1);
  let cx = barX;
  for (const [n, col] of [[ph.startup, '#ffc15c'], [ph.active, '#ff5d6c'], [ph.recovery, '#8ca0b8']]) {
    parts.push(`<rect x="${cx.toFixed(1)}" y="${barY}" width="${seg(n)}" height="5" fill="${col}" opacity=".85"/>`);
    cx += Number(seg(n));
  }
  if (ph.phase !== 'none') {
    parts.push(`<rect x="${(barX + (ph.frame / total) * barW).toFixed(1)}" y="${barY - 2}" width="2" height="9" fill="#fff"/>`);
  }
  parts.push(`<text x="${barX}" y="${barY + 18}" fill="#8fa4b8" font-size="9" font-family="ui-monospace,monospace">${p.id ? `${ph.startup}/${ph.active}/${ph.recovery}F · ${bx.hit.length} HITBOX` : 'READY'}</text>`);
  parts.push(`<text x="${x + 12}" y="${y + H - 10}" fill="#6f869b" font-size="9" font-family="ui-monospace,monospace">${esc(p.note)}</text>`);
  return parts.join('\n');
}

const legend = [
  ['#38d9c0', 'HURT 受击框'], ['#ff5d6c', 'HIT 攻击框'],
  ['#8ea3b8', 'PUSH 碰撞框'], ['#ffd166', 'BONE 骨架'],
];
let lx = 14;
const legendSvg = legend.map(([col, text]) => {
  const out = `<rect x="${lx}" y="34" width="8" height="8" fill="${col}"/><text x="${lx + 12}" y="42" fill="#9fb3c6" font-size="10" font-family="ui-monospace,monospace">${text}</text>`;
  lx += 148;
  return out;
}).join('');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 632" width="680" height="632">
<rect width="680" height="632" fill="#0a121b"/>
<text x="14" y="24" fill="#e7eef6" font-size="15" font-weight="700" font-family="ui-monospace,monospace">骨架 / 判定框 / 帧数据 · 真实内核导出</text>
${legendSvg}
${PANELS.map(panel).join('\n')}
<text x="14" y="626" fill="#5f7488" font-size="9" font-family="ui-monospace,monospace">由 scripts/move-sheet.mjs 调用 skeletonFor / boxesFor / framePhase 生成 · 观战画面与命中判定使用同一份数据</text>
</svg>
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, svg);
const totalMoves = Object.keys(MOVES).length;
console.log('wrote ' + OUT + '  |  ' + PANELS.length + ' panels  |  ' + totalMoves + ' moves in rules  |  ' + moveTotal('super') + ' super frames');
