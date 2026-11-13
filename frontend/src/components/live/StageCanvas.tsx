import { useEffect, useRef, type MutableRefObject } from 'react';
import { createStageRenderer } from '../../game/stage.js';
import type { StageRegistry } from '../../lib/types';
import type { Fighter } from '../../lib/types';

export type ToolState = {
  showBoxes: boolean;
  showBones: boolean;
  showFx: boolean;
  showRuler: boolean;
  showGrid: boolean;
};

type Props = {
  frameQueue: MutableRefObject<any[]>;
  current: MutableRefObject<any | null>;
  match: any;
  moves: Record<string, any>;
  fighters: Fighter[];
  tools: ToolState;
  lastResult: any;
  stages: StageRegistry | null;
};

export function StageCanvas({ frameQueue, current, match, moves, fighters, tools, lastResult, stages }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<any>(null);
  const matchRef = useRef(match);
  const dirtyRef = useRef(true);
  const viewRef = useRef<any>({
    moves: {},
    fighters: [],
    current: null,
    match: null,
    lastResult: null,
    spriteTrack: { a: {}, b: {} },
    stageRegistry: null,
    ...tools,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const renderer = createStageRenderer({
      view: viewRef.current,
      stageCanvas: canvas,
      replayCanvas: document.createElement('canvas'),
    });
    rendererRef.current = renderer;
    // No stage preload here: the arena is chosen per match in draw(), so loading
    // one fixed plate at mount is what made every fight look the same venue.
    if (viewRef.current.match) renderer.ensureMatchFighters(viewRef.current.match);

    let raf = 0;
    let last = performance.now();
    let clock = 0;
    const loop = (now: number) => {
      const dt = Math.min(100, now - last);
      last = now;
      clock += dt;
      let played = 0;
      while (clock >= 1000 / 60 && frameQueue.current.length && played < 4) {
        clock -= 1000 / 60;
        played += 1;
        const frame = frameQueue.current.shift();
        if (!frame) break;
        current.current = frame;
        viewRef.current.current = frame;
        renderer.draw(ctx, frame, matchRef.current, canvas);
      }
      if (played === 0 && dirtyRef.current) {
        renderer.draw(ctx, current.current, matchRef.current, canvas);
        dirtyRef.current = false;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [current, frameQueue]);

  useEffect(() => {
    viewRef.current.moves = moves;
    dirtyRef.current = true;
  }, [moves]);

  useEffect(() => {
    viewRef.current.stageRegistry = stages;
    viewRef.current.fighters = fighters;
    dirtyRef.current = true;
  }, [fighters, stages]);

  useEffect(() => {
    Object.assign(viewRef.current, tools);
    dirtyRef.current = true;
  }, [tools]);

  useEffect(() => {
    viewRef.current.match = match;
    matchRef.current = match;
    viewRef.current.lastResult = lastResult;
    if (match?.lastFrame) {
      current.current = match.lastFrame;
      viewRef.current.current = match.lastFrame;
    }
    rendererRef.current?.ensureMatchFighters(match);
    rendererRef.current?.resetFx();
    dirtyRef.current = true;
  }, [match, lastResult, current]);

  return <canvas id="stage" ref={canvasRef} width={960} height={530} />;
}
