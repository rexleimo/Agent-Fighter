/**
 * The kit system: five archetypes, sixteen individual kits.
 *
 * An archetype is a STRATEGY (how a fighter wants to fight); a kit is the
 * concrete move table that strategy runs on. Every fighter owns exactly one
 * kit, and no two fighters share the same move table — the whole point of
 * the roster is that `special` means something different for everyone.
 *
 *   ARCHETYPES  id -> label / blurb / tags (the strategy descriptor)
 *   FIGHTER_KITS fighterId -> { archetype, label, blurb, moves }
 *
 * `moves` holds exactly the three meter actions: special, ex, super. The
 * universal normals (light / medium / heavy punches and kicks, dp, dash,
 * throw, fireball) live in ../rules.js because every fighter shares them.
 */
import { rush } from './rush.js';
import { volley } from './volley.js';
import { counter } from './counter.js';
import { antiAir } from './antiAir.js';
import { multi } from './multi.js';

export const KIT_IDS = Object.freeze(['rush', 'volley', 'counter', 'antiAir', 'multi']);

const ARCHETYPE_LIST = Object.freeze([rush, volley, counter, antiAir, multi]);

export const ARCHETYPES = Object.freeze(
  Object.fromEntries(ARCHETYPE_LIST.map((a) => [a.id, {
    id: a.id, label: a.label, blurb: a.blurb, tags: Object.freeze([...a.tags]),
  }])),
);

function collectKits() {
  const out = {};
  for (const archetype of ARCHETYPE_LIST) {
    for (const [fighterId, kit] of Object.entries(archetype.fighters)) {
      out[fighterId] = {
        fighterId,
        archetype: archetype.id,
        label: kit.label,
        blurb: kit.blurb,
        tags: Object.freeze([...archetype.tags]),
        moves: kit.moves,
      };
    }
  }
  return Object.freeze(out);
}

export const FIGHTER_KITS = collectKits();

export const FIGHTER_KIT_IDS = Object.freeze(Object.keys(FIGHTER_KITS));

/**
 * Balance contract: damage / reach bands each kit must sit inside. The bands
 * encode the trade — rush trades reach for damage, volley trades damage for
 * range, counter trades whiff risk for the single biggest answer.
 */
export const KIT_BALANCE = Object.freeze({
  rush: { special: [100, 125], ex: [145, 175], super: [260, 310], reach: [120, 180] },
  volley: { special: [50, 80], ex: [95, 125], super: [140, 175], reach: [240, 640] },
  counter: { special: [120, 145], ex: [160, 190], super: [230, 280], reach: [120, 220] },
  antiAir: { special: [110, 130], ex: [150, 180], super: [200, 250], reach: [120, 220] },
  multi: { special: [125, 145], ex: [180, 210], super: [250, 300], reach: [150, 220] },
});

/** The three meter actions every kit must define. */
export const SKILL_ACTIONS = Object.freeze(['special', 'ex', 'super']);

export function isValidKit(id) {
  return Object.prototype.hasOwnProperty.call(ARCHETYPES, id);
}

/** The kit of one fighter, or null when the id is unknown. */
export function fighterKit(fighterId) {
  return FIGHTER_KITS[fighterId] || null;
}

/** The archetype descriptor a fighter fights under. */
export function archetypeOf(fighterId) {
  const kit = FIGHTER_KITS[fighterId];
  return kit ? ARCHETYPES[kit.archetype] : null;
}
