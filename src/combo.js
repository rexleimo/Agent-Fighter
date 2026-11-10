/**
 * Combo rules.
 *
 * A chain in this game reads: a normal connects -> the attacker cancels into
 * the next link of the ladder -> that link connects -> ... and so on until the
 * chain runs out of meter or the ladder.
 *
 * This module owns the RULES and nothing else: when a cancel window opens,
 * what may be canceled into what, and how a long chain scales down. The
 * kernel applies them, the agent-facing observation reports them and the HUD
 * reads them, so all three see the same numbers.
 *
 * Two facts drive the design:
 *
 *  1. A cancel is a HIT-CONFIRM. Chaining a normal into another normal only
 *     works because the first one connected, so a whiffed light punch cannot
 *     be walked into a heavy. Cancels into the meter moves are allowed on a
 *     whiff too — that is the classic "chain cancel" and it keeps the
 *     pressure up when the opponent is blocking.
 *
 *  2. The window opens ON THE CONNECTION FRAME, not after the active frames
 *     are over. Measured from the end of the active frames the window was
 *     often already shut by the time the decision tick arrived, which is why
 *     chains never fired.
 *
 * Everything here is a pure function of (move data, fighter state).
 */

/** Frames of a cancel window, anchored on the connection frame when there is one. */
export function cancelWindowOf(move, hitFrame) {
  const connected = hitFrame !== null && hitFrame !== undefined;
  const openAt = connected ? hitFrame : move.startup + move.active;
  const length = move.cancelWindow || 0;
  return { openAt, until: openAt + length, length, connected };
}

/**
 * What may be canceled into right now.
 *
 * `cancelInto` is the full ladder of the move; `hitCancelInto` marks the
 * links that additionally require the move to have connected.
 */
export function legalCancelTargets(move, hitLanded) {
  const ladder = move.cancelInto || [];
  if (hitLanded) return ladder.slice();
  const hitOnly = move.hitCancelInto || [];
  return ladder.filter((action) => !hitOnly.includes(action));
}

export function isCancelTarget(move, action, hitLanded) {
  if (!move || !action) return false;
  return legalCancelTargets(move, hitLanded).includes(action);
}

/**
 * Damage scale of the n-th hit of a chain (n is 0-based).
 *
 * Long chains stay worth landing but stop being a one-button kill: every hit
 * past the fourth loses 10% of its damage, down to a 40% floor.
 */
export function comboScale(index) {
  if (index < 4) return 1;
  return Math.max(0.4, Math.round(Math.pow(0.9, index - 3) * 100) / 100);
}

/** How many frames a chain stays alive without another hit landing. */
export const COMBO_FRAMES = 90;

/** Human label for a chain: "轻拳→中拳→重拳". */
export function chainLabel(chain, labelOf) {
  if (!chain || !chain.length) return '';
  return chain.map((id) => (labelOf ? labelOf(id) : id)).join('→');
}
