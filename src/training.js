/**
 * Training ground (orchestration entry).
 * Drills, match tracing, report aggregation and run orchestration live in
 * ./training/*. All public names are re-exported unchanged.
 */
export { DRILLS, listDrills, MAX_TRAINING_GAMES } from './training/drills.js';
export { trainingAdvice } from './training/report.js';
export { runTraining, compareStrategies } from './training/run.js';
