/**
 * League facade (orchestration entry).
 *
 * Ladder identity, rating maths, persistence and the League class are split
 * across ./league/*. The class is composed as a thin inheritance chain of
 * cohesive layers; its constructor, methods and public exports are unchanged.
 */
export {
  RETENTION_CHECK_EVERY, OFFICIAL_NOMINAL_RD,
  isLadderCompetitor, isOfficialBaseline, glicko2,
} from './league/identity.js';

import { LeagueTraining } from './league/class-training.js';

export class League extends LeagueTraining {}
