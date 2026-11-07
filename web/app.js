import { loadRig, drawRig } from './rig.js';

const $ = (id) => document.getElementById(id);
const GROUND = 330;
const COLOR_A = '#35d6a4';
const COLOR_B = '#5b8cff';
const stageCanvas = $('stage');
const ctx = stageCanvas.getContext('2d');
const replayCanvas = $('replayCanvas');
const rctx = replayCanvas.getContext('2d');

const S = {
  match: null,
  board: null,
  recent: [],
  agents: [],
  moves: {},
  actions: [],
  frameQueue: [],
  current: null,
  showBoxes: true,
  showBones: true,
  showFx: true,
  showRuler: true,
  showGrid: true,
  rules: null,
  fx: [],
  fxSeen: 0,
  tickMs: 100,
  ws: null,
  roomId: null,
  rooms: [],
  presence: null,
  fighters: [],
  configs: null,
  replay: { matchId: null, ticks: [], index: 0, timer: null },
  tools: ['register_agent', 'update_strategy', 'submit_strategy', 'get_strategy_template', 'validate_strategy', 'simulate_strategy', 'get_rules', 'get_observation_schema', 'join_queue', 'create_room', 'join_room', 'list_rooms', 'list_fighters', 'get_my_matches', 'get_match_result', 'get_leaderboard', 'get_replay', 'get_agent_stats'],
};

const ACTION_LABEL = {
  idle: '待机', walk_f: '前走', walk_b: '后撤', jump: '跳跃', crouch: '蹲防', block: '站防', throw: '投技',
  lp: '轻拳', mp: '中拳', hp: '重拳', lk: '轻脚', mk: '中脚', hk: '重脚', dp: '升龙', fireball: '波动',
  dash: '前冲', special: '专属技', ex: 'EX 强化', super: '超必杀',
};
const EVENT_LABEL = {
  hit: '命中', block: '防御', spawn: '发出波动', ko: 'KO', time_up: '时间到',
  cancel: '取消连段', super_start: '超必杀发动', armor: '霸体吸收', wakeup: '起身',
  move_start: '出招', hitstop: '命中停顿',
};
const PHASE_LABEL = { startup: '起手', active: '判定', recovery: '收招', none: '可行动' };
const label = (a) => ACTION_LABEL[a] || (S.moves[a] && S.moves[a].label) || a;
const short = (v, n = 8) => String(v || '').slice(0, n);
const pct = (v, max) => Math.max(0, Math.min(100, (v / max) * 100)) + '%';

/* ---------------------------------------------------------------- networking */
async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw new Error(path + ' -> ' + res.status);
  return res.json();
}

function setConn(on) {
  $('connDot').className = on ? 'on' : 'off';
  $('connText').textContent = on ? '实时连接' : '已断开，重连中';
}

function connect(roomId = S.roomId) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const q = roomId ? '?room=' + encodeURIComponent(roomId) : '';
  const ws = new WebSocket(proto + '://' + location.host + '/ws/spectate' + q);
  S.ws = ws;
  ws.onopen = () => setConn(true);
  ws.onclose = () => { setConn(false); setTimeout(() => connect(S.roomId), 2000); };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleMessage(msg);
  };
}

function switchRoom(roomId) {
  S.roomId = roomId || null;
  S.frameQueue.length = 0;
  if (S.ws) { S.ws.onclose = null; S.ws.close(); }
  connect(S.roomId);
}

function handleMessage(msg) {
  // A spectator is subscribed to exactly one room. Ignore any late frame
  // from a previously watched room while the socket is being switched.
  if (msg.roomId && S.roomId && msg.roomId !== S.roomId && msg.type !== 'hello' && msg.type !== 'rooms') return;
  switch (msg.type) {
    case 'hello':
      S.roomId = msg.roomId || null;
      S.match = msg.match;
      S.board = msg.leaderboard;
      S.recent = msg.recentMatches || [];
      S.agents = msg.agents || [];
      S.rooms = msg.rooms || [];
      S.presence = msg.presence || null;
      S.fighters = msg.fighters || S.fighters;
      if (msg.server && msg.server.tickMs) S.tickMs = msg.server.tickMs;
      if (msg.match && msg.match.lastFrame) S.current = msg.match.lastFrame;
      $('seasonChip').textContent = 'SEASON ' + (msg.server.season || 'S1');
      $('footSeason').textContent = msg.server.season || 'S1';
      renderRoomBar();
      renderPresence();
      renderMatchHead();
      renderBoard();
      renderReplayList();
      renderLobby();
      renderFighters();
      if (S.current) draw(ctx, S.current, S.match, stageCanvas);
      break;
    case 'rooms':
      S.rooms = msg.rooms || [];
      if (msg.presence) S.presence = msg.presence;
      if (msg.leaderboard) { S.board = msg.leaderboard; renderBoard(); }
      if (msg.recentMatches) { S.recent = msg.recentMatches; renderReplayList(); }
      renderPresence();
      renderLobby();
      break;
    case 'match_start':
      S.match = msg.match;
      S.frameQueue.length = 0;
      S.fx.length = 0;
      FX_KEYS.clear();
      S.current = msg.match.lastFrame;
      $('decisionList').innerHTML = '<div class="empty">新一局开始…</div>';
      $('combatList').innerHTML = '<div class="empty">等待交火…</div>';
      renderRoomBar();
      renderPresence();
      renderMatchHead();
      if (msg.leaderboard) { S.board = msg.leaderboard; renderBoard(); }
      break;
    case 'tick':
      if (!S.match || msg.matchId !== S.match.matchId) break;
      for (const f of msg.frames) S.frameQueue.push(f);
      if (S.frameQueue.length > 40) S.frameQueue.splice(0, S.frameQueue.length - 12);
      appendDecisions(msg);
      appendCombat(msg.events);
      renderBudget(msg.budget);
      updateTickLabel(msg.tick, msg.hud);
      break;
    case 'match_end':
      if (msg.leaderboard) { S.board = msg.leaderboard; renderBoard(); }
      if (msg.recentMatches) { S.recent = msg.recentMatches; renderReplayList(); }
      appendSystemEvent('对局结束 · ' + (msg.result.winnerName || msg.result.winner) + ' 胜出 · ' + (msg.result.reason === 'ko' ? 'KO' : '时间到'), 'ev-ko');
      break;
    default:
      break;
  }
}

/* ---------------------------------------------------------------- match head */
function renderMatchHead() {
  const m = S.match;
  if (!m || !m.a || !m.b) return;
  const src = (s) => SOURCE_LABEL[s] || s;
  const conn = (a) => a.source === 'external' ? (a.connected ? ' · WS 已连' : ' · WS 未连') : ' · 无需长连接';
  $('nameA').textContent = m.a.name;
  $('nameB').textContent = m.b.name;
  $('labelA').textContent = m.a.label;
  $('labelB').textContent = m.b.label;
  $('fighterA').textContent = m.a.fighter ? m.a.fighter.code + ' · ' + m.a.fighter.name : 'QUARTZ · 晶衡';
  $('fighterB').textContent = m.b.fighter ? m.b.fighter.code + ' · ' + m.b.fighter.name : 'QUARTZ · 晶衡';
  $('kindA').textContent = src(m.a.source) + ' · ' + m.a.kind + conn(m.a);
  $('kindB').textContent = m.b.kind + ' · ' + src(m.b.source) + conn(m.b);
  $('verA').textContent = 'v:' + short(m.a.versionHash, 10);
  $('verB').textContent = 'v:' + short(m.b.versionHash, 10);
  $('descA').textContent = m.a.description || '—';
  $('descB').textContent = m.b.description || '—';
  $('ratingA').textContent = 'ELO ' + (m.a.rating || 1500);
  $('ratingB').textContent = 'ELO ' + (m.b.rating || 1500);
  $('matchIdLabel').textContent = m.matchId;
  $('hudNameA').textContent = m.a.name.toUpperCase().slice(0, 18);
  $('hudNameB').textContent = m.b.name.toUpperCase().slice(0, 18);
  $('tickLabel').textContent = 'TICK ' + String(m.tick).padStart(3, '0') + ' / ' + m.totalTicks;
  $('footTick').textContent = 'TICK ' + String(m.tick).padStart(3, '0');
  if (S.current) renderHud(S.current);
}

function updateTickLabel(tick, hud) {
  $('tickLabel').textContent = 'TICK ' + String(tick).padStart(3, '0') + ' / ' + (S.match ? S.match.totalTicks : 600);
  $('footTick').textContent = 'TICK ' + String(tick).padStart(3, '0');
  if (hud) {
    $('frameLabel').textContent = 'FRAME ' + String(hud.frame).padStart(4, '0') + ' · TICK ' + String(tick).padStart(4, '0');
    renderHud(hud);
  }
}

function renderHud(f) {
  $('hpBarA').style.width = pct(f.a.hp, 1000);
  $('hpBarB').style.width = pct(f.b.hp, 1000);
  $('meterBarA').style.width = pct(f.a.meter, 300);
  $('meterBarB').style.width = pct(f.b.meter, 300);
  $('hudHpA').textContent = f.a.hp;
  $('hudHpB').textContent = f.b.hp;
  $('timerLabel').textContent = f.timer;
}

/* ---------------------------------------------------------------- event feed */
function ensureList(id) {
  const el = $(id);
  if (el.querySelector('.empty')) el.innerHTML = '';
  return el;
}

function trim(el, max = 70) {
  while (el.children.length > max) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}

function appendDecisions(msg) {
  const list = ensureList('decisionList');
  for (const side of ['a', 'b']) {
    const d = msg.decisions && msg.decisions[side];
    if (!d) continue;
    const row = document.createElement('div');
    row.className = 'ev';
    row.innerHTML =
      '<span class="ev-tick">' + String(d.tick).padStart(3, '0') + '</span>' +
      '<span class="ev-side ' + side + '">' + (side === 'a' ? 'A' : 'B') + '</span>' +
      '<div class="ev-body"><div class="ev-title">' + escapeHtml(d.text) + '</div>' +
      '<div class="ev-sub mono">' + d.action + ' · 帧优势 ' + d.frameAdvantage + ' · 距离 ' + d.distanceX + '</div></div>';
    list.appendChild(row);
  }
  trim(list);
}

function appendCombat(events) {
  if (!events || !events.length) return;
  const list = ensureList('combatList');
  for (const e of events) {
    if (e.type === 'move_start' && !['special', 'ex', 'super'].includes(e.move)) continue;
    const row = document.createElement('div');
    row.className = 'ev ' + (e.type === 'hit' ? 'ev-hit' : e.type === 'block' ? 'ev-block' : e.type === 'ko' ? 'ev-ko' : '');
    let title;
    if (e.type === 'hit') title = (e.by === 'a' ? 'A' : 'B') + ' · ' + label(e.move) + ' 命中 · ' + e.damage + ' 伤害' + (e.combo > 1 ? ' · ' + e.combo + ' 连击' : '');
    else if (e.type === 'block') title = (e.on === 'a' ? 'A' : 'B') + ' 防住 ' + label(e.move) + ' · 削血 ' + e.damage;
    else if (e.type === 'spawn') title = (e.by === 'a' ? 'A' : 'B') + ' 发出 ' + label(e.move);
    else if (e.type === 'ko') title = 'KO · 胜方 ' + String(e.winner || '').toUpperCase();
    else if (e.type === 'time_up') title = '时间到 · 按剩余血量判定，胜方 ' + String(e.winner || '').toUpperCase();
    else if (e.type === 'cancel') title = (e.by === 'a' ? 'A' : 'B') + ' · 取消连段 ' + label(e.from) + ' → ' + label(e.into);
    else if (e.type === 'super_start') title = (e.by === 'a' ? 'A' : 'B') + ' · 超必杀发动 · 消耗 100 气';
    else if (e.type === 'armor') title = (e.on === 'a' ? 'A' : 'B') + ' · 霸体吸收 ' + e.damage + ' 伤害，未进入硬直';
    else if (e.type === 'wakeup') title = (e.by === 'a' ? 'A' : 'B') + ' · 起身，短暂无敌';
    else if (e.type === 'move_start') title = (e.by === 'a' ? 'A' : 'B') + ' · 发动 ' + label(e.move) + (e.meterCost ? ' · 消耗 ' + e.meterCost + ' 气' : '');
    else title = EVENT_LABEL[e.type] || e.type;
    row.innerHTML =
      '<span class="ev-tick">' + String(e.tick).padStart(3, '0') + '</span>' +
      '<div class="ev-body"><div class="ev-title">' + escapeHtml(title) + '</div>' +
      '<div class="ev-sub mono">frame ' + e.frame + (e.frameAdvantage !== undefined ? ' · adv ' + e.frameAdvantage : '') + '</div></div>';
    list.appendChild(row);
  }
  trim(list);
}

function appendSystemEvent(text, cls) {
  const list = ensureList('combatList');
  const row = document.createElement('div');
  row.className = 'ev ' + (cls || '');
  row.innerHTML = '<span class="ev-tick">—</span><div class="ev-body"><div class="ev-title">' + escapeHtml(text) + '</div></div>';
  list.appendChild(row);
  trim(list);
}

function renderBudget(budget) {
  if (!budget) return;
  const items = [
    ['A 平均决策耗时', budget.a.avgMs + ' ms'],
    ['A 超时 / 模型调用', budget.a.timeouts + ' / ' + budget.a.modelCalls],
    ['B 平均决策耗时', budget.b.avgMs + ' ms'],
    ['B 超时 / 模型调用', budget.b.timeouts + ' / ' + budget.b.modelCalls],
  ];
  $('budget').innerHTML = items.map((i) => '<div class="budget-item"><span>' + i[0] + '</span><b>' + i[1] + '</b></div>').join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------------------------------------------------------- canvas */
function lerp(a, b, t) { return a + (b - a) * t; }

function poseFor(f) {
  const t = f.moveId && S.moves[f.moveId] ? Math.min(1, f.moveFrame / Math.max(1, S.moves[f.moveId].startup + S.moves[f.moveId].active)) : 0;
  const swing = Math.sin(Math.min(1, t) * Math.PI);
  const walk = Math.sin(f.state === 'walk' ? (f.x / 12) : 0) * 9;
  const p = {
    hip: [0, -44], chest: [0, -80], head: [0, -102],
    elbowF: [12, -66], handF: [26, -58],
    elbowB: [-12, -64], handB: [-22, -56],
    kneeF: [10, -22], footF: [16 + walk, 0],
    kneeB: [-9, -22], footB: [-16 - walk, 0],
  };
  if (f.state === 'crouch') {
    for (const k of Object.keys(p)) p[k][1] *= 0.68;
    p.footF = [22, 0]; p.footB = [-18, 0];
  } else if (f.state === 'jump' || f.y < 0) {
    p.kneeF = [16, -34]; p.footF = [22, -22];
    p.kneeB = [-12, -34]; p.footB = [-18, -20];
  } else if (f.state === 'guard' || f.blockstun > 0) {
    p.elbowF = [16, -74]; p.handF = [24, -86];
    p.elbowB = [-4, -70]; p.handB = [14, -70];
  } else if (f.state === 'hitstun') {
    p.chest = [-10, -78]; p.head = [-16, -98];
    p.handF = [-6, -50]; p.handB = [-30, -48];
  } else if (f.state === 'attack' || f.state === 'projectile') {
    const m = S.moves[f.moveId] || {};
    if (f.moveId === 'dp') {
      p.handF = [16 + 12 * swing, -128 + 8 * swing];
      p.elbowF = [10 + 6 * swing, -104];
      p.footF = [20, -16];
    } else if (f.moveId === 'fireball') {
      p.elbowF = [18 + 10 * swing, -72]; p.handF = [34 + 16 * swing, -70];
      p.elbowB = [2, -70]; p.handB = [22 + 12 * swing, -66];
    } else if (f.moveId === 'throw') {
      p.handF = [30 + 16 * swing, -76]; p.handB = [22 + 14 * swing, -72];
    } else if (['lk', 'mk', 'hk'].includes(f.moveId)) {
      p.kneeF = [22 + 16 * swing, -40]; p.footF = [34 + 46 * swing, -48 + 8 * swing];
    } else {
      p.elbowF = [16 + 8 * swing, -76]; p.handF = [30 + 52 * swing, -78 + 4 * swing];
      p.handB = [-14, -62];
    }
    if (m.startup && f.moveFrame < m.startup) {
      p.handF = [18, -72]; p.elbowF = [10, -70];
      p.footF = [16, 0];
    }
  }
  return p;
}

function line(c, a, b, width, color, outline) {
  c.lineCap = 'round';
  c.lineJoin = 'round';
  if (outline) {
    c.strokeStyle = '#0a1017';
    c.lineWidth = width + 4;
    c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
  }
  c.strokeStyle = color;
  c.lineWidth = width;
  c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
}

/* --- Painted art layer ---------------------------------------------------
 * Original generated illustrations are composited over a painted stage plate.
 * The procedural geometry below stays as a zero-dependency fallback while
 * images load (or if an asset is missing), so the site never shows an empty
 * arena. All art is 100% original: no SNK / KOF assets are used.
 * ------------------------------------------------------------------------ */
const ART = {
  images: Object.create(null),
  rigs: Object.create(null),
  rigPending: new Set(),
  stage: null,
  failed: new Set(),
  requested: false,
};

function artImage(id) {
  const img = ART.images[id];
  return img && img.complete && img.naturalWidth > 0 ? img : null;
}

function repaintArt() {
  if (S.current) draw(ctx, S.current, S.match, stageCanvas);
}

function loadArt(ids) {
  if (ART.requested) return;
  ART.requested = true;
  const plate = new Image();
  plate.onload = () => { ART.stage = plate; repaintArt(); };
  plate.onerror = () => ART.failed.add('stage');
  plate.src = '/assets/art/stage_main.png';
  for (const id of ids) {
    const img = new Image();
    img.onload = () => { ART.images[id] = img; repaintArt(); };
    img.onerror = () => ART.failed.add(id);
    img.src = '/assets/art/' + encodeURIComponent(id) + '.png';
  }
}

/** Painted stadium plate; returns false so the procedural set takes over. */
function drawStageArt(c, w, h) {
  const img = ART.stage;
  if (!img || !img.complete || !img.naturalWidth) {
    c.fillStyle = '#0b121a';
    c.fillRect(0, 0, w, h);
    return false;
  }
  const scale = w / img.naturalWidth;
  const dh = img.naturalHeight * scale;
  const dy = GROUND - dh * 0.70; // align the painted floor with the hitbox ground
  c.drawImage(img, 0, dy, w, dh);
  const veil = c.createLinearGradient(0, 0, 0, h);
  veil.addColorStop(0, 'rgba(6,11,18,.50)');
  veil.addColorStop(0.42, 'rgba(6,11,18,.08)');
  veil.addColorStop(1, 'rgba(6,11,18,.48)');
  c.fillStyle = veil;
  c.fillRect(0, 0, w, h);
  return true;
}

function blitFighter(c, img, gx, gy, W, H, dir, sx, sy, lean, bob) {
  c.translate(gx, gy + bob);
  c.rotate(lean);
  c.scale(dir * sx, sy);
  c.drawImage(img, -W / 2, -H + 6, W, H);
}
/**
 * Skeleton-driven cutout puppet. Every body part the bake step produced is
 * rotated by the same angular delta the kernel applied to that limb, so the
 * painted fighter performs the move the server actually resolved.
 * There is no client-side animation state machine here: this is a projection.
 */
const RIG_STATES = { knockdown: true };

function rigLocalJoints(f, sk) {
  const local = {};
  for (const [k, v] of Object.entries(sk.joints)) local[k] = [(v[0] - f.x) * (f.facing || 1), v[1] - f.y];
  return local;
}

function ensureRig(id) {
  if (ART.rigs[id] || ART.rigPending.has(id) || !id) return;
  ART.rigPending.add(id);
  loadRig(id).then((rig) => {
    ART.rigs[id] = rig;
    repaintArt();
  }).catch(() => { ART.failed.add('rig:' + id); });
}

function drawSpriteBody(c, img, o) {
  const { f, def, pal, dir, gx, gy } = o;
  const H = 204;
  const W = H * (img.naturalWidth / img.naturalHeight);
  const state = f.state || 'idle';
  const acting = state === 'attack' || state === 'projectile' || state === 'special';
  const m = S.moves[f.moveId];
  const active = Boolean(m && acting && f.moveFrame >= m.startup && f.moveFrame < m.startup + m.active);
  let sx = 1, sy = 1, lean = 0, bob = 0, flash = 1;
  if (state === 'walk' || state === 'dash') bob = Math.sin(((S.current && S.current.frame) || 0) * 0.24) * 2.2;
  if (f.y < -2) bob = -2;
  if (state === 'hitstun') flash = 1.6;
  if (state === 'knockdown') { lean = -1.12 * dir; bob = 10; }

  c.save();
  const glow = c.createRadialGradient(gx, gy - 82, 8, gx, gy - 82, W * 0.7);
  glow.addColorStop(0, pal.aura || 'rgba(140,180,220,.16)');
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = glow;
  c.beginPath(); c.ellipse(gx, gy - 82, W * 0.7, H * 0.58, 0, 0, Math.PI * 2); c.fill();
  c.restore();

  const rig = ART.rigs[def.id];
  const sk = f.skeleton;
  const rigid = RIG_STATES[state] || !sk;
  const local = sk && !rigid ? rigLocalJoints(f, sk) : {};
  const delta = sk && !rigid ? sk.delta || {} : {};

  if (active && rig) {
    c.save();
    c.globalAlpha = 0.22;
    c.filter = 'brightness(1.7) saturate(1.2)';
    drawRig(c, rig, { H, x: gx - 18 * dir, y: gy, dir, squashX: sx, squashY: sy, lean, bob, localJoints: local, delta });
    c.restore();
  }

  c.save();
  const filters = [];
  if (flash > 1) filters.push('brightness(' + flash + ')', 'saturate(1.2)');
  if (o.side === 'b') filters.push('hue-rotate(-14deg)', 'saturate(1.06)', 'brightness(0.97)', 'drop-shadow(0 0 5px rgba(91,140,255,.7))');
  if (filters.length) c.filter = filters.join(' ');
  if (rig) {
    drawRig(c, rig, { H, x: gx, y: gy, dir, squashX: sx, squashY: sy, lean, bob, localJoints: local, delta });
  } else {
    // Still loading (or no rig baked for this id): draw the plate whole.
    blitFighter(c, img, gx, gy, W, H, dir, sx, sy, lean, bob);
  }
  c.restore();

  if (f.counterWindow > 0) {
    // 当身 stance: a live window the opponent can read, and the only pose in
    // the game that punishes a blocked-hit guess.
    c.save();
    c.globalAlpha = 0.85;
    c.strokeStyle = pal.accent;
    c.lineWidth = 2.5;
    c.beginPath(); c.arc(gx + 10 * dir, gy - 108, 52, -1.5, 1.5); c.stroke();
    c.globalAlpha = 0.35;
    c.fillStyle = pal.light;
    c.beginPath(); c.arc(gx + 10 * dir, gy - 108, 52, -1.5, 1.5); c.fill();
    c.restore();
  }
  if (state === 'guard' || f.blockstun > 0) {
    c.save();
    c.strokeStyle = 'rgba(150,205,255,.55)';
    c.lineWidth = 2;
    c.beginPath(); c.arc(gx + 16 * dir, gy - 88, 46, -1.1, 1.1); c.stroke();
    c.restore();
  }
  if (f.armorLeft > 0) {
    c.save();
    c.strokeStyle = 'rgba(255,200,90,.8)';
    c.lineWidth = 2;
    c.beginPath(); c.ellipse(gx, gy - 92, W * 0.38, H * 0.52, 0, 0, Math.PI * 2); c.stroke();
    c.restore();
  }
}


const FALLBACK_FIGHTER = {
  palette: { base: '#c8d6e2', shade: '#5a7288', light: '#ffffff', accent: '#8fe6ff', aura: 'rgba(190,220,240,.16)' },
  build: { shoulder: 1, torso: 1, head: 1, limb: 1, bulk: 1 },
  gear: { head: 'visor', shoulder: 'plate', back: 'none', weapon: 'none' },
  signature: { shape: 'shard' },
};

function fighterDef(side, match) {
  const brief = match && ((side === 'a' ? match.a : match.b) || {}).fighter;
  const id = brief && brief.id;
  return (id && S.fighters.find((x) => x.id === id))
    || S.fighters.find((x) => x.id === 'quartz')
    || FALLBACK_FIGHTER;
}

function poly(c, pts, fill, stroke, lw = 1) {
  c.beginPath();
  c.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i += 1) c.lineTo(pts[i][0], pts[i][1]);
  c.closePath();
  if (fill) { c.fillStyle = fill; c.fill(); }
  if (stroke) { c.strokeStyle = stroke; c.lineWidth = lw; c.stroke(); }
}

function drawSignature(c, shape, x, y, dir, pal, phase) {
  c.save();
  c.translate(x, y);
  c.scale(dir, 1);
  c.globalAlpha = 0.72;
  c.strokeStyle = pal.light;
  c.fillStyle = pal.accent;
  c.lineWidth = 2;
  const r = 22 + phase * 2;
  switch (shape) {
    case 'wave':
      for (let i = 0; i < 3; i += 1) {
        c.beginPath(); c.arc(0, 0, r + i * 9, -0.9, 0.9); c.stroke();
      }
      break;
    case 'burst':
      for (let i = 0; i < 8; i += 1) {
        const a = (i / 8) * Math.PI * 2;
        line(c, [Math.cos(a) * 10, Math.sin(a) * 10], [Math.cos(a) * (r + 12), Math.sin(a) * (r + 12)], 2, pal.accent, true);
      }
      break;
    case 'crescent':
      c.beginPath(); c.arc(0, 0, r + 6, -1.15, 1.15); c.arc(0, 0, r - 6, 1.15, -1.15, true); c.fill();
      break;
    case 'bolt':
      c.beginPath(); c.moveTo(0, -r); c.lineTo(-8, 2); c.lineTo(3, -2); c.lineTo(-4, r); c.lineTo(12, -6); c.lineTo(1, -4); c.closePath(); c.fill();
      break;
    case 'ring':
      c.beginPath(); c.arc(0, 0, r, 0, Math.PI * 2); c.stroke();
      c.beginPath(); c.arc(0, 0, r - 8, 0, Math.PI * 2); c.stroke();
      break;
    default:
      poly(c, [[0, -r], [r * 0.7, 0], [0, r], [r * 0.2, 0]], pal.accent, pal.light, 1);
  }
  c.restore();
}

/**
 * The debug overlay is now REAL: these are the exact world-space rectangles
 * the kernel used to resolve this frame, plus the 15-joint skeleton they were
 * built from. Nothing here is computed or guessed on the client.
 */
function drawFrameGeometry(c, f, side) {
  const boxes = f.boxes;
  const sk = f.skeleton;
  if (!boxes || !sk) return;
  c.save();
  c.lineJoin = 'round';
  c.font = '9px ui-monospace, monospace';
  c.textAlign = 'left';

  if (S.showBoxes && boxes.push) {
    const b = boxes.push;
    c.strokeStyle = 'rgba(142,163,184,.55)';
    c.lineWidth = 1;
    c.setLineDash([3, 4]);
    c.strokeRect(b.x, GROUND + b.y, b.w, b.h);
    c.setLineDash([]);
  }
  if (S.showBoxes) {
    for (const b of boxes.hurt || []) {
      c.strokeStyle = 'rgba(56,217,192,.72)';
      c.fillStyle = 'rgba(56,217,192,.055)';
      c.lineWidth = 1.2;
      c.fillRect(b.x, GROUND + b.y, b.w, b.h);
      c.strokeRect(b.x, GROUND + b.y, b.w, b.h);
    }
    for (const b of boxes.hit || []) {
      c.strokeStyle = '#ff5d6c';
      c.fillStyle = 'rgba(255,93,108,.20)';
      c.lineWidth = 2;
      c.fillRect(b.x, GROUND + b.y, b.w, b.h);
      c.strokeRect(b.x, GROUND + b.y, b.w, b.h);
      const t = (b.height || '').toUpperCase() + ' · ' + b.damage;
      c.font = '700 10px ui-monospace, monospace';
      c.lineWidth = 3;
      c.strokeStyle = 'rgba(8,14,22,.9)';
      c.strokeText(t, b.x + 3, GROUND + b.y - 5);
      c.fillStyle = '#ffd7dc';
      c.fillText(t, b.x + 3, GROUND + b.y - 5);
    }
  }
  if (S.showBones) {
    // A/B use different bone colours so two overlapping mirrored fighters
    // stay readable as two separate skeletons.
    const warm = side === 'a';
    c.strokeStyle = warm ? 'rgba(255,209,102,.62)' : 'rgba(130,185,255,.58)';
    c.lineWidth = 1.3;
    for (const [x1, y1, x2, y2] of sk.bones) {
      c.beginPath();
      c.moveTo(x1, GROUND + y1);
      c.lineTo(x2, GROUND + y2);
      c.stroke();
    }
    for (const [k, v] of Object.entries(sk.joints)) {
      c.beginPath();
      c.arc(v[0], GROUND + v[1], k === 'head' ? 2.8 : 1.7, 0, Math.PI * 2);
      c.fillStyle = warm ? (k === 'handF' || k === 'footF' ? '#ff9f6b' : '#ffe1a2')
        : (k === 'handF' || k === 'footF' ? '#9fd0ff' : '#cfe6ff');
      c.fill();
    }
  }
  c.restore();
}

function drawFighter(c, f, side, frame, match) {
  const def = fighterDef(side, match);
  const pal = def.palette;
  const B = def.build || FALLBACK_FIGHTER.build;
  const G = def.gear || FALLBACK_FIGHTER.gear;
  const dir = f.facing || 1;
  const gx = f.x;
  const gy = GROUND + f.y;
  const p = poseFor(f);
  const sk = f.skeleton;
  // Joints come from the server's authoritative skeleton when available.
  // The procedural pose is only a fallback for pre-v2 replay data.
  const P = (k) => (sk && sk.joints && sk.joints[k]
    ? [sk.joints[k][0], GROUND + sk.joints[k][1]]
    : [gx + p[k][0] * dir, gy + p[k][1]]);
  const hip = P('hip'), chest = P('chest'), head = P('head');
  const elbowF = P('elbowF'), handF = P('handF'), elbowB = P('elbowB'), handB = P('handB');
  const kneeF = P('kneeF'), footF = P('footF'), kneeB = P('kneeB'), footB = P('footB');
  const bulk = B.bulk || 1;
  const sw = 11 * (B.shoulder || 1);
  const sideColor = side === 'a' ? '#35d6a4' : '#5b8cff';

  // Ground shadow + fighter aura. With painted art the solid aura ellipse
  // would show as a coloured block behind the illustration, so use a thin
  // side-colour outline instead.
  const sprite = artImage(def.id);
  if (sprite) ensureRig(def.id);
  c.save();
  if (sprite) {
    const sh = c.createRadialGradient(gx, GROUND + 2, 2, gx, GROUND + 2, 54 * bulk);
    sh.addColorStop(0, 'rgba(0,0,0,.62)');
    sh.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = sh;
    c.beginPath(); c.ellipse(gx, GROUND + 3, 54 * bulk, 11, 0, 0, Math.PI * 2); c.fill();
  } else {
    c.globalAlpha = 0.28; c.fillStyle = '#000';
    c.beginPath(); c.ellipse(gx, GROUND + 3, 30 * bulk, 6, 0, 0, Math.PI * 2); c.fill();
  }
  c.restore();
  c.save();
  if (sprite) {
    c.globalAlpha = 0.22; c.strokeStyle = sideColor; c.lineWidth = 1.2;
    c.beginPath(); c.ellipse(gx, gy - 94, 45 * bulk, 96, 0, 0, Math.PI * 2); c.stroke();
  } else {
    c.fillStyle = pal.aura || 'rgba(140,180,220,.12)';
    c.beginPath(); c.ellipse(gx, gy - 54, 40 * bulk, 62, 0, 0, Math.PI * 2); c.fill();
    c.globalAlpha = 0.32; c.strokeStyle = sideColor; c.lineWidth = 1.5; c.stroke();
  }
  c.restore();

  if (sprite) {
    drawSpriteBody(c, sprite, { f, def, pal, dir, gx, gy, sideColor, handF, bulk });
  } else {
  // Procedural fallback: used only while art loads or for an unknown id.
  // Back gear
  if (G.back === 'cape' || G.back === 'banner') {
    poly(c, [
      [chest[0] - 10 * dir, chest[1] - 12], [chest[0] + 10 * dir, chest[1] - 12],
      [chest[0] + 26 * dir, gy - 6], [chest[0] - 22 * dir, gy - 6],
    ], pal.shade, pal.light, 1);
  } else if (G.back === 'wing') {
    poly(c, [[chest[0], chest[1] - 14], [chest[0] - 34 * dir, chest[1] - 42], [chest[0] - 22 * dir, chest[1] - 2]], pal.light, pal.base, 1);
  }

  // Rear limbs
  const back = pal.shade;
  line(c, hip, kneeB, 9 * B.limb * bulk, back, true);
  line(c, kneeB, footB, 8 * B.limb * bulk, back, true);
  line(c, chest, elbowB, 7 * B.limb * bulk, back, true);
  line(c, elbowB, handB, 6 * B.limb * bulk, back, true);

  // Torso as an armoured shape, not a stick
  poly(c, [
    [hip[0] - 10 * bulk, hip[1] + 4], [hip[0] + 10 * bulk, hip[1] + 4],
    [chest[0] + sw, chest[1] - 6], [chest[0] - sw, chest[1] - 6],
  ], pal.base, pal.light, 1.4);
  poly(c, [
    [chest[0] - sw * 0.6, chest[1] - 12], [chest[0] + sw * 0.6, chest[1] - 12],
    [chest[0] + sw * 0.35, chest[1] + 16], [chest[0] - sw * 0.35, chest[1] + 16],
  ], pal.shade, null);
  c.fillStyle = pal.accent;
  c.fillRect(chest[0] - 3, chest[1] - 2, 6, 6);

  // Front limbs
  line(c, hip, kneeF, 10 * B.limb * bulk, pal.base, true);
  line(c, kneeF, footF, 9 * B.limb * bulk, pal.light, true);
  line(c, chest, elbowF, 8 * B.limb * bulk, pal.base, true);
  line(c, elbowF, handF, 7 * B.limb * bulk, pal.light, true);

  // Shoulder armour
  const sh = [chest[0] + sw * 0.72 * dir, chest[1] - 6];
  if (G.shoulder === 'spike') {
    poly(c, [[sh[0] - 9, sh[1] - 7], [sh[0] + 14 * dir, sh[1] - 18], [sh[0] + 9, sh[1] + 8]], pal.accent, pal.light, 1);
  } else if (G.shoulder === 'plate') {
    c.fillStyle = pal.light;
    c.beginPath(); c.ellipse(sh[0], sh[1], 11 * bulk, 7, 0, 0, Math.PI * 2); c.fill();
    c.strokeStyle = pal.shade; c.lineWidth = 1; c.stroke();
  } else if (G.shoulder === 'cloth') {
    poly(c, [[sh[0] - 8, sh[1] - 6], [sh[0] + 8, sh[1] - 6], [sh[0] + 6, sh[1] + 12], [sh[0] - 6, sh[1] + 10]], pal.shade, pal.light, 1);
  }

  // Head + headgear
  const hr = 12 * (B.head || 1);
  c.fillStyle = '#0a1017';
  c.beginPath(); c.arc(head[0], head[1], hr + 3, 0, Math.PI * 2); c.fill();
  c.fillStyle = pal.base;
  c.beginPath(); c.arc(head[0], head[1], hr, 0, Math.PI * 2); c.fill();
  c.fillStyle = pal.shade;
  c.beginPath(); c.arc(head[0] + 3 * dir, head[1], hr * 0.62, 0, Math.PI * 2); c.fill();
  c.fillStyle = pal.accent;
  c.fillRect(head[0] + 1 * dir, head[1] - 2, 5 * dir, 3);
  if (G.head === 'crest') {
    poly(c, [[head[0] - 8, head[1] - hr], [head[0] - 2, head[1] - hr - 16], [head[0] + 8, head[1] - hr - 6], [head[0] + 9, head[1] - hr]], pal.accent, pal.light, 1);
  } else if (G.head === 'horn') {
    poly(c, [[head[0] - 9, head[1] - hr + 2], [head[0] - 16, head[1] - hr - 12], [head[0] - 2, head[1] - hr - 4]], pal.light, null);
    poly(c, [[head[0] + 9, head[1] - hr + 2], [head[0] + 16, head[1] - hr - 12], [head[0] + 2, head[1] - hr - 4]], pal.light, null);
  } else if (G.head === 'hood') {
    poly(c, [[head[0] - hr - 3, head[1] + 4], [head[0] - 4, head[1] - hr - 7], [head[0] + hr + 3, head[1] + 2]], pal.shade, pal.light, 1);
  } else if (G.head === 'visor') {
    c.fillStyle = pal.light;
    c.fillRect(head[0] - hr, head[1] - 3, hr * 2, 5);
  } else if (G.head === 'halo') {
    c.strokeStyle = pal.accent; c.lineWidth = 2;
    c.beginPath(); c.arc(head[0], head[1] - hr - 9, 11, 0, Math.PI * 2); c.stroke();
  }

  // Weapon held in the front hand
  if (G.weapon === 'blade') {
    line(c, handF, [handF[0] + 30 * dir, handF[1] - 22], 3, pal.light, true);
  } else if (G.weapon === 'staff') {
    line(c, [handF[0], handF[1] - 24], [handF[0], handF[1] + 34], 4, pal.shade, true);
    c.fillStyle = pal.accent;
    c.beginPath(); c.arc(handF[0], handF[1] - 27, 7, 0, Math.PI * 2); c.fill();
  } else if (G.weapon === 'gauntlet') {
    c.fillStyle = pal.accent;
    c.beginPath(); c.arc(handF[0], handF[1], 9 * bulk, 0, Math.PI * 2); c.fill();
    c.strokeStyle = pal.light; c.lineWidth = 1.5; c.stroke();
  }

  } // end procedural fallback

  // Active-frame signature effect
  const m = S.moves[f.moveId];
  const active = m && (f.state === 'attack' || f.state === 'projectile') && f.moveFrame >= m.startup && f.moveFrame < m.startup + m.active;
  if (active) {
    drawSignature(c, (def.signature && def.signature.shape) || 'shard', handF[0] + 20 * dir, handF[1], dir, pal, f.moveFrame - m.startup);
  }

  drawFrameGeometry(c, f, side);

  // Side marker on the floor so mirrored fighters stay distinguishable.
  c.strokeStyle = sideColor; c.lineWidth = 2; c.globalAlpha = 0.8;
  c.beginPath(); c.ellipse(gx, GROUND + 2, 20 * bulk, 4, 0, 0, Math.PI * 2); c.stroke();
  c.globalAlpha = 1;
  c.textAlign = 'center';
  c.lineJoin = 'round';
  c.lineWidth = 3;
  c.strokeStyle = 'rgba(11,18,26,.92)';
  const tagY = gy - (sprite ? 206 : 134);
  const comboY = gy - (sprite ? 228 : 155);
  const tag = (def.code || 'UNIT') + (f.moveId ? ' / ' + label(f.moveId) : '');
  c.font = '600 10px ui-monospace, monospace';
  const tw = c.measureText(tag).width;
  c.fillStyle = 'rgba(8,14,22,.62)';
  c.fillRect(gx - tw / 2 - 5, tagY - 10, tw + 10, 14);
  c.strokeText(tag, gx, tagY);
  c.fillStyle = sideColor;
  c.fillText(tag, gx, tagY);
  if (f.combo > 1) {
    c.font = '600 14px ui-monospace, monospace';
    c.strokeText(f.combo + ' HIT', gx, comboY);
    c.fillStyle = '#ffc260';
    c.fillText(f.combo + ' HIT', gx, comboY);
  }
}

/** Stylised bust for the fighter gallery. */
function drawPortrait(c, f, w, h) {
  const pal = f.palette;
  const G = f.gear || {};
  const cx = w / 2;
  const cy = h * 0.62;
  c.clearRect(0, 0, w, h);
  c.fillStyle = '#111a24'; c.fillRect(0, 0, w, h);
  c.strokeStyle = 'rgba(140,170,200,.09)'; c.lineWidth = 1;
  for (let x = 0; x < w; x += 20) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
  for (let y = 0; y < h; y += 20) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
  c.fillStyle = pal.aura || 'rgba(140,180,220,.12)';
  c.beginPath(); c.arc(cx, cy, 66, 0, Math.PI * 2); c.fill();
  if (G.back === 'cape' || G.back === 'banner') {
    poly(c, [[cx - 38, cy - 26], [cx + 38, cy - 26], [cx + 62, h], [cx - 62, h]], pal.shade, pal.light, 1);
  } else if (G.back === 'wing') {
    poly(c, [[cx, cy - 30], [cx - 78, cy - 62], [cx - 46, h]], pal.light, pal.base, 1);
    poly(c, [[cx, cy - 30], [cx + 78, cy - 62], [cx + 46, h]], pal.light, pal.base, 1);
  }
  poly(c, [[cx - 30, cy], [cx + 30, cy], [cx + 52, h], [cx - 52, h]], pal.base, pal.light, 1.5);
  poly(c, [[cx - 18, cy + 4], [cx + 18, cy + 4], [cx + 12, cy + 46], [cx - 12, cy + 46]], pal.shade, null);
  c.fillStyle = pal.accent; c.fillRect(cx - 4, cy + 14, 8, 8);
  const hr = 22;
  c.fillStyle = '#0a1017'; c.beginPath(); c.arc(cx, cy - 46, hr + 4, 0, Math.PI * 2); c.fill();
  c.fillStyle = pal.base; c.beginPath(); c.arc(cx, cy - 46, hr, 0, Math.PI * 2); c.fill();
  c.fillStyle = pal.shade; c.beginPath(); c.arc(cx + 5, cy - 46, hr * 0.62, 0, Math.PI * 2); c.fill();
  c.fillStyle = pal.accent; c.fillRect(cx + 2, cy - 48, 10, 4);
  if (G.head === 'crest') poly(c, [[cx - 14, cy - 62], [cx - 4, cy - 92], [cx + 14, cy - 68], [cx + 16, cy - 60]], pal.accent, pal.light, 1);
  else if (G.head === 'horn') { poly(c, [[cx - 18, cy - 58], [cx - 30, cy - 88], [cx - 4, cy - 66]], pal.light, null); poly(c, [[cx + 18, cy - 58], [cx + 30, cy - 88], [cx + 4, cy - 66]], pal.light, null); }
  else if (G.head === 'hood') poly(c, [[cx - 28, cy - 36], [cx - 8, cy - 76], [cx + 28, cy - 38]], pal.shade, pal.light, 1);
  else if (G.head === 'visor') { c.fillStyle = pal.light; c.fillRect(cx - hr, cy - 49, hr * 2, 6); }
  else if (G.head === 'halo') { c.strokeStyle = pal.accent; c.lineWidth = 3; c.beginPath(); c.arc(cx, cy - 74, 17, 0, Math.PI * 2); c.stroke(); }
  if (G.shoulder === 'spike') {
    poly(c, [[cx - 48, cy - 2], [cx - 70, cy - 30], [cx - 30, cy - 12]], pal.accent, pal.light, 1);
    poly(c, [[cx + 48, cy - 2], [cx + 70, cy - 30], [cx + 30, cy - 12]], pal.accent, pal.light, 1);
  } else if (G.shoulder === 'plate') {
    c.fillStyle = pal.light;
    c.beginPath(); c.ellipse(cx - 36, cy - 4, 18, 10, 0, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.ellipse(cx + 36, cy - 4, 18, 10, 0, 0, Math.PI * 2); c.fill();
  }
  c.font = '10px ui-monospace, monospace'; c.fillStyle = 'rgba(231,238,246,.4)'; c.textAlign = 'left';
  c.fillText('UNIT / ' + f.code, 10, h - 10);
}

function skillName(side, moveId, match) {
  const def = fighterDef(side, match);
  const sk = def && def.skills && def.skills.find((s) => s.id === moveId);
  return sk ? sk.name : label(moveId);
}

/* ------------------------------------------------------------ combat effects */
const FX_KEYS = new Set();
function syncEffects(frame) {
  if (!S.showFx || !frame || !frame.events) return;
  for (const e of frame.events) {
    const key = e.frame + '|' + e.type + '|' + (e.by || '') + '|' + (e.on || '') + '|' + (e.move || '');
    if (FX_KEYS.has(key)) continue;
    FX_KEYS.add(key);
    if (FX_KEYS.size > 260) FX_KEYS.clear();
    if (['hit', 'block', 'cancel', 'armor', 'counter', 'wakeup', 'super_start', 'ko', 'move_start'].includes(e.type)) {
      S.fx.push({ ...e, born: frame.frame });
    }
  }
}

function drawEffects(c, frame, match, w, h) {
  if (!S.showFx || !frame) return;
  const now = frame.frame;
  S.fx = S.fx.filter((p) => now - p.born < 46);
  c.save();
  for (const p of S.fx) {
    const age = now - p.born;
    const k = Math.max(0, 1 - age / 46);
    const x = p.x !== undefined ? p.x : w / 2;
    const y = p.y !== undefined ? GROUND + p.y : h * 0.45;
    c.textAlign = 'center';
    if (p.type === 'hit') {
      const r = 8 + age * 2.6;
      c.strokeStyle = 'rgba(255,196,110,' + (k * 0.9).toFixed(2) + ')';
      c.lineWidth = 3 * k + 0.6;
      c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.stroke();
      for (let i = 0; i < 8; i += 1) {
        const a = (i / 8) * Math.PI * 2 + age * 0.05;
        c.beginPath();
        c.moveTo(x + Math.cos(a) * 6, y + Math.sin(a) * 6);
        c.lineTo(x + Math.cos(a) * (16 + age), y + Math.sin(a) * (16 + age));
        c.stroke();
      }
      c.font = '700 ' + (18 + Math.min(8, age * 0.4)) + 'px ui-monospace, monospace';
      c.lineWidth = 3; c.strokeStyle = 'rgba(8,14,22,.9)';
      const txt = '-' + p.damage + (p.combo > 1 ? '  ' + p.combo + ' HIT' : '');
      c.strokeText(txt, x, y - 24 - age * 0.6);
      c.fillStyle = p.knockdown ? '#ff8a6b' : '#ffd166';
      c.fillText(txt, x, y - 24 - age * 0.6);
    } else if (p.type === 'block') {
      c.strokeStyle = 'rgba(130,205,255,' + k.toFixed(2) + ')';
      c.lineWidth = 3;
      c.beginPath(); c.arc(x, y, 22 + age * 0.8, -1.2, 1.2); c.stroke();
      c.font = '600 11px ui-monospace, monospace';
      c.fillStyle = 'rgba(170,220,255,' + k.toFixed(2) + ')';
      c.fillText('GUARD', x, y - 28 - age * 0.4);
    } else if (p.type === 'armor') {
      c.strokeStyle = 'rgba(255,200,90,' + k.toFixed(2) + ')';
      c.lineWidth = 3;
      c.beginPath(); c.arc(x, y, 30 + age, 0, Math.PI * 2); c.stroke();
      c.font = '600 11px ui-monospace, monospace';
      c.fillStyle = '#ffd166';
      c.fillText('ARMOR', x, y - 36);
    } else if (p.type === 'cancel') {
      c.font = '700 13px ui-monospace, monospace';
      c.fillStyle = 'rgba(120,255,205,' + k.toFixed(2) + ')';
      c.fillText('CANCEL → ' + label(p.into), w / 2, 118 - age * 0.5);
    } else if (p.type === 'move_start' && ['special', 'ex', 'super'].includes(p.move)) {
      const side = p.by;
      c.font = '700 14px ui-monospace, monospace';
      c.fillStyle = 'rgba(255,225,160,' + k.toFixed(2) + ')';
      c.fillText(skillName(side, p.move, match), side === 'a' ? w * 0.27 : w * 0.73, 104 - age * 0.35);
    } else if (p.type === 'wakeup') {
      c.fillStyle = 'rgba(180,200,220,' + (k * 0.4).toFixed(2) + ')';
      for (let i = 0; i < 5; i += 1) {
        c.beginPath();
        c.arc(x + (i - 2) * 14, GROUND - 2 - age * 0.4, 5 + age * 0.5, 0, Math.PI * 2);
        c.fill();
      }
    }
  }

  if (frame.superFlash > 0) {
    const k = Math.min(1, frame.superFlash / 30);
    c.fillStyle = 'rgba(255,238,205,' + (0.16 * k).toFixed(3) + ')';
    c.fillRect(0, 0, w, h);
    c.save();
    c.translate(w / 2, 190);
    c.rotate(now * 0.012);
    c.strokeStyle = 'rgba(255,214,130,' + (0.32 * k).toFixed(2) + ')';
    c.lineWidth = 2;
    for (let i = 0; i < 18; i += 1) {
      const a = (i / 18) * Math.PI * 2;
      c.beginPath();
      c.moveTo(Math.cos(a) * 90, Math.sin(a) * 90);
      c.lineTo(Math.cos(a) * 620, Math.sin(a) * 620);
      c.stroke();
    }
    c.restore();
    if (frame.superFlash > 8) {
      const cast = frame.a.moveId === 'super' ? 'a' : frame.b.moveId === 'super' ? 'b' : null;
      c.textAlign = 'center';
      c.font = '800 44px ui-monospace, monospace';
      c.lineWidth = 5; c.strokeStyle = 'rgba(9,15,24,.9)';
      const title = cast ? skillName(cast, 'super', match) : '超必杀';
      c.strokeText(title, w / 2, 196);
      c.fillStyle = '#ffe3a6';
      c.fillText(title, w / 2, 196);
      c.font = '600 11px ui-monospace, monospace';
      c.fillStyle = 'rgba(255,220,170,.75)';
      c.fillText('SUPER · 3 HIT · 100 METER', w / 2, 216);
    }
  }
  c.restore();
}

/** Startup / active / recovery + cancel window + 3 meter bars, per side. */
function drawFrameBar(c, f, x, y, w, side, match) {
  const ph = f.phase || { phase: 'none', frame: 0, total: 0, startup: 0, active: 0, recovery: 0 };
  const total = Math.max(1, ph.total || 1);
  const seg = (n) => (n / total) * w;
  c.save();
  c.textAlign = 'left';
  c.font = '600 10px ui-monospace, monospace';
  c.fillStyle = side === 'a' ? '#35d6a4' : '#5b8cff';
  const title = f.moveId ? skillName(side, f.moveId, match) : (f.state === 'knockdown' ? '倒地' : '可行动');
  c.fillText(title.toUpperCase(), x, y - 9);
  c.fillStyle = 'rgba(210,225,240,.55)';
  c.textAlign = 'right';
  c.fillText((ph.phase === 'none' ? 'READY' : PHASE_LABEL[ph.phase] + ' ' + ph.frame + '/' + ph.total), x + w, y - 9);

  const parts = [
    [seg(ph.startup), 'rgba(255,193,92,.55)'],
    [seg(ph.active), 'rgba(255,93,108,.8)'],
    [seg(ph.recovery), 'rgba(140,160,184,.35)'],
  ];
  let px = x;
  for (const [len, col] of parts) { c.fillStyle = col; c.fillRect(px, y, Math.max(0, len - 1), 6); px += len; }
  if (ph.phase !== 'none') {
    const cur = x + seg(ph.frame);
    c.fillStyle = '#fff';
    c.fillRect(cur - 1, y - 3, 2, 12);
  }
  if (ph.cancelable) {
    c.fillStyle = '#7dffcb';
    c.font = '700 9px ui-monospace, monospace';
    c.textAlign = 'left';
    c.fillText('CANCEL ' + (ph.cancelInto || []).join('/'), x, y + 18);
  }
  // Three 100-point meter bars: EX = half a bar, super = a full bar.
  for (let i = 0; i < 3; i += 1) {
    const bx = x + i * 34;
    const fill = Math.max(0, Math.min(1, (f.meter - i * 100) / 100));
    c.fillStyle = 'rgba(140,160,184,.2)';
    c.fillRect(bx, y + 24, 30, 4);
    c.fillStyle = f.meter >= 100 ? '#ffc260' : 'rgba(255,194,96,.65)';
    c.fillRect(bx, y + 24, 30 * fill, 4);
  }
  c.fillStyle = 'rgba(190,210,230,.45)';
  c.font = '9px ui-monospace, monospace';
  c.textAlign = 'left';
  c.fillText('METER ' + f.meter + (f.meter >= 100 ? '  SUPER READY' : f.meter >= 50 ? '  EX READY' : ''), x + 108, y + 28);
  c.restore();
}

function drawBoxLegend(c, w) {
  if (!S.showBoxes && !S.showBones) return;
  const items = [
    ['#38d9c0', 'HURT 受击框'], ['#ff5d6c', 'HIT 攻击框'],
    ['#8ea3b8', 'PUSH 碰撞框'], ['#ffd166', 'BONE 骨架'],
  ];
  c.save();
  c.font = '9px ui-monospace, monospace';
  c.textAlign = 'left';
  let x = 52;
  for (const [col, text] of items) {
    c.fillStyle = col;
    c.fillRect(x, 73, 7, 7);
    c.fillStyle = 'rgba(190,210,230,.62)';
    c.fillText(text, x + 11, 80);
    x += c.measureText(text).width + 26;
  }
  c.restore();
  void w;
}

function draw(c, frame, match, canvas) {
  const w = canvas.width;
  const h = canvas.height;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, w, h);
  if (canvas === stageCanvas && frame && frame.hitstop > 0) {
    c.translate(frame.frame % 2 ? 2 : -2, frame.frame % 3 ? 1 : -1);
  }
  const artStage = drawStageArt(c, w, h);
  if (!artStage) {

  // Back wall, distant structures and a spectator rail: a broadcast set,
  // not a flat debug grid.
  c.fillStyle = '#101b26';
  c.fillRect(0, 40, w, GROUND - 40);
  c.fillStyle = '#13202d';
  for (let x = 18; x < w; x += 86) {
    const top = 104 + (x % 3) * 9;
    c.fillRect(x, top, 46, GROUND - 70 - top);
    c.fillStyle = 'rgba(120,170,210,.07)';
    for (let y = top + 12; y < GROUND - 78; y += 18) c.fillRect(x + 8, y, 30, 5);
    c.fillStyle = '#13202d';
  }
  c.fillStyle = '#0e1923';
  c.fillRect(0, GROUND - 70, w, 70);
  c.fillStyle = 'rgba(130,170,205,.10)';
  for (let x = 12; x < w; x += 14) c.fillRect(x, GROUND - 56, 6, 6);
  c.fillStyle = 'rgba(130,170,205,.06)';
  for (let x = 6; x < w; x += 22) c.fillRect(x, GROUND - 40, 9, 4);
  for (const lx of [108, 480, 852]) {
    c.fillStyle = '#1b2a38'; c.fillRect(lx - 3, 52, 6, GROUND - 122);
    c.fillStyle = '#2a3f52'; c.fillRect(lx - 14, 48, 28, 8);
    c.fillStyle = 'rgba(190,220,245,.055)';
    poly(c, [[lx - 12, 56], [lx + 12, 56], [lx + 96, GROUND - 70], [lx - 96, GROUND - 70]], 'rgba(190,220,245,.045)', null);
  }
  if (S.showGrid) {
    c.strokeStyle = 'rgba(120,160,190,.05)';
    c.lineWidth = 1;
    for (let x = 40; x <= 920; x += 60) { c.beginPath(); c.moveTo(x, 40); c.lineTo(x, GROUND); c.stroke(); }
    for (let y = 90; y < GROUND; y += 48) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
  }
  c.fillStyle = '#16212c';
  c.fillRect(0, GROUND, w, h - GROUND);
  c.strokeStyle = 'rgba(120,160,190,.07)';
  c.lineWidth = 1;
  for (let i = 1; i <= 6; i += 1) {
    const y = GROUND + i * 13;
    c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke();
  }
  c.strokeStyle = '#31465a';
  c.lineWidth = 2;
  c.beginPath(); c.moveTo(0, GROUND); c.lineTo(w, GROUND); c.stroke();
  c.strokeStyle = 'rgba(53,214,164,.35)';
  c.lineWidth = 1;
  for (const bx of [40, 920]) { c.beginPath(); c.moveTo(bx, 60); c.lineTo(bx, GROUND); c.stroke(); }
  } else {
    // Painted stage: keep only a faint floor line, arena bounds and the
    // optional debug grid. Everything else comes from the illustration.
    c.strokeStyle = 'rgba(200,232,255,.16)';
    c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(0, GROUND); c.lineTo(w, GROUND); c.stroke();
    c.strokeStyle = 'rgba(53,214,164,.30)';
    c.lineWidth = 1;
    for (const bx of [40, 920]) { c.beginPath(); c.moveTo(bx, 52); c.lineTo(bx, GROUND); c.stroke(); }
    if (S.showGrid) {
      c.strokeStyle = 'rgba(120,160,190,.10)';
      c.lineWidth = 1;
      for (let x = 40; x <= 920; x += 60) { c.beginPath(); c.moveTo(x, 40); c.lineTo(x, GROUND); c.stroke(); }
      for (let y = 90; y < GROUND; y += 48) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
    }
  }
  const mode = (match && match.mode) || 'demo';
  const stage = mode === 'ranked' ? 'RANKED ARENA' : mode === 'scrim' ? 'PRIVATE SCRIM' : 'NEUTRAL GRID';
  c.font = '10px ui-monospace, monospace';
  c.fillStyle = 'rgba(138,156,176,.5)';
  c.textAlign = 'left';
  c.fillText('STAGE 01 / ' + stage, 52, 62);
  c.textAlign = 'right';
  c.fillText('SERVER-AUTHORITATIVE · 60 FPS', 908, 62);
  c.textAlign = 'left';

  if (!frame) {
    c.fillStyle = 'rgba(138,156,176,.5)';
    c.font = '13px ui-monospace, monospace';
    c.textAlign = 'center';
    c.fillText('WAITING FOR FIRST FRAME', w / 2, 210);
    c.textAlign = 'left';
    return;
  }

  if (S.showRuler) {
    const dx = Math.abs(frame.a.x - frame.b.x);
    const y = GROUND + 24;
    c.strokeStyle = 'rgba(255,194,96,.55)';
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(frame.a.x, y); c.lineTo(frame.b.x, y); c.stroke();
    for (const x of [frame.a.x, frame.b.x]) {
      c.beginPath(); c.moveTo(x, y - 4); c.lineTo(x, y + 4); c.stroke();
    }
    c.fillStyle = '#ffc260';
    c.font = '10px ui-monospace, monospace';
    c.textAlign = 'center';
    c.fillText('DIST ' + dx, (frame.a.x + frame.b.x) / 2, y - 6);
    c.textAlign = 'left';
  }

  for (const p of frame.projectiles || []) {
    const pal = fighterDef(p.owner, match).palette;
    // The projectile is drawn AT THE SIZE OF ITS OWN HITBOX, so the picture
    // cannot promise reach the kernel does not have: an orb is 34x44, a super
    // beam is 96x92 and reads as a beam.
    const box = p.box || { w: 30, h: 40 };
    const bw = box.w;
    const bh = box.h;
    const beam = bw > 60;
    c.save();
    c.translate(p.x, GROUND + p.y);
    if ((p.delay || 0) > 0) { c.restore(); continue; }
    if (beam) {
      const grad = c.createLinearGradient(-bw / 2, 0, bw / 2, 0);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.25, pal.light);
      grad.addColorStop(0.6, pal.base);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      c.globalAlpha = 0.55;
      c.fillStyle = grad;
      c.fillRect(-bw / 2, -bh / 2, bw, bh);
      c.globalAlpha = 0.9;
      c.fillStyle = pal.accent;
      c.fillRect(-bw / 2, -bh * 0.16, bw, bh * 0.32);
      c.globalAlpha = 0.35;
      c.fillStyle = pal.light;
      c.fillRect(-bw / 2, -bh / 2, bw, 3);
      c.fillRect(-bw / 2, bh / 2 - 3, bw, 3);
    } else {
      const glow = c.createRadialGradient(0, 0, 2, 0, 0, Math.max(bw, bh) * 0.9);
      glow.addColorStop(0, pal.accent);
      glow.addColorStop(0.45, pal.light);
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      c.globalAlpha = 0.85;
      c.fillStyle = glow;
      c.beginPath(); c.ellipse(0, 0, bw * 0.9, bh * 0.9, 0, 0, Math.PI * 2); c.fill();
      c.globalAlpha = 0.95;
      c.fillStyle = pal.base;
      c.beginPath(); c.ellipse(0, 0, bw / 2, bh / 2, 0, 0, Math.PI * 2); c.fill();
      c.fillStyle = pal.accent;
      c.beginPath(); c.ellipse(0, 0, bw / 6, bh / 6, 0, 0, Math.PI * 2); c.fill();
    }
    c.restore();
  }

  drawFighter(c, frame.b, 'b', frame, match);
  drawFighter(c, frame.a, 'a', frame, match);

  syncEffects(frame);
  drawEffects(c, frame, match, w, h);
  drawFrameBar(c, frame.a, 52, h - 34, 320, 'a', match);
  drawFrameBar(c, frame.b, w - 52 - 320, h - 34, 320, 'b', match);
  drawBoxLegend(c, w);
  c.setTransform(1, 0, 0, 1, 0, 0);
}

let lastTime = performance.now();
let acc = 0;
function loop(now) {
  acc += Math.min(now - lastTime, 250);
  lastTime = now;
  const stepMs = 1000 / 60;
  let consumed = 0;
  while (acc >= stepMs && S.frameQueue.length && consumed < 12) {
    S.current = S.frameQueue.shift();
    acc -= stepMs;
    consumed += 1;
  }
  if (S.frameQueue.length > 30) {
    S.current = S.frameQueue[S.frameQueue.length - 1];
    S.frameQueue.length = 0;
    acc = 0;
  }
  if (consumed && S.current) {
    draw(ctx, S.current, S.match, stageCanvas);
    renderHud(S.current);
  }
  requestAnimationFrame(loop);
}

/* ---------------------------------------------------------------- lobby / roster */
const MODE_LABEL = { demo: '演示场', ranked: '排位场', scrim: '私房约战' };
const STATUS_LABEL = { waiting: '等待对手', running: '对战中', finished: '已结束' };
const PAIRING_LABEL = { showcase: '内置轮转', rating: '评分就近', code: '房间码', sparring: '内置陪练' };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const SOURCE_LABEL = { builtin: '内置演示', hosted: '服务端托管', external: '外部实时进程' };

// Make the real presence visible: a showcase match must never look like it
// has human/external players behind it when nothing is connected.
function renderPresence() {
  const el = $('presenceBar');
  if (!el) return;
  const p = S.presence || {};
  const online = Number(p.onlineAgents || 0);
  const waiting = Number(p.waiting || 0);
  const sides = [S.match && S.match.a, S.match && S.match.b].filter(Boolean);
  const external = sides.filter((s) => s.source === 'external');
  let note;
  if (online === 0 && waiting === 0) {
    note = '当前没有外部 Agent 连上，匹配队列也是空的。这一场是服务端自己的策略在打，属于演示，不是真实玩家对战。';
  } else if (online === 0) {
    note = '队列里有 ' + waiting + ' 个 Agent 等待配对；超时会配内置陪练，仍不等于两个真实玩家对战。';
  } else {
    note = '有 ' + online + ' 个外部 Agent 通过 WebSocket 在线，可在「对战大厅」切换房间观看它们的对局。';
  }
  el.className = 'presence-bar' + (online > 0 ? ' live' : '');
  el.innerHTML = '<span class="pb-item"><i class="pb-dot ' + (online > 0 ? 'on' : 'off') + '"></i>在线外部 Agent <b>' + online + '</b></span>'
    + '<span class="pb-item">匹配队列 <b>' + waiting + '</b></span>'
    + '<span class="pb-item">观众 <b>' + (p.spectators || 0) + '</b></span>'
    + '<span class="pb-item">本场来源 <b>' + (sides.length ? sides.map((s) => SOURCE_LABEL[s.source] || s.source).join(' / ') : '—') + '</b></span>'
    + '<span class="pb-item' + (external.length ? '' : ' alert') + '">本场外部进程 <b>' + external.length + '</b></span>'
    + '<span class="pb-note">' + esc(note) + '</span>';
}

function renderRoomBar() {
  const m = S.match || {};
  const mode = m.mode || 'demo';
  const tag = $('roomTag');
  tag.textContent = (mode === 'demo' ? 'DEMO · 演示场' : mode === 'ranked' ? 'RANKED · 排位场' : 'SCRIM · 私房') + (m.code ? ' · ' + m.code : '');
  tag.className = 'room-tag mode-' + mode;
  $('roomCopy').textContent = mode === 'demo'
    ? '内置 Agent 轮转，永远有画面。打开「对战大厅」切到任意一场真实对局。'
    : mode === 'ranked'
      ? '计入 Glicko-2 榜单 · ' + (PAIRING_LABEL[m.pairing] || '评分就近') + ' · 双方镜像角色'
      : '不计分 · 房间码约战 · 允许不同角色';
}

function sideHtml(side, label) {
  if (!side) return '<div class="rc-side"><span class="rc-empty">等待 ' + label + '…</span></div>';
  const pal = (side.fighter && side.fighter.palette) || {};
  return '<div class="rc-side"><span class="rc-dot" style="background:' + (pal.base || '#5b8cff') + '"></span>'
    + '<span class="rc-agent">' + esc(side.name) + '</span>'
    + '<span class="rc-fighter">' + esc((side.fighter && side.fighter.code) || 'QUARTZ') + '</span>'
    + '<span class="rc-source">' + (side.source === 'external' ? (side.connected ? '实时进程 · 已连' : '实时进程 · 离线') : (SOURCE_LABEL[side.source] || side.source)) + '</span></div>';
}

function renderLobby() {
  const grid = $('roomGrid');
  const summary = $('lobbySummary');
  const rooms = S.rooms || [];
  const p = S.presence || {};
  const runningRooms = rooms.filter((r) => r.status === 'running');
  const waitingRooms = rooms.filter((r) => r.status === 'waiting');
  const finishedRooms = rooms.filter((r) => r.status === 'finished');
  const watching = rooms.reduce((n, r) => n + (r.spectators || 0), 0);
  const stats = [
    [runningRooms.length, '正在进行'],
    [waitingRooms.length, '等待对手'],
    [p.onlineAgents || 0, '在线外部 Agent'],
    [p.waiting || 0, '排队中'],
    [watching, '当前观战人数'],
    [rooms.length, '房间总数 · 已结束 ' + finishedRooms.length],
  ];
  summary.innerHTML = stats.map(([v, k]) => '<div><b>' + v + '</b><span>' + esc(k) + '</span></div>').join('');
  if (!rooms.length) { grid.innerHTML = '<div class="empty">暂无房间</div>'; return; }
  // Finished rooms accumulate for replay access; only the 3 newest stay in the lobby.
  const visible = runningRooms.concat(waitingRooms, finishedRooms.slice(-3).reverse());
  grid.innerHTML = visible.map((r) => {
    const active = r.roomId === S.roomId;
    const a = r.a || null;
    const b = r.b || null;
    return '<article class="room-card ' + r.status + (active ? ' watching' : '') + '">'
      + '<div class="rc-top"><span class="rc-mode mode-' + r.mode + '">' + (MODE_LABEL[r.mode] || r.mode) + '</span>'
      + '<span class="rc-status ' + r.status + '">' + (STATUS_LABEL[r.status] || r.status) + '</span>'
      + '<span class="rc-score">' + (r.ranked ? '计分' : '不计分') + '</span></div>'
      + '<div class="rc-vs">' + sideHtml(a, '房主') + '<span class="rc-vs-mark">VS</span>' + sideHtml(b, '对手') + '</div>'
      + '<div class="rc-meta"><span>' + (PAIRING_LABEL[r.pairing] || r.pairing) + '</span><span>·</span><span>TICK ' + r.tick + '</span><span>·</span><span>' + r.spectators + ' 人观战</span></div>'
      + (r.code ? '<div class="rc-code mono">邀请码 ' + esc(r.code) + '</div>' : '')
      + '<div class="rc-foot"><span class="mono">' + esc(r.matchId || r.roomId) + '</span>'
      + '<button class="rc-watch" data-room="' + esc(r.roomId) + '">' + (active ? '正在观看' : '观战此房间') + '</button></div>'
      + '</article>';
  }).join('') + (finishedRooms.length > 3
    ? '<div class="empty">另有 ' + (finishedRooms.length - 3) + ' 场已结束对局未展开，可在「对局回放」里查看。</div>' : '');
}

function renderFighters() {
  const grid = $('fighterGrid');
  const chip = $('fighterCount');
  if (!S.fighters || !S.fighters.length) { grid.innerHTML = '<div class="empty">正在读取角色…</div>'; return; }
  if (chip) chip.textContent = S.fighters.length + ' FIGHTERS';
  const tile = (f) => {
    const p = f.profile || {};
    const bars = [['射程', p.reach], ['速度', p.speed], ['力量', p.power], ['防御', p.guard]].map(([k, v]) =>
      '<div class="ft-stat"><span>' + k + '</span><i style="width:' + ((v || 0) * 20) + '%"></i></div>').join('');
    return '<article class="fighter-tile" style="--f-base:' + f.palette.base + ';--f-light:' + f.palette.light + ';--f-accent:' + f.palette.accent + '">'
      + '<div class="ft-art-wrap"><img class="ft-art" src="/assets/art/' + esc(f.id) + '.png" alt="' + esc(f.name) + '" data-fighter="' + esc(f.id) + '" loading="lazy"></div>'
      + '<div class="ft-body"><div class="ft-code mono">' + esc(f.code) + '</div>'
      + '<h3>' + esc(f.name) + '<small>' + esc(f.title) + '</small></h3>'
      + '<div class="ft-style">' + esc(f.style) + '</div>'
      + '<p>' + esc(f.tagline) + '</p>'
      + '<div class="ft-stats">' + bars + '</div>'
      + '<div class="ft-sig mono">' + esc(f.kit ? f.kit.label : f.signature.name) + ' · '
      + esc((f.kit && f.kit.tags ? f.kit.tags : [f.signature.shape]).join(' / ')) + '</div>'
      + '<div class="ft-skills">' + (f.skills || []).map((s) =>
        '<div class="ft-skill"><span>' + esc(s.name) + '</span>'
        + '<span class="mono">' + s.startup + '/' + s.active + '/' + s.recovery + 'F · '
        + (s.cost ? s.cost + ' 气' : '免费') + ' · ' + esc(s.mechanic || 'strike')
        + ' · ' + (s.potentialDamage || s.damage) + ' 伤害</span></div>').join('')
      + '</div>'
      + (f.kit && f.kit.blurb ? '<p class="ft-kit">' + esc(f.kit.blurb) + '</p>' : '')
      + '<p class="ft-bio">' + esc(f.bio) + '</p></div></article>';
  };
  // Group by team in server roster order: a KOF-style select grid without a
  // hard-coded client-side roster, so new fighters need no frontend change.
  const groups = [];
  for (const f of S.fighters) {
    let g = groups.find((x) => x.id === (f.team || 'misc'));
    if (!g) {
      g = {
        id: f.team || 'misc', name: f.teamName || '自由人', code: f.teamCode || '',
        motif: f.teamMotif || '', color: f.teamColor || '#8b98a8', members: [],
      };
      groups.push(g);
    }
    g.members.push(f);
  }
  grid.innerHTML = groups.map((g) =>
    '<section class="fighter-team" style="--t-color:' + esc(g.color) + '">'
    + '<div class="ft-team-head"><div><div class="ft-team-code mono">' + esc(g.code || g.id) + '</div>'
    + '<h2>' + esc(g.name) + '</h2><p>' + esc(g.motif) + '</p></div>'
    + '<span class="ft-team-count mono">' + g.members.length + ' FIGHTERS</span></div>'
    + '<div class="fighter-team-grid">' + g.members.map(tile).join('') + '</div></section>'
  ).join('');
  // Procedural bust is only a fallback when a generated portrait is missing.
  grid.querySelectorAll('img.ft-art').forEach((im) => {
    im.addEventListener('error', () => {
      const f = S.fighters.find((x) => x.id === im.dataset.fighter);
      if (!f) return;
      const cv = document.createElement('canvas');
      cv.width = 240; cv.height = 170; cv.className = 'ft-portrait';
      drawPortrait(cv.getContext('2d'), f, cv.width, cv.height);
      im.replaceWith(cv);
    }, { once: true });
  });
  drawBoxDiagram();
}

/** Static explainer diagram for the roster page (live boxes come from the kernel). */
function drawBoxDiagram() {
  const cv = $('boxDiagram');
  if (!cv) return;
  const c = cv.getContext('2d');
  const w = cv.width, h = cv.height;
  c.clearRect(0, 0, w, h);
  c.fillStyle = '#0e1721'; c.fillRect(0, 0, w, h);
  c.strokeStyle = 'rgba(120,160,190,.08)'; c.lineWidth = 1;
  for (let x = 0; x < w; x += 20) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
  for (let y = 0; y < h; y += 20) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
  const J = {
    root: [0, 0], hip: [0, -88], chest: [0, -140], neck: [0, -158], head: [0, -178],
    shoulderF: [16, -148], elbowF: [30, -120], handF: [58, -130],
    shoulderB: [-14, -148], elbowB: [-26, -118], handB: [-34, -100],
    kneeF: [14, -46], footF: [22, -2], kneeB: [-14, -46], footB: [-22, -2],
  };
  const B = [['root', 'hip'], ['hip', 'chest'], ['chest', 'neck'], ['neck', 'head'],
    ['chest', 'shoulderF'], ['shoulderF', 'elbowF'], ['elbowF', 'handF'],
    ['chest', 'shoulderB'], ['shoulderB', 'elbowB'], ['elbowB', 'handB'],
    ['hip', 'kneeF'], ['kneeF', 'footF'], ['hip', 'kneeB'], ['kneeB', 'footB']];
  const k = 0.92, cx = 150, cy = 214;
  const P = (n) => [cx + J[n][0] * k, cy + J[n][1] * k];
  const R = (x, y, bw, bh) => [cx + x * k, cy + y * k, bw * k, bh * k];
  const box = (r, col, fill, dash) => {
    c.save();
    if (dash) c.setLineDash([4, 3]);
    c.strokeStyle = col; c.lineWidth = 1.5;
    c.fillStyle = fill; c.fillRect(...r); c.strokeRect(...r);
    c.restore();
  };
  c.strokeStyle = 'rgba(190,220,245,.16)'; c.beginPath(); c.moveTo(0, cy); c.lineTo(w, cy); c.stroke();
  box(R(-19, -176, 38, 176), 'rgba(142,163,184,.7)', 'rgba(142,163,184,.05)', true);
  box(R(-15, -196, 30, 36), '#38d9c0', 'rgba(56,217,192,.10)');
  box(R(-23, -173, 46, 66), '#38d9c0', 'rgba(56,217,192,.10)');
  box(R(-21, -84, 42, 88), '#38d9c0', 'rgba(56,217,192,.10)');
  box(R(50, -152, 40, 32), '#ff5d6c', 'rgba(255,93,108,.20)');
  c.strokeStyle = '#ffd166'; c.lineWidth = 2;
  for (const [a, b] of B) {
    const p = P(a), q = P(b);
    c.beginPath(); c.moveTo(p[0], p[1]); c.lineTo(q[0], q[1]); c.stroke();
  }
  for (const n of Object.keys(J)) {
    const p = P(n);
    c.fillStyle = '#ffe1a2'; c.beginPath(); c.arc(p[0], p[1], 2.3, 0, Math.PI * 2); c.fill();
  }
  c.font = '9px ui-monospace, monospace'; c.textAlign = 'left';
  c.fillStyle = '#38d9c0'; c.fillText('HURT ×3', 244, 44);
  c.fillStyle = '#ff5d6c'; c.fillText('HIT (ACTIVE)', 244, 60);
  c.fillStyle = '#8ea3b8'; c.fillText('PUSH', 244, 76);
  c.fillStyle = '#ffd166'; c.fillText('15 JOINTS / 14 BONES', 244, 92);
  c.fillStyle = 'rgba(210,228,245,.6)';
  c.fillText('头 / 躯干 / 腿框由骨架派生', 244, 116);
  c.fillText('攻击框锚定 handF / footF', 244, 132);
  c.fillText('矩形相交才判定命中', 244, 148);
  const parts = [[44, '#ffc15c', '起手'], [26, '#ff5d6c', '判定'], [70, '#8ca0b8', '收招']];
  let px = 244;
  for (const [len, col, text] of parts) {
    c.fillStyle = col; c.fillRect(px, 176, len, 7);
    c.fillStyle = 'rgba(210,228,245,.7)'; c.fillText(text, px, 196);
    px += len + 2;
  }
  c.fillStyle = 'rgba(120,255,205,.9)'; c.fillText('命中后 ↳ CANCEL 窗口', 244, 216);
}

function setupClientConfig() {
  const sel = $('clientSelect');
  if (!S.configs || !sel) return;
  sel.innerHTML = S.configs.clients.map((c, i) => '<option value="' + i + '">' + esc(c.name) + '</option>').join('');
  sel.addEventListener('change', applyClientConfig);
  applyClientConfig();
}

function applyClientConfig() {
  if (!S.configs) return;
  const c = S.configs.clients[Number($('clientSelect').value) || 0];
  if (!c) return;
  const url = location.origin + S.configs.endpoint;
  $('clientConfig').textContent = c.template.replace(/\{\{URL\}\}/g, url);
  $('clientScope').textContent = '配置位置：' + c.scope;
  $('clientNote').textContent = c.note;
}

/* ---------------------------------------------------------------- board */
async function loadBoard(track) {
  try {
    S.board = await api('/api/leaderboard' + (track && track !== 'open' ? '?track=' + track : ''));
    renderBoard();
  } catch (e) { console.error(e); }
}

function renderBoard() {
  const body = $('rankBody');
  if (!S.board || !S.board.rows.length) { body.innerHTML = '<tr><td colspan="10" class="empty">暂无排名数据</td></tr>'; return; }
  body.innerHTML = S.board.rows.map((r) =>
    '<tr>' +
    '<td class="num rank-num ' + (r.rank <= 3 ? 'top' : '') + '">' + String(r.rank).padStart(2, '0') + '</td>' +
    '<td><div class="agent-cell"><b>' + escapeHtml(r.name) + '</b><small>' + escapeHtml(r.label) + '</small></div></td>' +
    '<td class="hash">' + escapeHtml(short(r.versionHash, 10)) + '</td>' +
    '<td><span class="tag ' + (r.track === 'rule_only' ? 'rule' : '') + '">' + (r.track === 'rule_only' ? '纯规则' : '开放') + '</span></td>' +
    '<td class="num rating-strong">' + r.rating + '</td>' +
    '<td class="num">' + r.matches + '</td>' +
    '<td class="num">' + r.wins + ' / ' + r.losses + '</td>' +
    '<td class="num winrate">' + r.winRate + '%</td>' +
    '<td class="num">' + r.modelCallsPerMatch + '</td>' +
    '<td class="num">' + r.timeouts + '</td>' +
    '</tr>'
  ).join('');
  $('seasonChip').textContent = 'SEASON ' + S.board.season;
}

/* ---------------------------------------------------------------- replay */
function renderReplayList() {
  const list = $('matchList');
  if (!S.recent.length) { list.innerHTML = '<div class="empty">暂无已结束对局，稍等一局打完。</div>'; return; }
  list.innerHTML = S.recent.map((m) =>
    '<div class="match-item ' + (S.replay.matchId === m.matchId ? 'active' : '') + '" data-id="' + m.matchId + '">' +
    '<div class="mi-top"><span>' + escapeHtml(short(m.matchId, 18)) + '</span><span>' + m.ticks + ' 拍</span></div>' +
    '<div class="mi-names"><b>' + escapeHtml(m.a.name) + '</b> vs <span>' + escapeHtml(m.b.name) + '</span></div>' +
    '<div class="mi-meta">胜 ' + escapeHtml(m.winnerName) + ' · ' + (m.reason === 'ko' ? 'KO' : '时间到') + ' · Δ ' + m.ratingDeltaA + '</div>' +
    '</div>'
  ).join('');
  list.querySelectorAll('.match-item').forEach((el) => el.addEventListener('click', () => selectReplay(el.dataset.id)));
}

async function selectReplay(matchId) {
  stopReplay();
  const data = await api('/api/replay/' + encodeURIComponent(matchId) + '?render=1');
  S.replay.matchId = matchId;
  S.replay.ticks = data.ticks || [];
  S.replay.index = 0;
  $('replayRange').max = String(Math.max(0, S.replay.ticks.length - 1));
  $('replayRange').value = '0';
  document.querySelectorAll('.match-item').forEach((el) => el.classList.toggle('active', el.dataset.id === matchId));
  showReplayFrame(0);
}

function showReplayFrame(index) {
  const t = S.replay.ticks[index];
  if (!t) return;
  S.replay.index = index;
  const f = t.frames[t.frames.length - 1] || t.frames[0];
  draw(rctx, f, null, replayCanvas);
  $('replayRange').value = String(index);
  $('replayTickLabel').textContent = String(index + 1).padStart(3, '0') + ' / ' + S.replay.ticks.length;
  $('replayFrameLabel').textContent = 'FRAME ' + String(f.frame).padStart(4, '0') + ' · TICK ' + String(index).padStart(4, '0');
  const events = $('replayEvents');
  const rows = [];
  rows.push('<div class="ev"><span class="ev-tick">' + String(index).padStart(3, '0') + '</span><div class="ev-body"><div class="ev-title">A → ' + label(t.actions.a) + '　·　B → ' + label(t.actions.b) + '</div><div class="ev-sub mono">' + t.actions.a + ' / ' + t.actions.b + '</div></div></div>');
  for (const e of t.events || []) {
    const title = e.type === 'hit' ? (e.by === 'a' ? 'A' : 'B') + ' · ' + label(e.move) + ' 命中 ' + e.damage : e.type === 'block' ? '防住 ' + label(e.move) : EVENT_LABEL[e.type] || e.type;
    rows.push('<div class="ev ev-hit"><span class="ev-tick">' + String(index).padStart(3, '0') + '</span><div class="ev-body"><div class="ev-title">' + escapeHtml(title) + '</div><div class="ev-sub mono">frame ' + e.frame + '</div></div></div>');
  }
  events.innerHTML = rows.join('') || '<div class="empty">本拍无事件</div>';
  $('replayObs').textContent = JSON.stringify(t.observation, null, 1);
}

function stopReplay() {
  if (S.replay.timer) clearInterval(S.replay.timer);
  S.replay.timer = null;
  $('replayPlay').innerHTML = '<svg class="ic"><use href="#i-play"/></svg>';
}

function toggleReplay() {
  if (!S.replay.ticks.length) return;
  if (S.replay.timer) { stopReplay(); return; }
  $('replayPlay').innerHTML = '<svg class="ic"><use href="#i-pause"/></svg>';
  S.replay.timer = setInterval(() => {
    const next = S.replay.index + 1;
    if (next >= S.replay.ticks.length) { stopReplay(); return; }
    showReplayFrame(next);
  }, 100);
}

/* ---------------------------------------------------------------- connect */
async function createToken() {
  const name = $('agentName').value.trim() || 'My Agent';
  const kind = $('agentKind').value;
  try {
    const data = await api('/api/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, kind }),
    });
    $('tokenBox').hidden = false;
    $('tokenValue').textContent = data.token;
    $('wsValue').textContent = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + data.wsUrl;
    $('codeSample').textContent = $('codeSample').textContent.replace(/ws:\/\/localhost:8787\/ws\/agent/g, (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/agent');
    S.recent = S.recent || [];
    loadBoard();
  } catch (e) {
    alert('生成失败：' + e.message);
  }
}

function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const old = btn.innerHTML;
    btn.textContent = '已复制';
    setTimeout(() => { btn.innerHTML = old; }, 1200);
  });
}

/* ---------------------------------------------------------------- init */
function bindUI() {
  $('nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-btn');
    if (!btn || btn.tagName === 'A') return; // <a> entries are real page links (docs)
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + btn.dataset.view));
    if (btn.dataset.view === 'lobby') api('/api/rooms').then((d) => { S.rooms = d.rooms; renderLobby(); }).catch(() => {});
    if (btn.dataset.view === 'fighters') renderFighters();
    if (btn.dataset.view === 'live') renderRoomBar();
    if (btn.dataset.view === 'board') loadBoard(document.querySelector('#trackSwitch .active').dataset.track);
    if (btn.dataset.view === 'replay') {
      api('/api/matches').then((d) => {
        S.recent = d.matches;
        renderReplayList();
        if (!S.replay.matchId && S.recent.length) selectReplay(S.recent[0].matchId);
      });
    }
    if (btn.dataset.view === 'connect') {
      $('mcpConfig').textContent = '{\n  "mcpServers": {\n    "afl": {\n      "url": "' + location.origin + '/mcp"\n    }\n  }\n}';
    }
  });
  $('trackSwitch').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    document.querySelectorAll('#trackSwitch button').forEach((b) => b.classList.toggle('active', b === btn));
    loadBoard(btn.dataset.track);
  });
  for (const [id, key] of [
    ['toggleBoxes', 'showBoxes'], ['toggleBones', 'showBones'], ['toggleFx', 'showFx'],
    ['toggleRuler', 'showRuler'], ['toggleGrid', 'showGrid'],
  ]) {
    $(id).addEventListener('click', () => {
      S[key] = !S[key];
      $(id).classList.toggle('active', S[key]);
      if (S.current) { draw(ctx, S.current, S.match, stageCanvas); draw(rctx, S.current, S.match, replayCanvas); }
    });
  }
  $('replayPlay').addEventListener('click', toggleReplay);
  $('replayRange').addEventListener('input', (e) => { stopReplay(); showReplayFrame(Number(e.target.value)); });
  $('refreshMatches').addEventListener('click', () => api('/api/matches').then((d) => { S.recent = d.matches; renderReplayList(); }));
  $('createToken').addEventListener('click', createToken);
  $('copyToken').addEventListener('click', (e) => copyText($('tokenValue').textContent, e.currentTarget));
  $('copyWs').addEventListener('click', (e) => copyText($('wsValue').textContent, e.currentTarget));
  $('copyObs').addEventListener('click', (e) => copyText($('replayObs').textContent, e.currentTarget));
  $('downloadSdk').addEventListener('click', () => window.open('/sdk/agent-client.mjs', '_blank'));
  $('gotoLobby').addEventListener('click', () => document.querySelector('.nav-btn[data-view="lobby"]').click());
  $('refreshRooms').addEventListener('click', () => api('/api/rooms').then((d) => { S.rooms = d.rooms; renderLobby(); }).catch(() => {}));
  $('roomGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('.rc-watch');
    if (!btn) return;
    switchRoom(btn.dataset.room);
    document.querySelector('.nav-btn[data-view="live"]').click();
  });
  $('copyAgentPrompt').addEventListener('click', (e) => copyText($('agentPrompt').textContent, e.currentTarget));
  $('copyClientConfig').addEventListener('click', (e) => copyText($('clientConfig').textContent, e.currentTarget));
  $('toolChips').innerHTML = S.tools.map((t) => '<span>' + t + '</span>').join('');
}

async function init() {
  bindUI();
  const params = new URLSearchParams(location.search);
  if (params.get('room')) S.roomId = params.get('room');
  try {
    const st = await api('/api/state');
    S.match = st.match;
    S.board = st.leaderboard;
    S.recent = st.recentMatches || [];
    S.agents = st.agents || [];
    S.rooms = st.rooms || [];
    S.fighters = st.fighters || [];
    S.tickMs = st.server.tickMs;
    if (st.match && st.match.lastFrame) S.current = st.match.lastFrame;
    $('seasonChip').textContent = 'SEASON ' + st.server.season;
    $('footSeason').textContent = st.server.season;
    renderRoomBar();
    renderMatchHead();
    renderBoard();
    renderReplayList();
    renderLobby();
    renderFighters();
    $('mcpConfig').textContent = '{\n  "mcpServers": {\n    "afl": {\n      "url": "' + location.origin + '/mcp"\n    }\n  }\n}';
    $('codeSample').textContent = $('codeSample').textContent.replace(/ws:\/\/localhost:8787\/ws\/agent/g, (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/agent');
    $('agentPrompt').textContent = $('agentPrompt').textContent.replace(/<站点>/g, location.origin);
  } catch (e) { console.error('state load failed', e); }
  try {
    const rules = await api('/api/rules');
    S.moves = rules.moves;
    S.actions = rules.actions;
    S.rules = rules;
  } catch (e) { console.error('rules load failed', e); }
  try {
    S.configs = await api('/skills/afl-league/mcp-configs.json');
    setupClientConfig();
  } catch (e) { console.error('client configs load failed', e); }
  if (S.current) {
    $('frameLabel').textContent = 'FRAME ' + String(S.current.frame).padStart(4, '0') + ' · TICK ' + String(S.current.tick).padStart(4, '0');
  }
  loadArt((S.fighters || []).map((f) => f.id));
  draw(ctx, S.current, S.match, stageCanvas);
  draw(rctx, null, null, replayCanvas);
  requestAnimationFrame(loop);
  connect(S.roomId);
  const requestedView = params.get('view');
  if (requestedView) {
    const target = document.querySelector('.nav-btn[data-view="' + requestedView + '"]');
    if (target) target.click();
  }
  setInterval(() => {
    api('/api/state').then((st) => { $('spectatorCount').textContent = st.spectators; }).catch(() => {});
  }, 5000);
}

init();
