/**
 * Collision boxes, guard/defensive verdicts and the public frame-data table.
 * All boxes are anchored to the live skeleton from ./pose.js.
 */
import { MOVES, moveFor, totalFor, defensiveRules } from '../rules.js';
import { ARCHETYPES, FIGHTER_KITS } from '../kits/index.js';
import { PUSH_WIDTH } from '../fighters.js';
import { poseFor, JOINT_NAMES, BONES, HITBOX_COLORS, rect, toRect } from './pose.js';

/**
 * Hurtboxes are BUILT FROM THE SKELETON: head / torso / legs follow the actual
 * joints, so crouching really does lower the head box and a jump really does
 * lift every box off the ground. That is why high attacks whiff on a croucher.
 */
export function hurtboxesFor(f, frame = 0) {
  const p = poseFor(f, frame);
  if (f.state === 'knockdown') {
    return [{ ...toRect(f, -52, -66, 116, 58), part: 'body', kind: 'hurt' }];
  }
  const head = rect(p.head[0], p.head[1], 30, 36);
  const torso = rect((p.chest[0] + p.hip[0]) / 2, (p.chest[1] + p.hip[1]) / 2 + 2, 46, 66);
  const legs = rect((p.kneeF[0] + p.kneeB[0]) / 2, (p.kneeF[1] + p.kneeB[1]) / 2 + 20, 42, 88);
  return [
    { ...toRect(f, head.x, head.y, head.w, head.h), part: 'head', kind: 'hurt' },
    { ...toRect(f, torso.x, torso.y, torso.w, torso.h), part: 'body', kind: 'hurt' },
    { ...toRect(f, legs.x, legs.y, legs.w, legs.h), part: 'legs', kind: 'hurt' },
  ];
}

/** Pushbox stops fighters from occupying the same ground space. */
export function pushboxFor(f) {
  const w = PUSH_WIDTH[f.fighterId] || 112;
  // A downed fighter's box hugs the lying body instead of standing upright.
  const h = f.state === 'knockdown' ? 40 : 176;
  return { ...toRect(f, -w / 2, -h, w, h), kind: 'push' };
}

/** World-space active hitboxes, anchored to skeleton joints. */
export function hitboxesFor(f, frame = 0) {
  const m = moveFor(f, f.moveId);
  if (!m || !m.hitboxes || (f.state !== 'attack' && f.state !== 'special' && f.state !== 'projectile')) return [];
  const p = poseFor(f, frame);
  const out = [];
  for (const hb of m.hitboxes) {
    const local = f.moveFrame - m.startup;
    if (local < hb.from || local > hb.to) continue;
    if (m.multiHit) {
      // A segment is spent either because it connected or because a read erased
      // it; `hitIds` is the hit-CONFIRM bookkeeping, `spentHitIds` is only
      // "this box may not resolve again". Collapsing the two would let an
      // evaded multi-hit super still open its cancel window.
      if ((f.hitIds || []).includes(hb.hitId)) continue;
      if ((f.spentHitIds || []).includes(hb.hitId)) continue;
    } else if (f.hasHit || f.spentHit) {
      continue;
    }
    const a = p[hb.anchor] || p.handF;
    // A grounded box reaches the fighter's feet. The cinematic supers use it:
    // their hitbox covers the whole body height, so a super that is cancelled
    // in still connects with an opponent who is lying on the floor.
    const top = a[1] + hb.y;
    const h = m.grounded ? Math.max(hb.h, p.root[1] - top) : hb.h;
    out.push({
      ...toRect(f, a[0] + hb.x, top, hb.w, h),
      kind: 'hit', move: f.moveId, hitId: hb.hitId || 0,
      height: hb.height || m.height || 'mid',
      damage: Math.round((hb.damageScale || 1) * m.damage),
      moveTotal: totalFor(f, f.moveId),
      hitstun: m.hitstun, blockstun: m.blockstun,
      pushback: m.pushback,
      // For multi-hit moves only the segment explicitly marked knocks down,
      // otherwise the first hit would floor the opponent and the remaining
      // active windows would whiff.
      knockdown: Boolean(hb.knockdown || (m.knockdown && !m.multiHit)),
      // The same goes for the launch: a rising multi-hit carries the opponent
      // up with its LAST segment, not with its first one.
      launch: Boolean(hb.launch || (m.launch && !m.multiHit)),
      hitstop: hb.hitstop || m.hitstop || 4,
      meterGain: m.meterGain, unblockable: Boolean(m.unblockable || hb.unblockable),
      // Whether this box eats the dodge i-frames. Data on the move, never a
      // hardcoded move-id list in the kernel, so a kit can print its own
      // grab-type skill with the same property.
      breaksDodge: Boolean(m.breaksDodge || hb.breaksDodge),
      armored: false,
    });
  }
  return out;
}

/** Projectiles carry their own hitbox; no distance shortcut. */
export function projectileBox(p) {
  const w = p.w || 30;
  const h = p.h || 40;
  return {
    x: Math.round(p.x - w / 2), y: Math.round(p.y - h / 2), w, h,
    kind: 'hit', move: p.move || 'fireball', hitId: 0, height: 'mid',
    damage: p.damage, hitstun: p.hitstun || 16, blockstun: p.blockstun || 10,
    pushback: 9, knockdown: Boolean(p.knockdown), launch: false,
    hitstop: p.hitstop || 4, meterGain: 12, unblockable: false, breaksDodge: false,
  };
}

export function overlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Distance from `fromX` to the nearest hurtbox edge of `fighter`.
 *
 * Uses the same live hurtboxes the kernel resolves hits against — no second
 * width table. A point already inside a hurtbox returns 0. This is the honest
 * "how far must a hit travel to touch them" gap used by reach prediction and
 * the incoming-attack readout.
 */
export function hurtboxNearEdge(fighter, fromX) {
  const x = fromX == null ? fighter.x : fromX;
  let nearest = Infinity;
  for (const h of hurtboxesFor(fighter, 0)) {
    const gap = x < h.x ? h.x - x : x > h.x + h.w ? x - (h.x + h.w) : 0;
    if (gap < nearest) nearest = gap;
  }
  return nearest === Infinity ? 0 : nearest;
}

/**
 * Would `actionId` actually connect from the attacker's CURRENT position?
 *
 * The kernel resolves hits as AABB overlap between skeleton-anchored hitboxes
 * and the defender's live hurtboxes. This asks the same question one step
 * early: stand the attacker still, run the move's active frames, and test the
 * real rectangles. No second reach model, no scalar guess.
 */
export function predictsHit(attacker, defender, actionId) {
  const m = moveFor(attacker, actionId);
  if (!m) return false;
  // Projectile: the box travels, so the honest answer is the reach it can
  // cover. Shots spawn 44px in front and move speed*life before expiring.
  if (m.projectile) {
    const travel = Math.min(640, m.projectile.speed * m.projectile.life);
    return hurtboxNearEdge(defender, attacker.x) <= travel + 44;
  }
  if (!m.hitboxes || !m.hitboxes.length) return false;
  const hurt = hurtboxesFor(defender, 0);
  const lastFrame = Math.max(m.active - 1, ...m.hitboxes.map((hb) => hb.to));
  for (let k = 0; k <= lastFrame; k += 1) {
    // A probe must NOT inherit the live fighter's hit bookkeeping: a move that
    // already connected would otherwise report zero hitboxes and predict a
    // false whiff.
    const probe = {
      ...attacker,
      state: 'attack', moveId: actionId, moveFrame: m.startup + k,
      hasHit: false, spentHit: false, hitIds: [], spentHitIds: [],
    };
    if (hitboxesFor(probe, probe.moveFrame).some((hb) => hurt.some((h) => overlap(hb, h)))) {
      return true;
    }
  }
  return false;
}

/** First (hitbox, hurtbox) pair that actually overlaps. */
export function firstOverlap(hitboxes, hurtboxes) {
  for (const hb of hitboxes) {
    for (const hurt of hurtboxes) {
      if (overlap(hb, hurt)) return { hit: hb, hurt };
    }
  }
  return null;
}

/**
 * Guard rules: standing block covers high / mid / overhead and loses to low;
 * crouch block covers low / mid and loses to high / overhead. Throws ignore
 * guard entirely. A croucher also physically ducks under high hitboxes because
 * the boxes come from the lowered skeleton.
 */
export function guardResult(f, hb) {
  if (hb.unblockable || hb.height === 'throw') return 'hit';
  const standing = f.state === 'guard' || f.blockstun > 0;
  const crouching = f.state === 'crouch';
  if (!standing && !crouching) return 'hit';
  if (standing && hb.height === 'low') return 'hit';
  if (crouching && (hb.height === 'high' || hb.height === 'overhead')) return 'hit';
  return 'block';
}

/**
 * Is the fighter currently inside its 招架 window?
 *
 * Derived from (state, moveFrame, frame data) instead of a dedicated counter,
 * because a stale copy of the window is exactly how a defensive action turns
 * into a free immune frame: the frame data is the only version of the truth.
 */
export function parryWindowOpen(f) {
  if (!f || f.state !== 'parry' || !f.moveId) return false;
  const m = moveFor(f, f.moveId);
  if (!m || !m.parry) return false;
  const local = f.moveFrame - m.startup;
  return local >= 0 && local < m.active;
}

/**
 * The ACTIVE defensive layer, i.e. everything that is not bracing.
 *
 * `guardResult` answers the passive question (am I covering this height?) and
 * stays the only place that rule lives. This answers the two reads:
 *
 *   'evade' — the dodge i-frame window swallows the hit outright.
 *   'parry' — the parry window negates any BLOCKABLE height, and a projectile.
 *
 * Both lose to throws: `breaksDodge` is what the throw hitbox carries, and an
 * unblockable is by definition not something you can catch.
 */
export function defensiveVerdict(f, hb) {
  if (!f || !hb) return null;
  if (f.state === 'dodge' && f.invuln > 0 && !hb.breaksDodge) return 'evade';
  if (parryWindowOpen(f) && !hb.unblockable && hb.height !== 'throw') return 'parry';
  return null;
}

/** Everything a renderer or an agent needs for one fighter at one frame. */
export function boxesFor(f, frame = 0) {
  return {
    hurt: hurtboxesFor(f, frame),
    hit: hitboxesFor(f, frame),
    push: pushboxFor(f),
  };
}

/** Static, human-readable frame/box reference exported by get_rules. */
export function publicBoxData() {
  const moves = {};
  for (const [id, m] of Object.entries(MOVES)) {
    moves[id] = {
      label: m.label, kind: m.kind, pose: m.pose || null,
      startup: m.startup, active: m.active, recovery: m.recovery,
      totalFrames: m.startup + m.active + m.recovery, damage: m.damage || 0,
      height: m.height || null, range: m.range || 0,
      meterCost: m.meterCost || 0, cancelInto: m.cancelInto || [],
      cancelWindow: m.cancelWindow || 0, knockdown: Boolean(m.knockdown),
      invuln: m.invuln || 0, armor: m.armor || 0,
      multiHit: Boolean(m.multiHit), hitstop: m.hitstop || 4,
      breaksDodge: Boolean(m.breaksDodge),
      evade: m.evade ? { ...m.evade } : null,
      parry: m.parry ? { ...m.parry } : null,
      hitboxes: (m.hitboxes || []).map((h) => ({ ...h })),
    };
  }
  const kits = {};
  for (const [fighterId, k] of Object.entries(FIGHTER_KITS)) {
    const arch = ARCHETYPES[k.archetype];
    kits[fighterId] = {
      archetype: k.archetype,
      archetypeLabel: arch ? arch.label : k.archetype,
      label: k.label, blurb: k.blurb, tags: [...k.tags],
      moves: Object.fromEntries(Object.entries(k.moves).map(([action, m]) => [action, {
        label: m.label, kind: m.kind, pose: m.pose || null,
        startup: m.startup, active: m.active, recovery: m.recovery,
        totalFrames: m.startup + m.active + m.recovery, damage: m.damage || 0,
        height: m.height || null, range: m.range || 0,
        meterCost: m.meterCost || 0, cancelInto: m.cancelInto || [], cancelWindow: m.cancelWindow || 0,
        knockdown: Boolean(m.knockdown), invuln: m.invuln || 0, armor: m.armor || 0,
        multiHit: Boolean(m.multiHit), hitstop: m.hitstop || 4,
        advance: m.advance ? m.advance.vx : 0,
        projectile: m.projectile ? { ...m.projectile } : null,
        counter: m.counter ? { ...m.counter } : null,
        hitboxes: (m.hitboxes || []).map((h) => ({ ...h })),
      }])),
    };
  }
  return {
    coordinateSystem: 'local +x = forward, feet y=0, up is negative; world y is relative to the floor line',
    joints: JOINT_NAMES,
    bones: BONES.map(([a, b]) => a + '->' + b),
    hurtboxRule: 'head/torso/legs boxes are derived from the live skeleton joints every frame',
    guardRule: 'standing block covers mid/high/overhead and loses to low; crouch block covers low/mid and loses to high/overhead',
    defensive: defensiveRules(),
    colors: HITBOX_COLORS,
    moves,
    // Per-fighter skill kits: the three meter actions resolve through these.
    kits,
    kitNote: 'A fighter fights with kits[fighterId].moves[action] when that action is special/ex/super, otherwise with moves[action]. Every fighter owns a different table.',
  };
}
