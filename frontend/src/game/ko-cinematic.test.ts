import { describe, expect, it, vi } from 'vitest';
import { createKoCinematic } from '@web/ko-cinematic.js';

/** A canvas context stub that records paint work and full-frame rectangles. */
function stubCtx() {
  let ops = 0;
  let fill = '';
  const rects: Array<{ x: number; y: number; w: number; h: number; style: string }> = [];
  const bump = () => { ops += 1; };
  const ctx = {
    save: bump,
    restore: bump,
    set fillStyle(v: string) { fill = v; },
    get fillStyle() { return fill; },
    fillRect: (x: number, y: number, w: number, h: number) => {
      bump();
      rects.push({ x, y, w, h, style: fill });
    },
    strokeRect: bump,
    clearRect: bump,
    beginPath: bump,
    moveTo: bump,
    lineTo: bump,
    closePath: bump,
    arc: bump,
    fill: bump,
    stroke: bump,
    fillText: bump,
    strokeText: bump,
    translate: bump,
    rotate: bump,
    scale: bump,
    measureText: () => ({ width: 40 }),
    createLinearGradient: () => ({ addColorStop: bump }),
    createRadialGradient: () => ({ addColorStop: bump }),
  };
  return { ctx, count: () => ops, rects };
}

/** Alpha of the dark arena wash, if a fill uses the near-black KO colour. */
function darkAlpha(style: unknown): number {
  if (typeof style !== 'string') return 0;
  const match = style.match(/rgba\(4,\s*7,\s*12,\s*([\d.]+)\)/);
  return match ? Number(match[1]) : 0;
}

describe('KO cinematic', () => {
  it('is idle until a KO result is triggered', () => {
    const clock = { t: 0 };
    const cinema = createKoCinematic({ now: () => clock.t });
    expect(cinema.hasResult()).toBe(false);
    expect(cinema.isActive()).toBe(false);

    cinema.trigger({ reason: 'ko', winner: 'b', winnerName: 'ALPHA' });
    expect(cinema.hasResult()).toBe(true);
    expect(cinema.isActive()).toBe(true);
  });

  it('settles after the sequence and can be reset', () => {
    const clock = { t: 0 };
    const cinema = createKoCinematic({ now: () => clock.t });
    cinema.trigger({ reason: 'ko', winner: 'a' });
    clock.t = 2600;
    expect(cinema.isActive()).toBe(false);
    // The end card persists even though the animation is done.
    expect(cinema.hasResult()).toBe(true);
    cinema.reset();
    expect(cinema.hasResult()).toBe(false);
  });

  it('paints something at every phase of the sequence', () => {
    const clock = { t: 0 };
    const cinema = createKoCinematic({ now: () => clock.t });
    cinema.trigger({ reason: 'ko', winner: 'b', winnerName: 'ALPHA-7' }, '#7aa2ff');
    for (const t of [0, 90, 200, 360, 700, 1300, 2000, 3000]) {
      const { ctx, count } = stubCtx();
      clock.t = t;
      cinema.draw(ctx as unknown as CanvasRenderingContext2D, 960, 530);
      expect(count(), `t=${t}`).toBeGreaterThan(0);
    }
  });

  it('keeps the game picture visible — never a full-frame dark blackout', () => {
    const clock = { t: 0 };
    const cinema = createKoCinematic({ now: () => clock.t });
    cinema.trigger({ reason: 'ko', winner: 'a', winnerName: 'ALPHA' });
    for (const t of [0, 90, 200, 360, 700, 1300, 2000, 3000]) {
      const { ctx, rects } = stubCtx();
      clock.t = t;
      cinema.draw(ctx as unknown as CanvasRenderingContext2D, 960, 530);
      const fullFrame = rects.filter((r) => r.x === 0 && r.y === 0 && r.w === 960 && r.h === 530);
      for (const rect of fullFrame) {
        expect(darkAlpha(rect.style), `t=${t} full-frame wash too dark: ${rect.style}`).toBeLessThan(0.5);
      }
    }
  });

  it('does not paint when no result has been triggered', () => {
    const { ctx, count } = stubCtx();
    const cinema = createKoCinematic({ now: () => 0 });
    cinema.draw(ctx as unknown as CanvasRenderingContext2D, 960, 530);
    expect(count()).toBe(0);
  });

  it('defaults to wall-clock time (no now injection needed)', () => {
    const spy = vi.spyOn(performance, 'now');
    const cinema = createKoCinematic();
    cinema.trigger({ reason: 'ko', winner: 'a' });
    expect(cinema.hasResult()).toBe(true);
    spy.mockRestore();
  });
});
