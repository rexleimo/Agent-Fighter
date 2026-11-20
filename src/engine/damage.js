/** Damage, armor, counter and active-defense resolution. */
import { CONFIG, moveFor, totalFor, clamp } from '../rules.js';
import { comboScale } from '../combo.js';
import { guardResult } from '../combat.js';
import { endMove } from './fighter.js';

/**
 * A landed read erases the incoming hit.
 *
 * Both active defences pay meter and emit an event shaped like the other
 * impact events, so the HUD, the replay and the training report all see one
 * vocabulary. They differ in what the DEFENDER is left with: a dodge still owes
 * its recovery frames, a parry frees the fighter on the spot — that is the
 * whole reward, a punish window rather than extra damage.
 *
 * The attacker's bookkeeping is the caller's job: a melee caller must mark the
 * box consumed, a projectile caller drops the shot. `hitFrame` is deliberately
 * NOT stamped, so an evaded/parried attack cannot hit-confirm into a chain —
 * the read turns the move into a whiff.
 */
export function resolveActiveDefense(s, def, hb, kind, atkSide, defSide, point) {
  const m = moveFor(def, def.moveId);
  const spec = (kind === 'parry' ? m && m.parry : m && m.evade) || null;
  const meterGain = spec && spec.meterGain ? spec.meterGain : 0;
  def.meter = Math.min(CONFIG.MAX_METER, def.meter + meterGain);
  const move = def.moveId;
  if (kind === 'parry') endMove(def);
  s.events.push({
    frame: s.frame, type: kind, by: defSide, on: atkSide, move,
    absorbed: hb.move, height: hb.height, damage: 0, meterGain,
    x: point.x, y: point.y, hitstun: 0,
  });
}

/**
 * Consume one melee box so the same active window cannot resolve twice.
 *
 * This spends the box; it does not confirm the hit. `hasHit` / `hitIds` stay
 * untouched on purpose, because those are what `framePhase` reads to open the
 * cancel window — an attack that was evaded or parried has to come back empty
 * handed, which is the whole price of getting read.
 */
export function consumeIncomingHit(atk, hb) {
  const m = moveFor(atk, atk.moveId);
  if (m && m.multiHit) {
    if (!(atk.spentHitIds || []).includes(hb.hitId)) atk.spentHitIds.push(hb.hitId);
  } else {
    atk.spentHit = true;
  }
}

export function applyDamage(s, atk, def, hb, atkSide, defSide) {
  const verdict = guardResult(def, hb);
  const point = {
    x: Math.round(hb.x + hb.w / 2),
    y: Math.round(hb.y + hb.h / 2),
  };
  const base = {
    frame: s.frame, by: atkSide, on: defSide, move: hb.move,
    x: point.x, y: point.y, height: hb.height,
  };
  if (verdict === 'block') {
    const chip = Math.max(1, Math.floor(hb.damage / 10));
    def.hp = Math.max(0, def.hp - chip);
    atk.damageDealt += chip;
    def.blockstun = hb.blockstun;
    def.state = 'guard';
    atk.meter = Math.min(CONFIG.MAX_METER, atk.meter + Math.floor(hb.meterGain / 2));
    def.meter = Math.min(CONFIG.MAX_METER, def.meter + 4);
    s.hitstop = Math.max(s.hitstop, Math.max(2, Math.floor(hb.hitstop / 2)));
    s.events.push({ ...base, type: 'block', damage: chip });
    return;
  }

  // Armor (EX): absorb one hit without entering hitstun.
  if (def.armorLeft > 0) {
    def.armorLeft -= 1;
    const dmg = Math.floor(hb.damage * 0.5);
    def.hp = Math.max(0, def.hp - dmg);
    atk.damageDealt += dmg;
    atk.meter = Math.min(CONFIG.MAX_METER, atk.meter + Math.floor(hb.meterGain / 2));
    s.hitstop = Math.max(s.hitstop, hb.hitstop);
    s.events.push({ ...base, type: 'armor', damage: dmg });
    return;
  }

  def.hitstun = hb.hitstun;
  def.state = 'hitstun';
  def.moveId = null;
  def.moveFrame = 0;
  def.hasHit = false;
  def.hitIds = [];
  def.hitFrame = null;
  def.buffer = null;
  def.armorLeft = 0;
  def.vx = 0;
  // COMBO: a chain is the run of hits that land inside one combo window.
  // The count feeds the HUD, the chain feeds the "what did I actually do"
  // readout, and the damage of every hit past the fourth is scaled down so
  // a long chain stays worth landing without being a one-button kill.
  if (atk.comboTimer <= 0) {
    atk.combo = 0;
    atk.comboChain = [];
    atk.comboDamage = 0;
  }
  const scale = comboScale(atk.combo);
  const damage = Math.max(1, Math.round(hb.damage * scale));
  def.hp = Math.max(0, def.hp - damage);
  atk.damageDealt += damage;
  atk.combo += 1;
  atk.comboTimer = CONFIG.COMBO_FRAMES;
  atk.comboDamage += damage;
  atk.comboChain.push(hb.move);
  if (atk.combo > atk.comboBest) {
    atk.comboBest = atk.combo;
    atk.comboBestDamage = atk.comboDamage;
  }
  if (atk.combo === 2) {
    s.events.push({
      frame: s.frame, type: 'combo_start', by: atkSide, on: defSide,
      count: atk.combo, chain: atk.comboChain.slice(),
    });
  }
  atk.meter = Math.min(CONFIG.MAX_METER, atk.meter + hb.meterGain);
  def.meter = Math.min(CONFIG.MAX_METER, def.meter + Math.floor(hb.meterGain / 2));
  def.x = clamp(def.x + atk.facing * hb.pushback, CONFIG.STAGE_LEFT, CONFIG.STAGE_RIGHT);
  if (hb.knockdown) {
    def.state = 'knockdown';
    def.wakeup = CONFIG.WAKEUP_FRAMES;
    if (def.y >= 0) def.vy = hb.launch ? CONFIG.LAUNCH_VY : 0;
  }
  s.hitstop = Math.max(s.hitstop, hb.hitstop);
  const advantage = hb.hitstun - ((hb.moveTotal || totalFor(atk, hb.move)) - (atk.moveFrame || 0));
  s.events.push({
    ...base, type: 'hit', damage, combo: atk.combo, scale,
    comboDamage: atk.comboDamage, chain: atk.comboChain.slice(),
    frameAdvantage: advantage, knockdown: Boolean(hb.knockdown),
    part: hb.hurtPart || 'body',
  });
}

/**
 * 当身 (counter stance). A melee hit that lands inside the window is absorbed
 * and answered with the stance's own fixed damage. Throws and projectiles are
 * NOT counterable — that is the risk that pays for the reward.
 */
export function resolveCounter(s, atk, def, hb, atkSide, defSide) {
  if (def.counterWindow <= 0 || !def.counterSpec) return false;
  if (hb.unblockable || hb.height === 'throw' || hb.move === 'fireball') return false;
  const spec = def.counterSpec;
  def.counterWindow = 0;
  def.invuln = Math.max(def.invuln, 6);
  atk.hasHit = true;
  atk.hitFrame = atk.moveFrame;
  atk.hp = Math.max(0, atk.hp - spec.damage);
  def.damageDealt += spec.damage;
  atk.hitstun = spec.hitstun;
  atk.state = 'hitstun';
  atk.moveId = null;
  atk.moveFrame = 0;
  atk.hitIds = [];
  atk.hitFrame = null;
  atk.buffer = null;
  atk.armorLeft = 0;
  atk.advanceVx = 0;
  atk.counterWindow = 0;
  atk.spawned = false;
  atk.vx = 0;
  atk.x = clamp(atk.x + def.facing * 12, CONFIG.STAGE_LEFT, CONFIG.STAGE_RIGHT);
  if (spec.knockdown) {
    atk.state = 'knockdown';
    atk.wakeup = CONFIG.WAKEUP_FRAMES;
    if (atk.y >= 0) atk.vy = spec.launch ? CONFIG.LAUNCH_VY : 0;
  }
  def.meter = Math.min(CONFIG.MAX_METER, def.meter + 30);
  s.hitstop = Math.max(s.hitstop, 8);
  s.events.push({
    frame: s.frame, type: 'counter', by: defSide, on: atkSide, move: def.moveId,
    absorbed: hb.move, damage: spec.damage, x: Math.round(def.x), y: -120,
    knockdown: Boolean(spec.knockdown), launch: Boolean(spec.launch),
  });
  return true;
}
