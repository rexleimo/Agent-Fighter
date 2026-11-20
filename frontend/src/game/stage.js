/**
 * Imperative canvas renderer extracted from the legacy app. React owns the
 * page and HUD; this module only paints the authoritative frame into a canvas.
 *
 * The implementation is split into responsibility-scoped modules under
 * `./stage/`. This file remains the public entry point: `createStageRenderer`
 * is the only export and its signature/returned API are unchanged.
 */
import { createFx } from '@web/fx.js';
import { createImpactFx } from '@web/impact-fx.js';
import { createKoCinematic } from '@web/ko-cinematic.js';
import { play as playSound } from '@web/audio.js';
import { ART, COLOR_A, COLOR_B, GROUND, ACTION_LABEL } from './stage/shared.js';
import { installArt } from './stage/art.js';
import { installPose } from './stage/pose.js';
import { installBody } from './stage/body.js';
import { installOverlay } from './stage/overlay.js';
import { installScene } from './stage/scene.js';

export function createStageRenderer({ view, stageCanvas, replayCanvas }) {
  const S = view;
  const ctx = { S, ART, stageCanvas, replayCanvas, GROUND, COLOR_A, COLOR_B, ACTION_LABEL };

  // Install in dependency order: art -> pose -> body -> overlay -> scene.
  // Cross-module calls resolve through ctx at call time, so no behaviour
  // depends on installation order beyond the destructured dependencies.
  Object.assign(ctx, installArt(ctx));
  Object.assign(ctx, installPose(ctx));
  Object.assign(ctx, installBody(ctx));
  Object.assign(ctx, installOverlay(ctx));

  const fxLabel = (side, moveId, match) => (
    ['special', 'ex', 'super'].includes(moveId) ? ctx.skillName(side, moveId, match) : ctx.label(moveId)
  );
  const stageFx = createFx({ colors: { a: COLOR_A, b: COLOR_B }, labelFor: fxLabel });
  const replayFx = createFx({ colors: { a: COLOR_A, b: COLOR_B }, labelFor: fxLabel });
  const impactFx = {
    stage: createImpactFx({ labelFor: fxLabel, plainLabel: ctx.label, onSound: playSound, enabled: () => S.showFx, ground: GROUND }),
    replay: createImpactFx({ labelFor: fxLabel, plainLabel: ctx.label, onSound: null, enabled: () => S.showFx, ground: GROUND }),
  };
  // KO presentation owns its own wall-clock sequence. It fires on the KO event
  // itself — not just on a match_end whose reason is 'ko' — because a team
  // round can knock a fighter out while the match continues (its final reason
  // is 'elimination'). koTriggeredFor keeps one sequence per match id so the
  // later match_end cannot restart an animation that already played.
  ctx.stageFx = stageFx;
  ctx.replayFx = replayFx;
  ctx.impactFx = impactFx;
  ctx.koCinema = createKoCinematic();

  const api = installScene(ctx);
  // repaintArt() re-enters the renderer through ctx.draw; wire it once built.
  ctx.draw = api.draw;
  return api;
}
