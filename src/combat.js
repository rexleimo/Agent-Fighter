/**
 * Authoritative skeleton + collision geometry (orchestration entry).
 *
 * Implementation lives in ./combat/pose.js (joint model, frame data, skeleton)
 * and ./combat/boxes.js (collision boxes, defensive verdicts, public frame data).
 * Every public name is re-exported here so existing importers keep working.
 */
export {
  BONES, JOINT_NAMES, HITBOX_COLORS, BASE_POSE,
  framePhase, poseFor, skeletonFor,
} from './combat/pose.js';
export {
  hurtboxesFor, pushboxFor, hitboxesFor, projectileBox, overlap, firstOverlap,
  hurtboxNearEdge, predictsHit,
  guardResult, parryWindowOpen, defensiveVerdict, boxesFor, publicBoxData,
} from './combat/boxes.js';
