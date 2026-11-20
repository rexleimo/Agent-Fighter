/**
 * HUD-style overlays: frame bars, box legend and the end-of-match card.
 * Extracted from stage.js without changing any drawing behaviour.
 */
import { PHASE_LABEL } from './shared.js';

export function installOverlay(ctx) {
  const { S, label, fighterDef } = ctx;

function skillName(side, moveId, match) {
  const def = fighterDef(side, match);
  const sk = def && def.skills && def.skills.find((s) => s.id === moveId);
  return sk ? sk.name : label(moveId);
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

function drawResult(c, w, h, match) {
  const result = S.lastResult;
  if (!result) return;
  const m = match || S.match;
  const winner = result.winnerName
    || (result.winner === 'a' ? m && m.a && m.a.name : result.winner === 'b' ? m && m.b && m.b.name : '')
    || '—';
  const ko = result.reason === 'ko';
  c.save();
  c.fillStyle = 'rgba(4,8,14,.60)';
  c.fillRect(0, 0, w, h);
  c.textAlign = 'center';
  c.font = '800 52px ui-monospace, monospace';
  c.lineWidth = 6;
  c.strokeStyle = 'rgba(5,10,16,.92)';
  const title = ko ? 'K.O.' : 'TIME UP';
  c.strokeText(title, w / 2, h / 2 - 22);
  c.fillStyle = ko ? '#ffd166' : '#9fd0ff';
  c.fillText(title, w / 2, h / 2 - 22);
  c.font = '600 18px ui-monospace, monospace';
  c.fillStyle = '#e7eef6';
  c.fillText(winner + ' 获胜', w / 2, h / 2 + 28);
  c.font = '11px ui-monospace, monospace';
  c.fillStyle = 'rgba(190,210,230,.62)';
  c.fillText('下一局即将开始 · 可在大厅或回放中继续观看', w / 2, h / 2 + 54);
  c.restore();
}

  return { skillName, drawFrameBar, drawBoxLegend, drawResult };
}
