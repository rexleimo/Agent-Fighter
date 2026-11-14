/**
 * Blocky pixel-font wordmark in the spirit of the skills.sh hero logo.
 * Each glyph is a 5x7 bitmap rendered as crisp SVG rects; a low-opacity
 * offset echo behind it gives the retro double-strike look.
 */
const GLYPHS: Record<string, string[]> = {
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01111'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
};

export function PixelWord({ word, cell = 11, className = '' }: {
  word: string; cell?: number; className?: string;
}) {
  const chars = word.toUpperCase().split('');
  const gap = 1;
  const width = chars.length * (5 + gap) - gap;
  const height = 7;
  const rects: { x: number; y: number }[] = [];
  chars.forEach((ch, ci) => {
    const glyph = GLYPHS[ch];
    if (!glyph) return;
    glyph.forEach((row, y) => {
      row.split('').forEach((bit, x) => {
        if (bit === '1') rects.push({ x: ci * (5 + gap) + x, y });
      });
    });
  });
  const echo = 0.28;
  return (
    <svg
      className={'pixel-word ' + className}
      viewBox={`${-echo} ${-echo} ${width + echo * 2} ${height + echo * 2}`}
      width={width * cell}
      height={height * cell}
      role="img"
      aria-label={word}
      shapeRendering="crispEdges"
    >
      <g fill="currentColor" opacity="0.22" transform={`translate(${echo} ${echo})`}>
        {rects.map((r, i) => <rect key={i} x={r.x} y={r.y} width="1" height="1" />)}
      </g>
      <g fill="currentColor">
        {rects.map((r, i) => <rect key={i} x={r.x} y={r.y} width="1" height="1" />)}
      </g>
    </svg>
  );
}
