/**
 * Skeleton poses and world-space geometry. This module owns the joint model:
 * every hurtbox / hitbox is derived from these joints at the current frame.
 */
import { moveFor, totalFor, isCommitted } from '../rules.js';
import { cancelWindowOf, legalCancelTargets } from '../combo.js';

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
export function rect(cx, cy, w, h) {
  return { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h };
}

export function toPoint(f, lx, ly) {
  return { x: Math.round(f.x + f.facing * lx), y: Math.round(f.y + ly) };
}

export function toRect(f, lx, ly, w, h) {
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
