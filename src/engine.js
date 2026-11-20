/**
 * Deterministic fighting kernel (orchestration entry).
 * Implementation lives in ./engine/*: fighter lifecycle, damage/attacks,
 * frame step, observation/hash and the match driver. All public names are
 * re-exported unchanged.
 */
export { createInitialState } from './engine/fighter.js';
export { step } from './engine/step.js';
export { stateHash, renderState } from './engine/observer.js';
export {
  createMatch, safePolicy, runMatch, renderReplay, replayMatch,
} from './engine/match.js';
