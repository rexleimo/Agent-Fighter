import { ACTIONS } from './rules.js';
import { hashObject } from './replay.js';

/**
 * The KOF-style ladder: every normal can be canceled into the next link,
 * and the skills close the string.
 */
const CHAIN_NEXT = Object.freeze({
  lp: 'mp', mp: 'hp', lk: 'mk', mk: 'hk', hk: 'dp', hp: 'special',
  special: 'super', ex: 'super',
});

/**
 * The next link of the string, or null when the chain cannot continue.
 *
 * A link is only legal when the move in flight has CONNECTED and the ladder
 * of that move really contains the target — the kernel holds the input for a
 * few frames, so a link that is issued slightly early still lands.
 */
function chainLink(o) {
  const fd = o.frameData || {};
  const s = o.self;
  if (!fd.moveId || !fd.hitLanded) return null;
  let next = CHAIN_NEXT[fd.moveId];
  if (!next) return null;
  if (next === 'super' && !s.canSuper) next = s.canEx ? 'ex' : null;
  if (!next) return null;
  return (s.cancelInto || []).includes(next) ? next : null;
}

function brawler(o) {
  const s = o.self;
  const d = o.derived;
  if (s.hitstun > 0 || s.blockstun > 0) return 'block';
  // The string comes first: a landed normal is canceled into the next link,
  // so the pressure arrives as one combo instead of one hit at a time.
  const link = chainLink(o);
  if (link) return link;
  // The skills close the string. A skill is the end of it, so a skill is
  // never canceled into itself.
  const fd = o.frameData || {};
  const inSkill = fd.moveId === 'special' || fd.moveId === 'ex' || fd.moveId === 'super';
  if (!inSkill && s.canCancel && s.canSuper && d.distanceX < 260) return 'super';
  if (!inSkill && s.canCancel && d.inRange.special) return 'special';
  if (s.canSuper && d.distanceX < 220) return 'super';
  if (d.boxOverlap && s.canEx) return 'ex';
  if (d.threat === 'jump_in' && d.inRange.dp) return 'dp';
  if (d.opponentBlocking && d.distanceX < 132 && d.inRange.throw) return 'throw';
  if (d.projectileIncoming && d.distanceX < 200) return 'jump';
  if (d.distanceX > 196 && s.actionable) return 'dash';
  if (d.distanceX > 92) return 'walk_f';
  // Open with the shortest normal: every link of the ladder can be canceled
  // out of it, so the string can start from the fastest button.
  if (d.inRange.lp) return 'lp';
  if (d.inRange.mp) return 'mp';
  if (d.inRange.hp) return 'hp';
  return 'walk_f';
}

function zoner(o) {
  const s = o.self;
  const d = o.derived;
  if (s.hitstun > 0 || s.blockstun > 0) return 'block';
  if (s.canCancel && s.canSuper) return 'super';
  if (s.canSuper && d.distanceX < 260) return 'super';
  if (d.threat === 'jump_in' && d.inRange.dp) return 'dp';
  if (d.opponentBlocking && d.distanceX < 132 && d.inRange.throw) return 'throw';
  if (d.distanceX < 100) return s.inCorner ? 'mk' : 'walk_b';
  if (d.projectileIncoming && d.distanceX < 150) return 'block';
  if (d.distanceX >= 130 && s.actionable) return 'fireball';
  if (d.inRange.special && s.actionable) return 'special';
  if (d.inRange.mk) return 'mk';
  return 'block';
}

function turtle(o) {
  const s = o.self;
  const d = o.derived;
  if (s.hitstun > 0 || s.blockstun > 0) return 'block';
  if (s.canCancel && s.canEx) return 'ex';
  if (s.canSuper && d.distanceX < 220) return 'super';
  if (d.threat === 'jump_in' && d.inRange.dp) return 'dp';
  if (d.projectileIncoming) return 'block';
  if (d.opponentAttacking && d.distanceX < 130) return 'block';
  if (d.distanceX > 190) return 'dash';
  if (d.inRange.lp && d.frameAdvantage >= 0) return 'lp';
  if (d.distanceX < 132 && d.inRange.throw) return 'throw';
  return 'block';
}

const RANDOM_POOL = [
  'walk_f', 'walk_b', 'block', 'lp', 'mp', 'hp', 'lk', 'mk', 'hk',
  'fireball', 'dp', 'jump', 'throw', 'crouch', 'dash', 'special', 'ex', 'super',
];

function randomPolicy(o) {
  const h = (Math.imul(o.seed >>> 0, 2654435761) ^ Math.imul(o.tick + 1, 40503) ^ 0x9e3779b9) >>> 0;
  return RANDOM_POOL[h % RANDOM_POOL.length];
}

function versionOf(id, source) {
  return hashObject({ id, source }).slice(0, 12);
}

export const BUILTIN_AGENTS = [
  {
    id: 'brawler',
    name: 'Iron Rush',
    label: '钢铁压进',
    kind: 'rule',
    track: 'rule_only',
    description: '贴身强攻：命中取消接专属技 / 超必杀，攒满气直接开奥义，跳入用升龙对空',
    policy: brawler,
    defaultAction: 'block',
    versionHash: versionOf('brawler', brawler.toString()),
  },
  {
    id: 'zoner',
    name: 'Blue Wave',
    label: '波动牵制',
    kind: 'rule',
    track: 'rule_only',
    description: '中远距离发波攒气，满气开超必杀；中距用专属技，被近身后撤或对空',
    policy: zoner,
    defaultAction: 'block',
    versionHash: versionOf('zoner', zoner.toString()),
  },
  {
    id: 'turtle',
    name: 'Iron Wall',
    label: '铁壁防守',
    kind: 'rule',
    track: 'rule_only',
    description: '以防代攻：用 EX 霸体硬吃一招反击，满气超必收尾，等硬直再轻拳确反',
    policy: turtle,
    defaultAction: 'block',
    versionHash: versionOf('turtle', turtle.toString()),
  },
  {
    id: 'random',
    name: 'Noise Bot',
    label: '混沌基准',
    kind: 'rule',
    track: 'rule_only',
    description: '按种子伪随机出招，作为排行榜的能力基线',
    policy: randomPolicy,
    defaultAction: 'block',
    versionHash: versionOf('random', randomPolicy.toString()),
  },
];

export function getBuiltinAgent(id) {
  return BUILTIN_AGENTS.find((a) => a.id === id) || null;
}

export function publicAgent(agent) {
  return {
    id: agent.id,
    name: agent.name,
    label: agent.label,
    kind: agent.kind,
    track: agent.track,
    description: agent.description,
    versionHash: agent.versionHash,
  };
}

export const ACTION_REFERENCE = ACTIONS.slice();
