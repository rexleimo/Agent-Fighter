/**
 * League facade (orchestration entry).
 *
 * Ladder identity, rating maths, persistence and the League class are split
 * across ./league/*. The class composes cohesive capability factories at
 * construction instead of chaining inheritance; its constructor, methods and
 * public exports are unchanged.
 */
export {
  RETENTION_CHECK_EVERY, OFFICIAL_NOMINAL_RD,
  isLadderCompetitor, isOfficialBaseline, glicko2,
} from './league/identity.js';

import { createSetupCapability } from './league/class-setup.js';
import { createAgentsCapability } from './league/class-agents.js';
import { createMatchesCapability } from './league/class-matches.js';
import { createReplaysCapability } from './league/class-replays.js';
import { createTrainingCapability } from './league/class-training.js';

export class League {
  constructor(options = {}) {
    Object.assign(
      this,
      createSetupCapability(),
      createAgentsCapability(),
      createMatchesCapability(),
      createReplaysCapability(),
      createTrainingCapability(),
    );
    this.init(options);
  }
}
