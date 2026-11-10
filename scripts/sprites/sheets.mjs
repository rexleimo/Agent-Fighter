/**
 * Sprite sheet specifications: what to generate and how cells map to clips.
 *
 * Every fighter is produced as five 4x4 sheets (16 frames each). A clip is a
 * list of cell indices in read order (left-to-right, top-to-bottom). Attack
 * clips carry a phase map so the runtime can align drawings to the server's
 * startup / active / recovery frames instead of guessing.
 *
 * This module is pure data + prompt strings. It is the single source of truth
 * shared by the generator (what to ask for) and the slicer (how to bake).
 */

export const GRID = 4; // 4x4 = 16 cells per sheet
export const CELL_COUNT = GRID * GRID;

/**
 * Clip cell maps. Attack clips: 4 drawings = windup, extend, impact, recover.
 * The phase arrays index INTO the clip's own frame list.
 */
export const SHEETS = {
  base: {
    clips: {
      idle: { cells: [0, 1, 2, 3], loop: true, fps: 6 },
      walk: { cells: [4, 5, 6, 7], loop: true, fps: 10 },
      crouch: { cells: [8, 9] },
      guard: { cells: [10, 11] },
      jump: { cells: [12, 13, 14, 15] },
    },
  },
  react: {
    clips: {
      hitstun: { cells: [0, 1] },
      knockdown: { cells: [2, 3] },
      getup: { cells: [4, 5] },
      dash: { cells: [6, 7, 8, 9], phases: { startup: [0], active: [1, 2], recovery: [3] } },
      throw: { cells: [10, 11, 12, 13], phases: { startup: [0], active: [1, 2], recovery: [3] } },
      blockstun: { cells: [14] },
      wakeup: { cells: [15] },
    },
  },
  punch: {
    clips: {
      lp: { cells: [0, 1, 2, 3], phases: { startup: [0], active: [1, 2], recovery: [3] } },
      mp: { cells: [4, 5, 6, 7], phases: { startup: [0], active: [1, 2], recovery: [3] } },
      hp: { cells: [8, 9, 10, 11], phases: { startup: [0], active: [1, 2], recovery: [3] } },
      dp: { cells: [12, 13, 14, 15], phases: { startup: [0], active: [1, 2], recovery: [3] } },
    },
  },
  kick: {
    clips: {
      lk: { cells: [0, 1, 2, 3], phases: { startup: [0], active: [1, 2], recovery: [3] } },
      mk: { cells: [4, 5, 6, 7], phases: { startup: [0], active: [1, 2], recovery: [3] } },
      hk: { cells: [8, 9, 10, 11], phases: { startup: [0], active: [1, 2], recovery: [3] } },
      fireball: { cells: [12, 13, 14, 15], phases: { startup: [0], active: [1, 2], recovery: [3] } },
    },
  },
  skill: {
    clips: {
      special: { cells: [0, 1, 2, 3, 4, 5], phases: { startup: [0, 1], active: [2, 3, 4], recovery: [5] } },
      ex: { cells: [6, 7, 8, 9, 10], phases: { startup: [0, 1], active: [2, 3], recovery: [4] } },
      super: { cells: [11, 12, 13, 14, 15], phases: { startup: [0, 1], active: [2, 3], recovery: [4] } },
    },
  },
};

export const SHEET_IDS = Object.keys(SHEETS);

/**
 * Native facing of each GENERATED sheet, +1 = the art faces right, -1 = left.
 * The prompt asks for "side view facing LEFT in every frame", but the model
 * disobeyed per sheet (reviewed frame-by-frame: base idle 0, react throw
 * active, punch hp active, kick hk active, skill special active). The slicer
 * mirrors every +1 sheet so all baked atlases honour the left-facing contract
 * web/sprite.js draws against; without this, most fighters rendered with their
 * back to the opponent.
 */
export const NATIVE_FACING = Object.freeze({
  abyss: { base: 1, react: -1, punch: 1, kick: 1, skill: 1 },
  basalt: { base: 1, react: 1, punch: 1, kick: 1, skill: 1 },
  cinder: { base: -1, react: -1, punch: -1, kick: -1, skill: -1 },
  coral: { base: -1, react: -1, punch: 1, kick: -1, skill: -1 },
  ember: { base: -1, react: -1, punch: -1, kick: 1, skill: 1 },
  forge: { base: -1, react: 1, punch: 1, kick: 1, skill: 1 },
  gale: { base: 1, react: 1, punch: 1, kick: 1, skill: 1 },
  girder: { base: -1, react: 1, punch: 1, kick: 1, skill: 1 },
  mist: { base: -1, react: -1, punch: 1, kick: -1, skill: -1 },
  noct: { base: 1, react: -1, punch: 1, kick: 1, skill: 1 },
  prism: { base: 1, react: 1, punch: 1, kick: 1, skill: 1 },
  pyre: { base: -1, react: -1, punch: 1, kick: -1, skill: 1 },
  quartz: { base: 1, react: 1, punch: 1, kick: 1, skill: 1 },
  slag: { base: -1, react: -1, punch: 1, kick: -1, skill: -1 },
  tide: { base: -1, react: -1, punch: 1, kick: -1, skill: -1 },
  volt: { base: -1, react: 1, punch: 1, kick: 1, skill: 1 },
});

const PREAMBLE = 'Fighting game sprite sheet on a pure white background. '
  + 'A precise EXACTLY 4-column by EXACTLY 4-row grid of 16 animation frames, read left-to-right then top-to-bottom. '
  + 'There are exactly 16 figures: 4 figures in every row and 4 figures in every column, 4 rows in total. '
  + 'The character is the SAME as in the reference image: identical costume, armor, colors, body proportions '
  + 'and painterly art style in every frame. Full body side view facing LEFT in every frame. '
  + 'Every cell is exactly the same size; the character is drawn at the same scale in every cell, '
  + 'feet on the same ground baseline, horizontally centered so the hips stay over the same spot. '
  + 'No grid lines, no borders, no text, no numbers, no labels, no watermark, no background scenery. '
  + 'Pure white background in every cell, clean empty white margins between cells. '
  + 'Every cell contains exactly ONE complete figure: never two figures in one cell, never a half figure, '
  + 'and never an empty cell. '
  + 'CRITICAL: each frame\'s character and every effect fit completely INSIDE their own square cell, '
  + 'with a wide empty white margin on all four sides — no limb, flame, debris or effect may touch, '
  + 'reach across or overlap a neighbouring cell. ';

const BODY_PROMPTS = {
  base: PREAMBLE
    + 'Frames 1-4: idle fighting stance, a subtle breathing loop (chest and fists rise and fall slightly). '
    + 'Frames 5-8: a walk cycle stepping forward to the left, four distinct leg positions. '
    + 'Frames 9-10: crouching low — frame 9 dropping down, frame 10 holding the low crouch. '
    + 'Frames 11-12: blocking guard — both forearms raised in front of the face and chest, frame 11 raising, frame 12 holding the block. '
    + 'Frames 13-16: a vertical jump — frame 13 launch crouch, frame 14 rising with knees tucked, frame 15 apex, frame 16 falling with legs extending to land.',
  react: PREAMBLE
    + 'Frames 1-2: taking a hit — head and torso snapped backward in pain, arms flung slightly out. '
    + 'Frames 3-4: knocked down — frame 3 the character tipping backward off the feet, body still upright and vertical, '
    + 'knees buckling, arms up; frame 4 the character lying flat on the ground on the back, body fully horizontal. '
    + 'Frames 5-6: getting up — frame 5 pushing up off the ground, frame 6 rising to a crouch. '
    + 'Frames 7-10: a fast forward dash to the left — body leaning low and forward, legs in a running blur, four stages of the dash. '
    + 'Frames 11-14: a throw — frame 11 reaching forward with both hands, frame 12 grabbing, frame 13 lifting the imaginary opponent overhead, frame 14 slamming them down. '
    + 'Frame 15: block impact — guarding pose pushed back slightly, forearms absorbing a blow. '
    + 'Frame 16: standing back up tall in a ready stance after waking up.',
  punch: PREAMBLE
    + 'Frames 1-4: a quick light jab with the front fist — guard, fist extended straight, fist snapping back, return to guard. '
    + 'Frames 5-8: a medium straight punch — windup with fist pulled back, arm extending, full extension impact, recover to guard. '
    + 'Frames 9-12: a heavy haymaker — big windup with torso twisted back, powerful lunging punch with full body weight, impact follow-through, recover. '
    + 'Frames 13-16: a rising dragon uppercut — frame 13 crouch with fist low, frame 14 launching upward with fist raised overhead, frame 15 airborne at the apex, frame 16 falling back down.',
  kick: PREAMBLE
    + 'Frames 1-4: a light front kick with the front leg — knee up, foot snapping out, foot connecting, leg retracting. '
    + 'Frames 5-8: a medium roundhouse kick at mid height — windup, leg swinging, full extension impact, recover. '
    + 'Frames 9-12: a heavy high kick aimed at head height — big windup, leg rising, foot at maximum height impact, recover. '
    + 'Frames 13-16: casting an energy projectile — frame 13 both hands charged back at the hip glowing with energy, frame 14 hands thrusting forward, frame 15 a glowing energy orb leaving the palms, frame 16 recovering to guard.',
};

/**
 * Per-fighter skill art direction. Each entry describes the three meter moves
 * as they must READ on screen; the gameplay numbers live in the kit tables.
 * Kept here (generation-time only) so gameplay data carries no art strings.
 */
export const SKILL_ART = {
  ember: { palette: 'orange flame and gold sparks', special: 'a flaming rush punch: fist ignites, lunges forward trailing fire, flaming fist strikes', ex: 'an armored double-flame rush: body glows, charges forward behind two burning fists, fiery impact burst', super: 'a flaming combo finisher: ignition flash, a rapid three-punch flurry with fire explosions, final rising uppercut burst' },
  cinder: { palette: 'orange flame and amber embers', special: 'a two-hit burning claw swipe: leap forward, slash twice with flaming claws', ex: 'a three-hit aerial flame claw: rises into the air, three flaming slashes, lands', super: 'a five-hit ember storm: spins into a whirlwind of burning feathers, rapid slashes, final dive' },
  pyre: { palette: 'orange flame and gold sparks', special: 'a advancing flame wave: sweeps the arm forward and sends a low wave of fire along the ground', ex: 'a double flame wave: two successive waves of fire roll forward', super: 'a fire eruption: slams the ground and a wide pillar of flame erupts ahead' },
  slag: { palette: 'molten orange and hot white heat', special: 'a molten counter stance: raises a glowing forearm, absorbs a blow and answers with a heavy molten backfist', ex: 'an armored molten counter: body turns to glowing slag, absorbs a hit and returns a heavier burning strike', super: 'a furnace counter: catches a blow and detonates a massive molten explosion at point blank' },
  tide: { palette: 'blue water and white foam', special: 'a water orb: gathers a sphere of water and launches it forward', ex: 'two staggered water orbs fired one after another', super: 'a massive tidal beam: both hands push out a huge horizontal beam of crashing water' },
  mist: { palette: 'teal mist and pale cyan light', special: 'a low mist slide: drops low and slides forward with two quick watery slashes at the legs', ex: 'a three-hit low mist combo: slides in low, three rapid slashes at ankle height', super: 'a five-hit fog flurry: vanishes into mist, five low slashes from alternating sides, reappears' },
  coral: { palette: 'pink coral and warm white light', special: 'a reef counter stance: raises a coral-guarded forearm, absorbs a blow and answers with a ringing palm strike', ex: 'an armored reef counter: coral armor glows, absorbs a hit and returns a stronger palm', super: 'a reef reflection counter: catches a blow and reflects it as a huge ring of coral energy' },
  abyss: { palette: 'deep blue water and black shadow', special: 'a deep-pressure advancing palm: steps in deep and drives a heavy palm forward with dark water trailing', ex: 'an armored abyss charge: shoulders forward behind a wall of dark water, heavy impact', super: 'an abyssal burial combo: a crushing multi-hit pressure sequence that drives the opponent backward' },
  basalt: { palette: 'grey stone dust and warm gold sparks', special: 'a stone counter stance: crosses armored forearms, absorbs a blow and answers with a granite backfist', ex: 'a fortress counter: body turns to dark stone, absorbs a hit and returns a crushing stone strike', super: 'a mountain-break counter: catches a blow and splits the ground with a massive stone fist' },
  quartz: { palette: 'white crystal light and cyan refraction', special: 'a prism orb: focuses a crystal of light and fires it forward', ex: 'two staggered prism orbs fired one after another', super: 'a judgment beam: a wide horizontal beam of refracted light from both hands' },
  forge: { palette: 'molten gold and amber heat', special: 'a heavy hammer fist: raises a glowing metal fist overhead and slams it down with armored weight', ex: 'a heavier armored hammer slam: two tons of glowing metal crash down', super: 'a meteor forge finisher: leaps and slams the ground like a falling meteor, shockwave of molten metal' },
  girder: { palette: 'pale steel green and white structural light', special: 'a steel beam shot: thrusts a staff forward and fires a narrow bolt of structural energy', ex: 'two rapid steel bolts fired in sequence', super: 'a fortress beam: plants the staff and projects a huge horizontal girder of energy' },
  volt: { palette: 'violet lightning and gold sparks', special: 'a lightning uppercut: crouches then rises with a fist wrapped in lightning, invulnerable ascent', ex: 'a stronger thunder uppercut: rises higher trailing a bolt of lightning', super: 'a sky-punishment bolt: calls down a massive lightning pillar while rising through it' },
  gale: { palette: 'green wind and pale teal gusts', special: 'a wind dash strike: dashes forward in a blur of green wind and slashes twice', ex: 'a three-hit gale dash: faster dash, three wind slashes', super: 'a six-hit storm flurry: becomes a whirlwind, six rapid slashes from all directions, final gust' },
  noct: { palette: 'deep indigo shadow and cold blue blade light', special: 'a shadow counter stance: melts into shadow, absorbs a blow and reappears behind with a dark blade strike', ex: 'a deeper shadow counter: longer shadow vanish, heavier returning blade', super: 'a shadow burial counter: sinks into darkness and erupts with a massive multi-hit shadow strike' },
  prism: { palette: 'rainbow refracted light and violet prism glow', special: 'a refracting uppercut: rises through a prism of light, fist scattering rainbow shards', ex: 'a stronger prism rise: higher ascent, more shards', super: 'a kaleidoscope burst: rises into a giant prism that explodes into a storm of light shards' },
};

export function skillPrompt(fighterId) {
  const art = SKILL_ART[fighterId];
  if (!art) throw new Error('no skill art for ' + fighterId);
  return PREAMBLE
    + 'LAYOUT — the 4 rows have fixed jobs: Row 1 = frames 1-4, Row 2 = frames 5-8, '
    + 'Row 3 = frames 9-12, Row 4 = frames 13-16. '
    + 'Row 1 (frames 1-4) is the SPECIAL MOVE: frame 1 coils up to begin, frame 2 winds up deeper with the energy already glowing, '
    + 'frame 3 starts the strike, frame 4 continues the strike. The special move is ' + art.special + '. '
    + 'Row 2 (frames 5-8) finishes the special and starts the EX MOVE: frame 5 the special strike at full extension, '
    + 'frame 6 recovering to guard, frame 7 the EX windup with a bright glow, frame 8 the EX windup deepening. '
    + 'The EX MOVE is ' + art.ex + '. '
    + 'Row 3 (frames 9-12) is the EX strike and the super windup: frame 9 the EX strike, frame 10 the EX strike at full power, '
    + 'frame 11 the EX recovery, frame 12 the SUPER windup with a dramatic flash. '
    + 'Row 4 (frames 13-16) is the SUPER MOVE: frame 13 a second dramatic windup, frame 14 the explosive strike, '
    + 'frame 15 the final explosive strike, frame 16 the recovery. The SUPER MOVE is ' + art.super + '. '
    + 'Energy effects match the character\'s own palette and element: ' + art.palette + '. '
    + 'Keep every energy effect COMPACT and fully inside its own cell: short flames and glows hugging the fists, '
    + 'shoulders and feet, at most a third of the cell width, with no long horizontal streaks, no trails, '
    + 'no flying debris and nothing that touches or crosses into a neighbouring cell.';
}

export function promptFor(sheetId, fighterId) {
  if (sheetId === 'skill') return skillPrompt(fighterId);
  const p = BODY_PROMPTS[sheetId];
  if (!p) throw new Error('unknown sheet: ' + sheetId);
  return p;
}