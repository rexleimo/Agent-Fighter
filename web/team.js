/**
 * Team elimination (3v3) presentation layer: roster strip, intermission
 * banner, round toasts and the lobby exhibition picker. The server owns all
 * rules; this module only projects broadcasts and posts the exhibition form.
 */
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const $ = (id) => document.getElementById(id);

export function createTeamUI({ state, switchRoom, goLive, log }) {
  let team = null;
  let imTimer = null;
  let imDeadline = 0;
  let toastTimer = null;
  const exPicks = { a: [], b: [] };
  let exSig = '';
  let exBound = false;

  const fighter = (id) => state.fighters.find((f) => f.id === id) || null;
  const code = (id) => { const f = fighter(id); return f ? f.code : String(id || '').toUpperCase(); };
  const name = (id) => { const f = fighter(id); return f ? f.name : id; };
  const color = (id) => { const f = fighter(id); return (f && f.palette && f.palette.base) || '#8ea3b8'; };

  /* ---------------------------------------------------------- roster strip */
  function slotHtml(side, entry, status) {
    const id = entry.fighterId;
    const hp = status === 'fallen' ? 0 : entry.hp;
    const stateLabel = status === 'active' ? '在场' : status === 'bench' ? '替补' : '阵亡';
    return '<div class="ts-slot ' + status + '" data-side="' + side + '" style="--slot-color:' + color(id) + '">'
      + '<span class="ts-code mono">' + esc(code(id)) + '</span>'
      + '<span class="ts-name">' + esc(name(id)) + '</span>'
      + '<div class="ts-hp"><i style="width:' + Math.max(0, Math.min(100, hp / 10)) + '%"></i></div>'
      + '<span class="ts-hp-num mono">' + hp + '</span>'
      + '<span class="ts-state">' + stateLabel + '</span>'
      + '</div>';
  }

  function sideHtml(side) {
    const s = team[side];
    const slots = s.order.map((e, i) => slotHtml(side, e, i === 0 ? 'active' : 'bench'));
    for (const id of s.fallen) slots.push(slotHtml(side, { fighterId: id, hp: 0 }, 'fallen'));
    return '<div class="ts-side ts-' + side + '">'
      + '<div class="ts-side-head"><span class="ts-side-tag">' + (side === 'a' ? 'SIDE A' : 'SIDE B') + '</span>'
      + '<span class="ts-alive">存活 <b>' + s.alive + '</b> / 3</span></div>'
      + '<div class="ts-slots">' + slots.join('') + '</div></div>';
  }

  function renderStrip() {
    const el = $('teamStrip');
    const round = $('roundLabel');
    if (!team) {
      el.hidden = true;
      if (round) round.textContent = '第 1 局';
      return;
    }
    el.hidden = false;
    el.innerHTML = '<div class="ts-title"><span class="ts-format">TEAM ELIMINATION · 3v3 组队淘汰赛</span>'
      + '<span class="ts-rule">全队阵亡即败 · 胜者回血 15% · 回合间各一次换人</span></div>'
      + '<div class="ts-sides">' + sideHtml('a') + '<div class="ts-vs mono">VS</div>' + sideHtml('b') + '</div>';
    if (round) round.textContent = team.over ? '完赛' : '回合 ' + team.round + ' / ' + team.maxRounds;
  }

  function onTick(msg) {
    if (!team || !msg.hud) return;
    for (const side of ['a', 'b']) {
      const slot = document.querySelector('.ts-slot.active[data-side="' + side + '"]');
      if (!slot) continue;
      const hp = msg.hud[side].hp;
      slot.querySelector('.ts-hp i').style.width = Math.max(0, Math.min(100, hp / 10)) + '%';
      slot.querySelector('.ts-hp-num').textContent = hp;
    }
  }

  /* ------------------------------------------------------------- toasts */
  function toast(html) {
    const el = $('teamToast');
    el.innerHTML = html;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3400);
  }

  /* ------------------------------------------------------- intermission */
  function hideIntermission() {
    clearInterval(imTimer);
    imTimer = null;
    $('teamIntermission').hidden = true;
  }

  function lockChip(side, locked, order) {
    const ids = order ? order.map(code).join(' → ') : '';
    return '<span class="ti-lock ' + (locked ? 'locked' : '') + '" data-side="' + side + '">'
      + (side === 'a' ? 'A' : 'B') + ' 方 ' + (locked ? '已锁定' + (ids ? ' · ' + esc(ids) : '') : '选择中…') + '</span>';
  }

  function showIntermission({ round, ms, locked = {}, orders = {} }) {
    const el = $('teamIntermission');
    imDeadline = Date.now() + ms;
    el.innerHTML = '<div class="ti-card">'
      + '<div class="ti-kicker mono">INTERMISSION</div>'
      + '<div class="ti-title">第 ' + round + ' 回合结束 · 换人窗口</div>'
      + '<div class="ti-count mono" id="tiCount">—</div>'
      + '<div class="ti-locks">' + lockChip('a', locked.a, orders.a) + lockChip('b', locked.b, orders.b) + '</div>'
      + '<p class="ti-note">双方 Agent 各有一次调整出场顺序的机会（存活角色重新排序，首位下场出战）；超时未提交保持原序。人类只能观战。</p>'
      + '</div>';
    el.hidden = false;
    clearInterval(imTimer);
    const tickCount = () => {
      const left = Math.max(0, imDeadline - Date.now());
      const c = $('tiCount');
      if (c) c.textContent = left > 0 ? (left / 1000).toFixed(1) + 's' : '等待下一回合…';
    };
    tickCount();
    imTimer = setInterval(tickCount, 200);
  }

  function onIntermission(msg) {
    if (msg.team) { team = msg.team; renderStrip(); }
    showIntermission({ round: msg.round, ms: msg.deadlineMs || msg.remainingMs || 8000, locked: msg.locked || {} });
  }

  function onOrderLocked(msg) {
    const chip = document.querySelector('.ti-lock[data-side="' + msg.side + '"]');
    if (chip) chip.outerHTML = lockChip(msg.side, true, msg.order);
    const other = document.querySelector('.ti-lock:not(.locked)');
    if (!other) {
      const c = $('tiCount');
      if (c) c.textContent = '顺序已锁定';
    }
  }

  /* ------------------------------------------------------ round lifecycle */
  function sync(match) {
    team = match && match.format === 'team' ? match.team : null;
    renderStrip();
    if (match && match.intermission) {
      showIntermission({
        round: match.intermission.round,
        ms: match.intermission.remainingMs,
        locked: match.intermission.locked,
      });
    } else {
      hideIntermission();
    }
  }

  function onRoundStart(msg) {
    team = msg.team;
    renderStrip();
    hideIntermission();
    const cur = team ? [team.a.current, team.b.current] : [null, null];
    toast('<b>ROUND ' + msg.round + '</b> ' + esc(code(cur[0])) + ' ' + esc(name(cur[0]))
      + ' <span class="tt-vs">VS</span> ' + esc(code(cur[1])) + ' ' + esc(name(cur[1])));
  }

  function onRoundEnd(msg) {
    team = msg.team;
    renderStrip();
    const s = msg.summary;
    const parts = ['<b>回合 ' + s.round + ' 结束</b>'];
    for (const e of s.eliminated) parts.push(esc((e.side === 'a' ? 'A' : 'B') + ' 方 ' + code(e.fighterId) + ' 阵亡'));
    if (s.healed && s.healed.amount > 0) parts.push(esc((s.healed.side === 'a' ? 'A' : 'B') + ' 方 ' + code(s.healed.fighterId) + ' 回复 ' + s.healed.amount + ' HP'));
    if (s.matchOver) parts.push(s.matchWinner === 'draw' ? '双方全灭 · 平局' : esc((s.matchWinner === 'a' ? 'A' : 'B') + ' 方队伍胜出'));
    toast(parts.join(' · '));
    log('组队淘汰 · 回合 ' + s.round + '：' + parts.slice(1).join(' · ').replace(/<[^>]+>/g, ''), 'ev-ko');
  }

  function onMatchEnd(msg) {
    hideIntermission();
    if (msg.result && msg.result.team) {
      const w = msg.result.winner;
      toast('<b>比赛结束</b> ' + (w === 'draw' ? '双方全灭 · 平局' : esc(msg.result.winnerName || (w === 'a' ? 'A' : 'B')) + ' 的队伍胜出'));
    }
  }

  /* ---------------------------------------------------------- room cards */
  function roomBadge(r) {
    return r.format === 'team' ? '<span class="rc-format">3v3 组队</span>' : '';
  }

  function roomMeta(r) {
    if (r.format !== 'team' || !r.team) return '';
    return '<span>·</span><span>回合 ' + r.round + ' · 存活 ' + r.team.a.alive + ' v ' + r.team.b.alive + '</span>';
  }

  /* --------------------------------------------------- exhibition picker */
  function renderExhibition() {
    const el = $('teamExhibition');
    if (!el) return;
    const fighters = state.fighters || [];
    if (!fighters.length) { el.innerHTML = '<div class="empty">正在读取角色…</div>'; return; }
    const sig = fighters.map((f) => f.id).join(',');
    if (exSig === sig && el.children.length) return;
    exSig = sig;
    const side = (key) => '<div class="te-side" data-side="' + key + '">'
      + '<div class="te-side-head"><span class="te-tag">' + (key === 'a' ? 'SIDE A 队伍' : 'SIDE B 队伍') + '</span>'
      + '<span class="te-count mono" data-count="' + key + '">0 / 3</span></div>'
      + '<div class="te-picked" data-picked="' + key + '"><span class="te-empty">点击角色按出场顺序加入（1 → 2 → 3）</span></div>'
      + '<div class="te-pool">' + fighters.map((f) =>
        '<button class="te-chip" data-fighter="' + esc(f.id) + '" style="--slot-color:' + f.palette.base + '">'
        + '<i></i><span class="mono">' + esc(f.code) + '</span><span>' + esc(f.name) + '</span></button>').join('')
      + '</div></div>';
    el.innerHTML = '<div class="panel-head"><h2>组队淘汰赛 · 展览开局</h2>'
      + '<span class="panel-note">各选 3 名角色 · 内置 Agent 代打 · 不计分 · 规则同拳皇式 3v3</span></div>'
      + '<div class="te-sides">' + side('a') + side('b') + '</div>'
      + '<div class="te-foot"><button class="primary-btn" id="teStart" disabled>开始组队对战</button>'
      + '<span class="te-note" id="teNote">双方各选 3 名不重复角色，点击已选角色可移除</span></div>';
    if (!exBound) {
      el.addEventListener('click', onExhibitionClick);
      exBound = true;
    }
    refreshExhibition();
  }

  function refreshExhibition() {
    for (const key of ['a', 'b']) {
      const picks = exPicks[key];
      const count = document.querySelector('[data-count="' + key + '"]');
      const box = document.querySelector('[data-picked="' + key + '"]');
      if (count) count.textContent = picks.length + ' / 3';
      if (box) {
        box.innerHTML = picks.length
          ? picks.map((id, i) => '<button class="te-picked-chip" data-fighter="' + esc(id) + '" style="--slot-color:' + color(id) + '">'
            + '<span class="te-order mono">' + (i + 1) + '</span><span class="mono">' + esc(code(id)) + '</span>'
            + '<span>' + esc(name(id)) + '</span><i>×</i></button>').join('')
          : '<span class="te-empty">点击角色按出场顺序加入（1 → 2 → 3）</span>';
      }
      document.querySelectorAll('.te-side[data-side="' + key + '"] .te-chip').forEach((chip) => {
        chip.classList.toggle('picked', picks.includes(chip.dataset.fighter));
      });
    }
    const ready = exPicks.a.length === 3 && exPicks.b.length === 3;
    const btn = $('teStart');
    if (btn) btn.disabled = !ready;
  }

  function onExhibitionClick(e) {
    if (e.target.closest('#teStart')) { startExhibition(); return; }
    const chip = e.target.closest('.te-chip, .te-picked-chip');
    if (!chip) return;
    const sideEl = chip.closest('.te-side');
    if (!sideEl) return;
    const key = sideEl.dataset.side;
    const id = chip.dataset.fighter;
    const picks = exPicks[key];
    const at = picks.indexOf(id);
    if (at >= 0) picks.splice(at, 1);
    else if (picks.length < 3) picks.push(id);
    refreshExhibition();
  }

  async function startExhibition() {
    const note = $('teNote');
    const btn = $('teStart');
    btn.disabled = true;
    note.textContent = '正在开局…';
    try {
      const res = await fetch('/api/team-exhibition', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamA: exPicks.a, teamB: exPicks.b }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.status);
      note.textContent = '房间已开打 · ' + data.roomId;
      switchRoom(data.roomId);
      goLive();
    } catch (err) {
      note.textContent = '开局失败：' + err.message;
      btn.disabled = false;
    }
  }

  return {
    sync, onTick, onRoundStart, onRoundEnd, onIntermission, onOrderLocked, onMatchEnd,
    roomBadge, roomMeta, renderExhibition,
  };
}