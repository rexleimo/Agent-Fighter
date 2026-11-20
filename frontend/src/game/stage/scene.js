/**
 * Main scene painter and the renderer's public API.
 * Extracted from stage.js without changing any drawing behaviour.
 */
export function installScene(ctx) {
  const {
    S, stageCanvas, stageFx, replayFx, impactFx, koCinema, ART, GROUND,
    poly, loadStageArtwork, drawStageArt, drawStageLayers, fighterDef,
    drawFighter, drawFrameBar, drawBoxLegend, drawResult,
    ensureMatchFighters, loadFighter, matchFighterIds,
  } = ctx;

  let seenResult = null;
  let pendingKo = null;
  let koTriggered = false;
  let trackedMatchId = null;

  function triggerKo(winner, winnerName, isStage) {
    if (!isStage || !winner || koTriggered) return;
    koTriggered = true;
    const accent = winner === 'b' ? '#7aa2ff' : '#49e0b0';
    koCinema.trigger({ reason: 'ko', winner, winnerName: winnerName || '—' }, accent);
  }

function draw(c, frame, match, canvas) {
  S.lastDraw = { ctx: c, frame, match, canvas };
  const w = canvas.width;
  const h = canvas.height;
  const fx = canvas === stageCanvas ? stageFx : replayFx;
  fx.observe(frame);
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, w, h);
  // Impact shake: a short zoom plus a jolt, so the frame edges never show
  // a gap while the scene is displaced.
  const sh = S.showFx && frame ? fx.shake(frame) : { x: 0, y: 0, amp: 0 };
  if (sh.x || sh.y) {
    // Zoom off the impulse envelope, never off the noise sample: deriving it
    // from |x|+|y| put the whole frame between 1.00 and 1.05 by chance on
    // neighbouring frames, which reads as the fighters themselves swelling
    // and shrinking on every link of a combo rather than the camera kicking.
    const zoom = 1 + Math.min(0.03, sh.amp * 0.0028);
    c.translate(w / 2, h / 2);
    c.scale(zoom, zoom);
    c.translate(-w / 2, -h / 2);
    c.translate(sh.x, sh.y);
  }
  // The arena comes from the match record. When the record predates stage
  // tracking (older replays) `stage` is absent and the neutral arena is the
  // honest reading of "we do not know which arena this was", not a guess.
  const stageId = (match && match.stage) || 'stage_main';
  loadStageArtwork(stageId);
  const artStage = drawStageArt(c, w, h, stageId);
  // Declare which branch actually painted the background. A pixel statistic
  // cannot carry this gate any more: across the five arenas the sampled band
  // measured 34 to 249 buckets, while the procedural fallback measured 5 to 18,
  // so any single threshold either false-fails a real arena or false-passes a
  // fallback. The renderer knows the truth; let it say so.
  //
  // Write only on change. Assigning the same string to a dataset key still
  // queues an attribute-mutation record, so declaring this every frame cost
  // ~217 DOM mutations/second (measured: 5/s before stages existed) and forced
  // style invalidation on the very element being repainted 60 times a second.
  // The arena changes at match transitions, not per frame - so this now fires
  // a handful of times per match while still declaring the truth every frame.
  if (canvas && canvas.dataset) {
    const d = canvas.dataset;
    const mode = artStage ? 'art' : 'procedural';
    const failed = ART.stageFailed ? '1' : '0';
    const matchId = (match && match.matchId) || '';
    if (d.stageMode !== mode) d.stageMode = mode;
    if (d.stageDeclared !== stageId) d.stageDeclared = stageId;
    if (d.stageFailed !== failed) d.stageFailed = failed;
    if (d.stageMatch !== matchId) d.stageMatch = matchId;
  }
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
  // Weather / light / parallax over whichever plate was painted, driven by the
  // match seed so a replay of this match reproduces the same particle field.
  drawStageLayers(c, w, h, S.stageRegistry && S.stageRegistry[stageId],
    match && match.seed, match && match.tick);
  const mode = (match && match.mode) || 'demo';
  const arenaName = (S.stageRegistry && S.stageRegistry[stageId] && S.stageRegistry[stageId].label)
    || (stageId === 'stage_main' ? 'NEON ARENA' : null);
  const stage = mode === 'ranked' ? 'RANKED ARENA' : mode === 'scrim' ? 'PRIVATE SCRIM' : 'NEUTRAL GRID';
  const technical = S.showBoxes || S.showBones || S.showRuler || S.showGrid;
  if (technical) {
    c.font = '10px ui-monospace, monospace';
    c.fillStyle = 'rgba(138,156,176,.45)';
    c.textAlign = 'left';
    // The arena the match record named, not a fixed "STAGE 01": with five
    // arenas in the league that number would be a caption on the wrong picture.
    c.fillText((arenaName || 'ARENA UNRECORDED') + ' / ' + stage
      + (ART.stageFailed ? ' / PLATE FALLBACK' : ''), 52, 62);
    c.textAlign = 'right';
    c.fillText('SERVER-AUTHORITATIVE · 60 FPS', 908, 62);
    c.textAlign = 'left';
  }

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

  impactFx[canvas === stageCanvas ? 'stage' : 'replay'].draw(c, frame, match, w, h);
  if (technical) {
    drawFrameBar(c, frame.a, 52, h - 34, 320, 'a', match);
    drawFrameBar(c, frame.b, w - 52 - 320, h - 34, 320, 'b', match);
    drawBoxLegend(c, w);
  }
  // The counter is HUD, not scenery: it must not ride the impact shake.
  c.setTransform(1, 0, 0, 1, 0, 0);
  if (S.showFx) fx.draw(c, frame, match, w);
  const matchId = match && match.matchId;
  if (matchId && matchId !== trackedMatchId) {
    // A genuinely new match: clear the previous presentation state. match_end
    // reuses the id, so this does NOT wipe a cinematic that just fired on the
    // KO event a moment earlier.
    trackedMatchId = matchId;
    koTriggered = false;
    pendingKo = null;
    seenResult = null;
    koCinema.reset();
  }

  if (S.lastResult && (!match || S.lastResult.matchId === match.matchId)
      && S.lastResult !== seenResult) {
    seenResult = S.lastResult;
    if (S.lastResult.reason === 'ko') {
      triggerKo(S.lastResult.winner, S.lastResult.winnerName, canvas === stageCanvas);
    }
  }
  if (pendingKo && !koTriggered) {
    const wnr = pendingKo.winner;
    const name = wnr === 'a' ? match?.a?.name : wnr === 'b' ? match?.b?.name : null;
    triggerKo(wnr, name || (wnr === 'a' ? 'A' : wnr === 'b' ? 'B' : '—'), canvas === stageCanvas);
  }

  if (koCinema.hasResult()) {
    // A team round has no lastResult: once the sequence settles, drop the end
    // card so it cannot sit on top of the next round — and allow the next
    // round's KO to fire a fresh sequence.
    if (koCinema.isActive() || S.lastResult) koCinema.draw(c, w, h);
    else {
      koCinema.reset();
      koTriggered = false;
      pendingKo = null;
    }
  } else if (S.lastResult && (!match || S.lastResult.matchId === match.matchId)) {
    drawResult(c, w, h, match);
  }
}

// The server streams one snapshot per simulation frame (60/s). Playback is
// paced by wall time, not by rAF: one snapshot per animation frame only works
// at exactly 60 Hz. On a 120 Hz panel it ran the match at double speed and
// then sat empty half of every tick, and a dropped frame left the queue to be
// skipped wholesale — both read as the fighters twitching.

  function replayImpactWindow(index) {
    const window = [];
    const from = Math.max(0, index - impactFx.replay.windowTicks);
    for (let i = from; i <= index; i += 1) {
      const tk = S.replay && S.replay.ticks ? S.replay.ticks[i] : null;
      if (tk && tk.events) window.push(tk.events);
    }
    return window;
  }

  return {
    draw,
    drawResult,
    ensureMatchFighters,
    loadStageArtwork,
    loadFighter,
    matchFighterIds,
    resetFx() {
      stageFx.reset();
      replayFx.reset();
      impactFx.stage.reset();
      impactFx.replay.reset();
      // The KO cinematic is lifecycle-managed by match id in draw(): match_end
      // reuses the id and must not cut short a sequence that just played.
    },
    ingestLiveEvents(events) {
      stageFx.ingest(events);
      impactFx.stage.ingest(events);
      if (!pendingKo) {
        for (const e of events || []) {
          if (e.type === 'ko') { pendingKo = { winner: e.winner }; break; }
        }
      }
    },
    isKoCinemaActive() {
      return koCinema.isActive();
    },
    observeReplay(frame, events) {
      replayFx.observe(frame, events);
    },
    replaceReplayImpact(index) {
      impactFx.replay.replace(replayImpactWindow(index));
    },
  };
}
