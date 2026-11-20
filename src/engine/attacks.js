/** Melee attack resolution and projectile motion/collision. */
import { CONFIG, moveFor, totalFor, clamp } from '../rules.js';
import { comboScale } from '../combo.js';
import {
  hitboxesFor, hurtboxesFor, firstOverlap, projectileBox, defensiveVerdict, guardResult,
} from '../combat.js';
import {
  consumeIncomingHit, resolveActiveDefense, applyDamage, resolveCounter,
} from './damage.js';

export function resolveAttack(s, atkSide, defSide) {
  const atk = s[atkSide];
  const def = s[defSide];
  const hitboxes = hitboxesFor(atk, s.frame);
  if (!hitboxes.length) return;
  const hurt = hurtboxesFor(def, s.frame);
  const pair = firstOverlap(hitboxes, hurt);
  if (!pair) return;
  const hb = { ...pair.hit, hurtPart: pair.hurt.part };
  // The active defensive layer is resolved HERE, after the rectangles already
  // agree that something would have landed: an evade has to know what it dodged
  // to report and reward it, which the old "return early while invulnerable"
  // shortcut could not.
  const defense = defensiveVerdict(def, hb);
  if (defense === 'evade' || defense === 'parry') {
    consumeIncomingHit(atk, hb);
    resolveActiveDefense(s, def, hb, defense, atkSide, defSide, {
      x: Math.round(hb.x + hb.w / 2), y: Math.round(hb.y + hb.h / 2),
    });
    return;
  }
  if (def.invuln > 0) {
    // 投技破闪避: the grab is the answer to the i-frames, and it eats what is
    // left of them — otherwise the knocked-down body would carry a free
    // invulnerability bank all the way through its wakeup.
    if (def.state === 'dodge' && hb.breaksDodge) def.invuln = 0;
    else return;
  }
  if (resolveCounter(s, atk, def, hb, atkSide, defSide)) return;
  if (moveFor(atk, atk.moveId).multiHit) atk.hitIds.push(hb.hitId);
  else atk.hasHit = true;
  // The connection frame anchors the cancel window: from here on the move
  // can be canceled into the next link of the ladder.
  if (atk.hitFrame === null) atk.hitFrame = atk.moveFrame;
  applyDamage(s, atk, def, hb, atkSide, defSide);
}

export function updateProjectiles(s) {
  const alive = [];
  for (const p of s.projectiles) {
    if (p.delay > 0) { p.delay -= 1; alive.push(p); continue; }
    p.x += p.vx;
    p.life -= 1;
    const defSide = p.owner === 'a' ? 'b' : 'a';
    const atk = s[p.owner];
    const def = s[defSide];
    const box = projectileBox(p);
    if (firstOverlap([box], hurtboxesFor(def, s.frame))) {
      // A dodge slips through it and a parry dissipates it; in both cases the
      // shot is SPENT, because leaving it alive would re-resolve the same
      // projectile on every frame of the window.
      const defense = defensiveVerdict(def, box);
      if (defense) {
        resolveActiveDefense(s, def, box, defense, p.owner, defSide, {
          x: Math.round(p.x), y: box.y + box.h / 2,
        });
        continue;
      }
      if (def.invuln <= 0) {
        const verdict = guardResult(def, box);
        if (verdict === 'block') {
          def.hp = Math.max(0, def.hp - 6);
          atk.damageDealt += 6;
          def.blockstun = box.blockstun;
          def.state = 'guard';
          s.events.push({ frame: s.frame, type: 'block', by: p.owner, on: defSide, move: 'fireball', damage: 6, x: Math.round(p.x), y: box.y + box.h / 2 });
        } else {
          if (atk.comboTimer <= 0) {
            atk.combo = 0;
            atk.comboChain = [];
            atk.comboDamage = 0;
          }
          const scale = comboScale(atk.combo);
          const damage = Math.max(1, Math.round(box.damage * scale));
          def.hp = Math.max(0, def.hp - damage);
          atk.damageDealt += damage;
          def.hitstun = box.hitstun;
          def.state = 'hitstun';
          def.moveId = null;
          def.moveFrame = 0;
          def.hitFrame = null;
          def.buffer = null;
          def.advanceVx = 0;
          def.counterWindow = 0;
          def.x = clamp(def.x + Math.sign(p.vx) * 9, CONFIG.STAGE_LEFT, CONFIG.STAGE_RIGHT);
          if (box.knockdown) {
            def.state = 'knockdown';
            def.wakeup = CONFIG.WAKEUP_FRAMES;
          }
          atk.combo += 1;
          atk.comboTimer = CONFIG.COMBO_FRAMES;
          atk.comboDamage += damage;
          atk.comboChain.push(p.move || 'fireball');
          if (atk.combo > atk.comboBest) {
            atk.comboBest = atk.combo;
            atk.comboBestDamage = atk.comboDamage;
          }
          if (atk.combo === 2) {
            s.events.push({ frame: s.frame, type: 'combo_start', by: p.owner, on: defSide, count: atk.combo, chain: atk.comboChain.slice() });
          }
          atk.meter = Math.min(CONFIG.MAX_METER, atk.meter + 12);
          s.hitstop = Math.max(s.hitstop, box.hitstop);
          s.events.push({
            frame: s.frame, type: 'hit', by: p.owner, on: defSide, move: p.move || 'fireball',
            damage, combo: atk.combo, scale, comboDamage: atk.comboDamage,
            chain: atk.comboChain.slice(), frameAdvantage: 6,
            knockdown: Boolean(box.knockdown), x: Math.round(p.x), y: box.y + box.h / 2,
          });
        }
        continue;
      }
      // Anything else that is merely invulnerable (升龙 / EX / 奥义 startup, the
      // wakeup frames) lets the shot fly on through, as it always did.
    }
    if (p.life > 0 && p.x > CONFIG.STAGE_LEFT && p.x < CONFIG.STAGE_RIGHT) alive.push(p);
  }
  s.projectiles = alive;
}
