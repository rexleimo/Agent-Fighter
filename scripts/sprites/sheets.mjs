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
 * Facing review ledger — one entry per generated sheet, read off the drawings.
 *
 * The prompt asks for "side view facing LEFT in every frame" and the model
 * disobeyed sheet by sheet, so the bake mirrors the frames that came back
 * right-facing to honour the left-facing contract web/sprite.js draws against.
 * Without this table most fighters render with their back to the opponent.
 *
 * No pixel method can decide this. Mass skew, limb reach, skin lean, foot
 * pressure and silhouette mirror-matching were all scored against a
 * full-resolution human read of the same sheets: none cleared 70%, and
 * mirror-matching recalled 0 of the 14 frames a reviewer could name. A cape, an
 * all-warm body, a faceless helmet and a twisted leg each answer "pose" instead
 * of "orientation". So a person reads the drawings, and this table is the
 * authority. Review instrument: `node scripts/sprites/facing-sheet.mjs`.
 *
 * Reading the same sheet twice is not a formality: three passes were needed for
 * abyss, girder, noct, quartz and volt before two agreed, and every value in
 * here is backed by at least two of them. Where the passes land on different
 * frames inside one sheet, no override is recorded — a wrong override turns a
 * correct frame around, which is worse than leaving it at the sheet value.
 *
 * A cell is never read alone: knockdown, getup and dash each run over
 * consecutive cells, so a cell disagreeing with BOTH clip-mates is a mis-read
 * rather than an override. That pass retired volt/base 12-14 and noct/react 8
 * and 11. It has one hole, and the hole is on the ground. The two falling
 * frames — tipping over and lying flat — have no facing to compare with their
 * neighbours; the tell is which end the head is on, and physics fixes that end:
 * a fighter knocked backward from a left-facing stance falls with the head
 * travelling away from the opponent, so both frames ship with the head to the
 * right. Read all 16 react sheets that way, the flat frame disagreed on basalt,
 * mist and noct and the tipping frame disagreed on mist alone. noct/react 3 had
 * been added to the flip list on the neighbour argument alone and is reversed
 * here; basalt/react 3, mist/react 2 and mist/react 3 are added. Two of them
 * still report as isolated families afterwards, which is the honest result: the
 * model re-orients the body as it reaches the floor, so the ground frames
 * genuinely sit in the opposite raw family from the upright frames around them.
 * The neighbour test must therefore never be the last word on a ground frame.
 * `node scripts/verify-facing.mjs` re-checks coverage, shape and the sha each
 * entry was read against; `facing-sheet.mjs --full` re-renders a sheet at review
 * resolution and prints the sha to paste.
 *
 * Still open, ranked by the same isolated-neighbour test (a cell whose recorded
 * family differs from both clip-mates): abyss between its base and react sheets
 * (the hood void and the pauldron disagree) and quartz's pauldron, a growth on
 * BOTH shoulders and therefore the weakest landmark in the cast. The remaining
 * flagged cells — the punch-sheet travel frames and the mist/react 13-14 pair —
 * were each read at full resolution against their clip-mates and are genuine
 * alternations in the art, not ledger errors.
 *
 * Eight react sheets were redrawn on 2026-11-11 because the dash prompt asked
 * for "legs in a running blur" and the matte cannot key an opaque smear, so
 * those frames shipped half a body. The redraw came back sharp and, for
 * basalt, on the opposite raw family from its own upright frames: 9 of 16 cells
 * were left-facing art, which is the majority, so basalt/react is now
 * faces:-1 with the 7 right-facing cells listed as the exceptions. The gate
 * that caught that is `no sheet overrides half or more of its frames` — a
 * flip list that long is not an exception list, it is a wrong sheet label.
 * forge/react was redrawn whole and came back a true 4x4 facing left, which
 * retired both its row map and its off-model registration.
 *
 * faces  the orientation the majority of the sheet's frames have on screen,
 *        +1 = the art faces right, -1 = left.
 * flip   cell indexes drawn the OPPOSITE way from `faces`. The model mixes
 *        orientation inside one sheet — tide's heavy punch and cinder's came
 *        back turned around relative to their own neighbours — and a sheet-level
 *        flip cannot express that, so those frames are mirrored individually.
 *        A cell is listed only when two independent full-resolution reviews named
 *        the same cell, because a wrong entry turns a correct frame around.
 *        The overrides are not scattered: on hurt sheets they cluster on cells
 *        4-9 (basalt, gale, girder, noct, prism, quartz all name that run), and
 *        on punch sheets on cells 8-10. Both are the mid-animation travel frames,
 *        so the model appears to draw the body moving toward its target and
 *        solves the facing of the pose instead of the facing of the character.
 * sha    shortHash of the source sheet at the moment it was read. Re-generating
 *        a sheet changes it, and the bake then refuses to trust the entry until
 *        someone reads the new drawings.
 *
 * ember/kick was re-sha'd on 2026-11-12 by a ROW-level redraw, not a whole-sheet
 * re-roll: `scripts/sprites/redraw-row.mjs` replaced row 4 (the fireball) and
 * left rows 0-2 byte-identical, so the cells 5/6/9/10 overrides from the earlier
 * two-pass read still describe the drawings they were read against. The row it
 * replaced was the one frame in the cast that no flip could fix — the model drew
 * the wind-up with the head and chest turned away from the charge, so mirroring
 * the cell only moved the backwards half. That is why the redraw is scoped to
 * one row: every fighter's kick cell 12 was rendered in shipped orientation and
 * read first, and ember was the only one drawn that way.
 */
export const FACING = Object.freeze({
  'abyss/base': { faces: -1, flip: [], sha: '97ef991d13c5' },
  'abyss/react': { faces: -1, flip: [], sha: '20c26d7ab91c' },
  'abyss/punch': { faces: 1, flip: [8], sha: '7f4f121da49c' },
  'abyss/kick': { faces: 1, flip: [], sha: '2d305662e161' },
  'abyss/skill': { faces: 1, flip: [], sha: 'cdc9d6c5b1ca' },
  'basalt/base': { faces: 1, flip: [], sha: '6e11781d3dab' },
  'basalt/react': { faces: -1, flip: [0, 1, 2, 12, 13, 14, 15], sha: 'd336424dc38c' },
  'basalt/punch': { faces: 1, flip: [], sha: '1086eda4a1e0' },
  'basalt/kick': { faces: 1, flip: [], sha: '7c545867c05a' },
  'basalt/skill': { faces: 1, flip: [], sha: 'b51a85c02fda' },
  'cinder/base': { faces: -1, flip: [], sha: '296c22cdd356' },
  'cinder/react': { faces: -1, flip: [], sha: '0d3af06afbb7' },
  'cinder/punch': { faces: -1, flip: [10], sha: '6344e38522bf' },
  'cinder/kick': { faces: -1, flip: [], sha: 'fb66f1f78ba2' },
  'cinder/skill': { faces: -1, flip: [], sha: 'e9dda6d86d44' },
  'coral/base': { faces: -1, flip: [], sha: 'acceaa52e402' },
  'coral/react': { faces: -1, flip: [], sha: '44f99d148fc5' },
  'coral/punch': { faces: -1, flip: [9, 10], sha: 'b8842de1cf1b' },
  'coral/kick': { faces: -1, flip: [], sha: 'a00bd160f338' },
  'coral/skill': { faces: -1, flip: [], sha: '5420c4b3447c' },
  'ember/base': { faces: -1, flip: [], sha: '0d307e6d6ab9' },
  'ember/react': { faces: -1, flip: [], sha: '8f13c0867d49' },
  'ember/punch': { faces: -1, flip: [10], sha: '80639e3b5eb6' },
  'ember/kick': { faces: -1, flip: [5, 6, 9, 10], sha: '72ad6fe73761' },
  'ember/skill': { faces: 1, flip: [], sha: '3edc5412a089' },
  'forge/base': { faces: 1, flip: [], sha: '1efe63b80b2b' },
  'forge/react': { faces: -1, flip: [], sha: '45f215c7cc6a' },
  'forge/punch': { faces: 1, flip: [], sha: '6b746e83377c' },
  'forge/kick': { faces: 1, flip: [], sha: '37c35033adc9' },
  'forge/skill': { faces: 1, flip: [], sha: '58781ea98857' },
  'gale/base': { faces: 1, flip: [], sha: '654d5d8c5313' },
  'gale/react': { faces: 1, flip: [4, 5, 6, 7, 8, 9, 13], sha: '889ad94fd776' },
  'gale/punch': { faces: 1, flip: [], sha: '9a8a37aaacfd' },
  'gale/kick': { faces: 1, flip: [], sha: '637039fda206' },
  'gale/skill': { faces: 1, flip: [], sha: '9050d1aacd80' },
  'girder/base': { faces: -1, flip: [], sha: 'de1f0931f14d' },
  'girder/react': { faces: 1, flip: [4, 5, 6, 7, 8, 9], sha: 'e991520fa804' },
  'girder/punch': { faces: 1, flip: [], sha: '746efc050208' },
  'girder/kick': { faces: 1, flip: [8], sha: 'a4b0f3c75a49' },
  'girder/skill': { faces: 1, flip: [], sha: 'ef0df08c275f' },
  'mist/base': { faces: -1, flip: [], sha: '4656950af903' },
  'mist/react': { faces: -1, flip: [0, 1, 2, 3, 13, 15], sha: '42dc82a25b92' },
  'mist/punch': { faces: -1, flip: [5, 6, 9, 10], sha: '3a85a5dd29d2' },
  'mist/kick': { faces: -1, flip: [], sha: 'fc5b51cb5a2e' },
  'mist/skill': { faces: -1, flip: [], sha: '20c1592da4bb' },
  'noct/base': { faces: 1, flip: [], sha: 'a14abaf85309' },
  'noct/react': { faces: 1, flip: [4, 5, 6, 7, 8, 9], sha: '46f78e55beb5' },
  'noct/punch': { faces: 1, flip: [], sha: '08f90ac32727' },
  'noct/kick': { faces: 1, flip: [], sha: '2353b4556b34' },
  'noct/skill': { faces: 1, flip: [], sha: '5dbf2afb2805' },
  'prism/base': { faces: 1, flip: [], sha: '15e0a7a8feaa' },
  'prism/react': { faces: 1, flip: [4, 5, 6, 7], sha: '60239d279d80' },
  'prism/punch': { faces: 1, flip: [], sha: '232cb650e92a' },
  'prism/kick': { faces: 1, flip: [], sha: '1885c0ef86e9' },
  'prism/skill': { faces: 1, flip: [], sha: '3c7b358fb392' },
  'pyre/base': { faces: -1, flip: [], sha: '5eac135a6529' },
  'pyre/react': { faces: -1, flip: [], sha: 'a503339fbcfa' },
  'pyre/punch': { faces: -1, flip: [9, 10, 13, 14, 15], sha: 'cb73f0687396' },
  'pyre/kick': { faces: -1, flip: [], sha: '2b0cef97f02d' },
  'pyre/skill': { faces: 1, flip: [], sha: '48d7e8ff9bda' },
  // quartz ships on chroma sheets: the white ones drew his crystal energy in
  // white on white, so every effect frame keyed to nothing at all.
  'quartz/base': { faces: -1, flip: [], sha: 'e50789f67462' },
  'quartz/react': { faces: -1, flip: [], sha: '37f02af7d54c' },
  'quartz/punch': { faces: -1, flip: [9], sha: 'ca1ff16f0088' },
  'quartz/kick': { faces: -1, flip: [], sha: 'c77c0cb8544a' },
  'quartz/skill': { faces: -1, flip: [], sha: '5e38c2820d74' },
  'slag/base': { faces: -1, flip: [], sha: '21d75efcab2b' },
  'slag/react': { faces: -1, flip: [], sha: 'd39db88a8024' },
  'slag/punch': { faces: -1, flip: [8, 9], sha: '7af150a93481' },
  'slag/kick': { faces: -1, flip: [], sha: '54f2f4829fba' },
  'slag/skill': { faces: -1, flip: [], sha: 'f76b9cb4761c' },
  'tide/base': { faces: -1, flip: [], sha: '312fa11574e6' },
  'tide/react': { faces: -1, flip: [], sha: '18da3bf208f8' },
  'tide/punch': { faces: -1, flip: [9, 10], sha: 'cee79e99d194' },
  'tide/kick': { faces: -1, flip: [], sha: '5a1d58f8c44f' },
  'tide/skill': { faces: -1, flip: [], sha: '9d0554d0450c' },
  'volt/base': { faces: -1, flip: [], sha: 'c4056b3369e1' },
  'volt/react': { faces: 1, flip: [5, 6, 7, 8, 9, 13], sha: '3118959b596a' },
  'volt/punch': { faces: 1, flip: [], sha: '3d84650dc789' },
  'volt/kick': { faces: 1, flip: [], sha: 'b7375f6304a9' },
  'volt/skill': { faces: 1, flip: [], sha: '17226c01f548' },
});

/** The recorded read for one sheet. An unadjudicated sheet has no fallback: the
 *  bake cannot guess an orientation it was never told. */
export function facingReview(id, sheetId) {
  const entry = FACING[id + '/' + sheetId];
  if (!entry) throw new Error(`facing not adjudicated: ${id}/${sheetId}`);
  return entry;
}

/** True when this cell has to be mirrored so the atlas ships left-facing. */
export function shipsFlipped(entry, cellIndex) {
  return (entry.faces > 0) !== entry.flip.includes(cellIndex);
}

/**
 * Art-row map for the sheets the generator drew off the 4x4 contract.
 *
 * forge's kick sheet came back with five rows of four. The slicer can detect
 * the rows, but which art row answers which spec row is a property of that
 * particular drawing, not of a layout rule: kick's first four rows already
 * answer lk/mk/hk/fireball and only its fifth is filler.
 *
 * forge/react drew the same five-row way and was remapped to [0,1,2,4]; the
 * sheet was redrawn on 2026-11-11 and came back a true 4x4, so that entry is
 * gone. Only a redrawn sheet may be re-mapped — a row map is a claim about one
 * specific drawing, and it is stale the moment the drawing changes.
 *
 * Maps spec row -> art row index. An art row named by no spec row is dropped.
 */
export const ART_ROW_ORDER = Object.freeze({
  forge: { kick: [0, 1, 2, 3] },
});

/**
 * Sheets whose standing poses were drawn off-model, registered with the
 * decision that let them ship.
 *
 * The bake measures every standing pose (guard, blockstun) against the idle
 * stance and rescales the sheet by that ratio, bounded so no single measurement
 * can rewrite a pose. A sheet whose standing pose is short by more than the
 * clamp can reach still shrinks on screen when it gets hit, and only a redraw
 * closes it. Each entry states the measured residual and what redrawing would
 * cost, so the debt stays visible instead of turning into a silent per-hit size
 * pop. Unregistered sheets fail the bake.
 */
export const OFF_MODEL_ART = Object.freeze({
  // forge/react held this entry from 2026-11-03: its blockstun guard was drawn
  // crouched, 0.824 of stance height, and the bake needed permission to ship the
  // bounded rescale. The sheet was redrawn on 2026-11-11 and the guard now
  // stands on the stance baseline, so the debt is closed rather than renumbered.
  // An entry belongs here only when a MEASURED residual still exceeds the clamp.
});

/**
 * Sheets where two poses matte as ONE connected component because their
 * effects touch across a row boundary, registered with the marker count that
 * splits them.
 *
 * coral/skill measured 2026-11-11: the cell-10 body and the cell-14 ring burst
 * join petal-to-petal across y=768 into a single 281x477 component (y525-1002).
 * Centroid routing then handed the whole blob to cell 14 — a half-scale doubled
 * fighter — and left cell 10 petals-only. A horizontal cut would sever legs or
 * ring, so the split runs marker watershed: erode to the body cores, reconstruct
 * each core inside the component, and the partition falls on the petal neck.
 * The value is the number of body cores to recover; a sheet that cannot produce
 * them fails the bake instead of shipping a doubled frame. seedBelowY additionally
 * seeds the lower core only from below that row, so ring-top petals stay with the
 * ring instead of racing up the petal path to steal the boot.
 *
 * Distance watershed still cut cell-10's front boot diagonally at y729: the ring's
 * white spike fan touches the boot at y742-743, so the lower core's path up the
 * spike beat the upper core's path down the leg and the boot toe shipped as a tan
 * dome floating above cell-14's ring. claimUpper hands the measured boot extent
 * (x615-656, y715-743) back to the topmost pose. Collateral is ~30px of spike tip
 * (y742-743, x638-656) joining cell 10 as a sub-pixel glint — cheaper than a split
 * boot. A box that touches no ink fails the bake (registry drift).
 */
export const CROSS_ROW_SPLITS = Object.freeze({
  'coral/skill': {
    markers: 2,
    seedBelowY: 768,
    claimUpper: [{ x0: 613, y0: 713, x1: 658, y1: 743 }],
  },
});

/**
 * Measured head rows (sheet-space y) for cells whose effect ink fools the
 * head landmark, registered with the measurement that backs them.
 *
 * bodyExtent searches a band around the ink centroid; coral/skill cell 14's
 * ring burst drags that centroid left, so the ring top (y711) reads as the
 * head and the pose measures 290px tall — the bake would shrink the super's
 * money frame to ~0.8 of its neighbours. Scanning right of the ring (x>=715)
 * puts the helmet at y763, body 239px, in line with the clip's 238-249px.
 * An override whose row falls outside the cell's own ink fails the bake.
 */
export const BODY_HEAD_OVERRIDES = Object.freeze({
  'coral/skill': { 14: 763 },
});


export { SKILL_ART, skillPrompt, promptFor } from './sheets-prompts.mjs';
