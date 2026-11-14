/**
 * Authoritative skeleton + collision geometry.
 *
 * This is the layer that was missing: every fighter is a 15-joint skeleton,
 * and EVERY hurtbox / hitbox / pushbox is derived from those joints at the
 * current frame. The kernel resolves hits by rectangle overlap in this file,
 * not by a one-dimensional `|x1 - x2| <= range` shortcut. The browser is a
 * read-only projection: it draws the boxes the server already decided with.
 *
 * Coordinate convention (local, before mirroring):
 *   +x = forward (towards the opponent), +y = down, feet at y = 0.
 *   A standing fighter is ~192 units tall, matching the 204px illustration.
 * World conversion applies `facing` and the fighter's (x, y) position.
 * The browser adds GROUND to every world y it receives.
 */
import { MOVES, moveFor, totalFor, isCommitted, defensiveRules } from './rules.js';
import { ARCHETYPES, FIGHTER_KITS } from './kits/index.js';
import { PUSH_WIDTH } from './fighters.js';
import { cancelWindowOf, legalCancelTargets } from './combo.js';

/** Bone graph. Front limbs are the ones on the opponent's side. */
export const BONES = Object.freeze([
  ['root', 'hip'], ['hip', 'chest'], ['chest', 'neck'], ['neck', 'head'],
  ['chest', 'shoulderF'], ['shoulderF', 'elbowF'], ['elbowF', 'handF'],
  ['chest', 'shoulderB'], ['shoulderB', 'elbowB'], ['elbowB', 'handB'],
  ['hip', 'kneeF'], ['kneeF', 'footF'], ['hip', 'kneeB'], ['kneeB', 'footB'],
]);

export const JOINT_NAMES = Object.freeze([
  'root', 'hip', 'chest', 'neck', 'head',
  'shoulderF', 'elbowF', 'handF', 'shoulderB', 'elbowB', 'handB',
  'kneeF', 'footF', 'kneeB', 'footB',
]);

export const HITBOX_COLORS = Object.freeze({
  hurt: '#38d9c0', hit: '#ff5d6c', push: '#8ea3b8', bone: '#ffd166',
});

export const BASE_POSE = Object.freeze({
  root: [0, 0], hip: [0, -88], chest: [0, -140], neck: [0, -158], head: [0, -178],
  shoulderF: [16, -148], elbowF: [30, -120], handF: [40, -104],
  shoulderB: [-14, -148], elbowB: [-26, -118], handB: [-34, -100],
  kneeF: [14, -46], footF: [22, -2], kneeB: [-14, -46], footB: [-22, -2],
});

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function clonePose(src = BASE_POSE) {
  const p = {};
  for (const k of JOINT_NAMES) p[k] = [src[k][0], src[k][1]];
  return p;
}

function mixJoint(p, key, x, y, t = 1) {
  p[key][0] = lerp(p[key][0], x, t);
  p[key][1] = lerp(p[key][1], y, t);
}

/** Where a move currently is: startup / active / recovery / free. */
export function framePhase(f) {
  const m = moveFor(f, f.moveId);
  if (!m || !isCommitted(f)) {
    return {
      moveId: f.moveId || null, phase: 'none', frame: 0, total: 0,
      startup: 0, active: 0, recovery: 0, cancelable: false, cancelInto: [],
      cancelIn: -1, hitLanded: false,
    };
  }
  const total = totalFor(f, f.moveId);
  const n = f.moveFrame;
  const phase = n < m.startup ? 'startup' : n < m.startup + m.active ? 'active' : 'recovery';
  const hitLanded = f.hasHit || (f.hitIds && f.hitIds.length > 0);
  // The window opens ON THE CONNECTION FRAME, so a chain can be confirmed the
  // moment the hit lands instead of after the active frames are over.
  const win = cancelWindowOf(m, f.hitFrame);
  const inWindow = win.length > 0 && n >= win.openAt && n < win.until;
  const targets = legalCancelTargets(m, hitLanded);
  return {
    moveId: f.moveId, phase, frame: n, total,
    startup: m.startup, active: m.active, recovery: m.recovery,
    cancelable: inWindow && targets.length > 0,
    // The ladder is reported even before the window opens: an agent can
    // pre-charge the cancel and the kernel will hold the input for it.
    cancelInto: targets.slice(),
    cancelIn: inWindow ? 0 : Math.max(0, win.openAt - n),
    hitLanded,
    label: m.label || f.moveId,
  };
}

/**
 * Local joint positions for the current authoritative frame.
 * `frame` is the global render frame (used only for breathing / walk cycles),
 * so replay reconstruction produces byte-identical skeletons.
 */
export function poseFor(f, frame = 0) {
  const p = clonePose();
  const state = f.state || 'idle';
  const m = moveFor(f, f.moveId);
  const total = m ? totalFor(f, f.moveId) : 1;
  const t = m ? clamp01(f.moveFrame / Math.max(1, total)) : 0;
  const swing = Math.sin(clamp01(t) * Math.PI);
  const breath = Math.sin(frame * 0.09) * 1.6;
  const walk = Math.sin(frame * 0.34) * 12;

  if (state === 'idle') {
    p.chest[1] += breath; p.head[1] += breath; p.neck[1] += breath;
    p.handF[1] += breath; p.handB[1] += breath;
  } else if (state === 'walk' || state === 'dash') {
    const amp = state === 'dash' ? 18 : 10;
    p.kneeF[0] += walk * 0.5; p.footF[0] += walk; p.footF[1] = -Math.max(0, walk) * 0.35;
    p.kneeB[0] -= walk * 0.5; p.footB[0] -= walk; p.footB[1] = -Math.max(0, -walk) * 0.35;
    p.chest[0] += (state === 'dash' ? 10 : 3);
    p.handF[0] += amp * 0.3; p.handB[0] -= amp * 0.3;
  } else if (state === 'crouch') {
    // A real crouch: the whole skeleton drops to 58% height, so the head and
    // torso hurtboxes physically duck under standing-height high hitboxes.
    // This is geometry, not a special-cased "high attacks miss crouchers" flag.
    for (const k of JOINT_NAMES) { p[k][1] *= 0.58; p[k][0] *= 1.06; }
    p.footF = [30, -2]; p.footB = [-26, -2];
    p.kneeF = [22, -34]; p.kneeB = [-20, -34];
    p.handF = [24, -64]; p.handB = [-18, -62];
  } else if (state === 'jump' || f.y < 0) {
    p.kneeF = [22, -60]; p.footF = [30, -34];
    p.kneeB = [-18, -58]; p.footB = [-26, -30];
    p.handF = [34, -140]; p.handB = [-32, -134];
  } else if (state === 'guard' || f.blockstun > 0) {
    p.elbowF = [18, -128]; p.handF = [14, -158];
    p.elbowB = [-8, -126]; p.handB = [6, -152];
    p.chest[0] -= 4;
  } else if (state === 'dodge') {
    // The whole body leans away and sinks, front foot braked under it. This is
    // the pose the backstep belongs to, so the picture and the i-frames end
    // together: a fighter still in this pose after the window is over reads as
    // recoverable, which is what makes a late hit honest.
    const away = clamp01(f.moveFrame / Math.max(1, total));
    p.hip = [-6 - 4 * away, -82];
    p.chest = [-16 - 8 * away, -132];
    p.neck = [-22 - 8 * away, -150];
    p.head = [-28 - 8 * away, -170];
    p.shoulderF = [-6, -142]; p.elbowF = [2, -122]; p.handF = [-6, -104];
    p.shoulderB = [-24, -142]; p.elbowB = [-32, -118]; p.handB = [-38, -98];
    p.kneeF = [8, -44]; p.footF = [30, -2];
    p.kneeB = [-24, -48]; p.footB = [-38, -2];
  } else if (state === 'parry') {
    // Both forearms come UP AND FORWARD, weight over the front foot: the
    // silhouette is deliberately different from `guard`, where the arms are
    // tucked close to the body. A player (and a strategy reading the skeleton)
    // should be able to see that this fighter is betting, not bracing.
    p.hip = [2, -86];
    p.chest = [6, -138]; p.neck = [6, -156]; p.head = [4, -176];
    p.shoulderF = [16, -146]; p.elbowF = [24, -134]; p.handF = [38, -150];
    p.shoulderB = [-10, -146]; p.elbowB = [6, -130]; p.handB = [26, -140];
    p.kneeF = [18, -46]; p.footF = [28, -2];
    p.kneeB = [-16, -46]; p.footB = [-28, -2];
  } else if (state === 'hitstun') {
    p.chest = [-14, -136]; p.neck = [-20, -154]; p.head = [-26, -172];
    p.handF = [-6, -96]; p.handB = [-40, -92]; p.hip[0] -= 6;
  } else if (state === 'knockdown') {
    // Lying on the back: the spine becomes horizontal.
    p.root = [0, 0]; p.hip = [-6, -22]; p.chest = [-38, -32]; p.neck = [-56, -34]; p.head = [-74, -34];
    p.shoulderF = [-34, -48]; p.elbowF = [-18, -60]; p.handF = [0, -62];
    p.shoulderB = [-34, -16]; p.elbowB = [-18, -8]; p.handB = [0, -6];
    p.kneeF = [20, -26]; p.footF = [44, -16]; p.kneeB = [18, -14]; p.footB = [40, -2];
  }

  if (m && (state === 'attack' || state === 'projectile' || state === 'special')) {
    const windup = m.startup ? clamp01(f.moveFrame / m.startup) : 1;
    const strike = m.active ? clamp01((f.moveFrame - m.startup) / m.active) : 1;
    // Light and heavy share a pose family but not the same travel: a jab must
    // not read as a haymaker. `power` widens the *reach* of the strike (and the
    // counter-rotation of the body), never the windup fraction — otherwise a
    // jab would fall short of the box its own frame data promises.
    const power = clamp01(((m.damage || 40) - 30) / 80);
    const ext = f.moveFrame >= m.startup ? swing : 1 - windup;
    switch (m.pose) {
      case 'punch': {
        mixJoint(p, 'chest', 6, -142, 0.5 * ext);
        mixJoint(p, 'shoulderF', 20, -146, 0.6 * ext);
        p.elbowF = [lerp(24, 46, ext), lerp(-118, -132, ext)];
        p.handF = [lerp(20, 96 + 30 * power, ext), lerp(-108, -136, ext)];
        p.handB = [-24, -96]; p.elbowB = [-20, -114];
        // Heavy punches also drive the rear shoulder back, so the whole upper
        // body counters instead of one arm waving.
        p.shoulderB = [-14 - 10 * ext * power, -148];
        break;
      }
      case 'kick': {
        p.hip[0] -= 4;
        p.kneeF = [lerp(18, 40, ext), lerp(-50, -74, ext)];
        p.footF = [lerp(26, 118 + 26 * power, ext), lerp(-6, m.height === 'high' ? -108 : -42, ext)];
        p.handB = [-40, -118]; p.chest[0] -= 6;
        break;
      }
      case 'rush': {
        // Deep lunge: the body travels forward and low, the front arm is
        // cocked back during startup and thrown through during the active frames.
        const lunge = 1 - windup * 0.5;
        p.hip = [16 * lunge, lerp(-88, -76, strike)];
        p.chest = [lerp(2, 26, strike), -132];
        p.neck = [lerp(4, 30, strike), -150];
        p.head = [lerp(6, 34, strike), -170];
        p.kneeF = [30, -44]; p.footF = [58, -2];
        p.kneeB = [-16, -50]; p.footB = [-34, -2];
        p.elbowF = [lerp(-4, 22, ext), lerp(-120, -126, ext)];
        p.handF = [lerp(-26, 84, ext), lerp(-112, -132, ext)];
        p.elbowB = [-30, -118]; p.handB = [-48, -104];
        break;
      }
      case 'volley': {
        // Both hands push the energy out; the fighter sinks into a wide stance
        // because the recovery is long and he cannot walk during it.
        p.chest = [lerp(-2, 10, ext), -138];
        p.elbowF = [lerp(22, 40, ext), -130];
        p.handF = [lerp(14, 74, ext), lerp(-124, -120, ext)];
        p.elbowB = [lerp(-16, 22, ext), -126];
        p.handB = [lerp(-24, 60, ext), lerp(-120, -116, ext)];
        p.kneeF = [20, -48]; p.footF = [36, -2];
        p.kneeB = [-18, -46]; p.footB = [-30, -2];
        break;
      }
      case 'counter': {
        // Weight back, both forearms up: a stance the opponent can read and
        // punish if they simply wait it out.
        p.hip = [-8, -84];
        p.chest = [-14, -138]; p.neck = [-16, -156]; p.head = [-18, -176];
        p.shoulderF = [-2, -146]; p.elbowF = [8, -132]; p.handF = [16, -160];
        p.shoulderB = [-26, -146]; p.elbowB = [-16, -130]; p.handB = [-8, -156];
        p.kneeF = [10, -44]; p.footF = [16, -2];
        p.kneeB = [-20, -44]; p.footB = [-30, -2];
        break;
      }
      case 'antiAir': {
        // Rising: the hip leaves the ground and both legs tuck, so the hurtbox
        // really does climb with the hitbox.
        const rise = strike;
        p.hip = [2, lerp(-88, -128, rise)];
        p.chest = [10, lerp(-140, -180, rise)];
        p.neck = [12, lerp(-158, -198, rise)];
        p.head = [14, lerp(-178, -218, rise)];
        p.elbowF = [22, lerp(-170, -190, rise)];
        p.handF = [26, lerp(-150, -228, rise)];
        p.elbowB = [-20, -120]; p.handB = [-30, -104];
        p.kneeF = [22, lerp(-66, -84, rise)]; p.footF = [30, lerp(-34, -56, rise)];
        p.kneeB = [-16, lerp(-62, -80, rise)]; p.footB = [-24, lerp(-30, -52, rise)];
        break;
      }
      case 'multi': {
        // Alternating hands: the second hit comes from the rear hand, so the
        // two hitboxes read as two different strikes.
        const alt = Math.sin(clamp01(strike) * Math.PI * 2);
        p.chest = [6 + 6 * alt, -140];
        p.elbowF = [lerp(26, 50, ext), -128];
        p.handF = [lerp(22, 96, ext), lerp(-112, -130, ext)];
        p.elbowB = [lerp(-22, 14, Math.max(0, alt)), -124];
        p.handB = [lerp(-30, 78, Math.max(0, alt)), lerp(-104, -126, Math.max(0, alt))];
        p.kneeF = [18, -46]; p.footF = [28, -2];
        break;
      }
      case 'dp': {
        p.hip = [2, lerp(-88, -124, strike)];
        p.chest = [10, lerp(-140, -178, strike)];
        p.head = [14, lerp(-178, -214, strike)];
        p.elbowF = [22, -170]; p.handF = [26, lerp(-150, -224, strike)];
        p.elbowB = [-20, -120]; p.handB = [-30, -104];
        p.kneeF = [22, -66]; p.footF = [30, -34]; p.kneeB = [-16, -62]; p.footB = [-24, -30];
        break;
      }
      case 'projectile': {
        p.chest[0] -= 4;
        p.elbowF = [lerp(24, 40, ext), -134]; p.handF = [lerp(18, 66, ext), -128];
        p.elbowB = [lerp(-20, 4, ext), -126]; p.handB = [lerp(-28, 54, ext), -124];
        p.footF = [32, -2]; p.footB = [-26, -2];
        break;
      }
      case 'throw': {
        p.handF = [lerp(30, 74, ext), -132]; p.elbowF = [lerp(24, 48, ext), -134];
        p.handB = [lerp(-30, 60, ext), -124]; p.elbowB = [lerp(-24, 36, ext), -128];
        p.chest[0] += 6;
        break;
      }
      case 'super': {
        const pulse = Math.sin(strike * Math.PI * 3) * 8;
        p.chest = [12, -148 + pulse * 0.2];
        p.head = [16, -186 + pulse * 0.2];
        p.elbowF = [40, -152]; p.handF = [lerp(40, 150, strike), -150 + pulse];
        p.elbowB = [-34, -112]; p.handB = [-44, -104];
        p.footF = [38, -2]; p.footB = [-30, -2];
        break;
      }
      case 'special': {
        p.chest = [8, -144]; p.hip[0] += 8;
        p.elbowF = [34, -142]; p.handF = [lerp(28, 108, ext), -140];
        p.elbowB = [-22, -110]; p.handB = [-36, -100];
        p.kneeF = [26, -50]; p.footF = [40, -2];
        break;
      }
      default:
        break;
    }
  }
  return p;
}

/** Local rect {x,y,w,h} with (x,y) = top-left. */
function rect(cx, cy, w, h) {
  return { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h };
}

function toPoint(f, lx, ly) {
  return { x: Math.round(f.x + f.facing * lx), y: Math.round(f.y + ly) };
}

function toRect(f, lx, ly, w, h) {
  const x = f.facing > 0 ? f.x + lx : f.x - lx - w;
  return { x: Math.round(x), y: Math.round(f.y + ly), w, h };
}

/**
 * Skeleton in world coordinates. `bones` is a flat list of line segments so
 * the browser never has to recompute geometry or own a second skeleton model.
 */
export function skeletonFor(f, frame = 0) {
  const p = poseFor(f, frame);
  const joints = {};
  for (const k of JOINT_NAMES) {
    const q = toPoint(f, p[k][0], p[k][1]);
    joints[k] = [q.x, q.y];
  }
  const bones = BONES.map(([a, b]) => [joints[a][0], joints[a][1], joints[b][0], joints[b][1]]);
  // Local displacement from the neutral stance. The renderer uses this to
  // drive the illustration's head/torso/hip/leg slices: it never owns a
  // second animation model.
  const delta = {};
  for (const k of JOINT_NAMES) {
    delta[k] = [
      Math.round((p[k][0] - BASE_POSE[k][0]) * 10) / 10,
      Math.round((p[k][1] - BASE_POSE[k][1]) * 10) / 10,
    ];
  }
  return { joints, bones, delta };
}

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
