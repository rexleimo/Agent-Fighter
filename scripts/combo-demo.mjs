/**
 * Combo demo: prove the KOF-style chain ladder actually fires in the kernel.
 *
 * The kernel decides every frame, but an agent only picks an action once per
 * tick (100 ms) while a cancel window is only a handful of frames wide. So
 * this script drives the chain through the SAME path an agent uses —
 * observation -> policy -> advance — because a PASS has to mean "a real
 * agent lands this combo", not "the kernel can be poked into it".
 *
 * Scenarios:
 *   ladder        轻拳→中拳→重拳→专属技→超必杀, the full KOF-style string.
 *   confirm       a whiffed light punch must NOT chain into a medium punch.
 *   chain-cancel  a whiffed light punch MAY chain into a meter move.
 *
 * Usage:
 *   node scripts/combo-demo.mjs          # every scenario
 *   node scripts/combo-demo.mjs ladder   # one scenario
 */
import { createMatch } from '../src/engine.js';
import { CONFIG } from '../src/config.js';
import { FIGHTER_KITS } from '../src/kits/index.js';
import { moveFor } from '../src/rules.js';

/**
 * A policy that walks a plan of links and cancels into the next one.
 *
 * `confirm` decides whether the next link waits for the current move to
 * CONNECT (hit-confirm chain) or is charged straight away (whiff chain).
 */
function chainPolicy(plan, { confirm = true } = {}) {
  let idx = 0;
  const log = [];
  const decide = (obs) => {
    const fd = obs.frameData || {};
    if (!fd.moveId) {
      if (idx >= plan.length) return 'idle';
      const action = plan[idx];
      idx += 1;
      log.push({ tick: obs.tick, action, via: 'start' });
      return action;
    }
    if (idx >= plan.length) return 'idle';
    const action = plan[idx];
    if (!(fd.cancelInto || []).includes(action)) return 'idle';
    if (confirm && !fd.hitLanded) return 'idle';
    idx += 1;
    log.push({ tick: obs.tick, action, via: 'cancel' });
    return action;
  };
  return { decide, log, get links() { return plan.slice(0, idx); } };
}

function labelOf(fighterId, action) {
  const m = moveFor(fighterId, action);
  return (m && m.label) || action;
}

/** Run one scenario and collect everything the kernel said. */
function run({ fighter = 'ember', opponent = 'quartz', plan, dx = 120, meter = 300, ticks = 60, confirm = true, opponentAction = 'idle' }) {
  const match = createMatch({
    seed: 20261110, matchId: 'combo-demo', fighters: { a: fighter, b: opponent },
  });
  // Park the two fighters at the distance the scenario needs and hand the
  // attacker a full bar so the meter links of the string are affordable.
  match.state.a.x = 480 - dx / 2;
  match.state.b.x = 480 + dx / 2;
  match.state.a.meter = meter;
  const policy = chainPolicy(plan, { confirm });
  const events = [];
  for (let t = 0; t < ticks && !match.over; t += 1) {
    const obs = match.observations();
    const actionA = policy.decide(obs.a);
    const out = match.advance(actionA, opponentAction, { sourceA: 'local', sourceB: 'local' });
    for (const e of out.events) events.push({ ...e, tick: t });
  }
  return {
    fighter, opponent, plan, policy, events,
    hits: events.filter((e) => e.type === 'hit'),
    cancels: events.filter((e) => e.type === 'cancel' && e.by === 'a'),
    comboStarts: events.filter((e) => e.type === 'combo_start'),
    comboEnds: events.filter((e) => e.type === 'combo_end'),
    state: match.state,
    hpA: match.state.a.hp,
    hpB: match.state.b.hp,
  };
}

/** Printable chain, e.g. 轻拳→中拳→重拳. */
function chainText(chain, fighterId) {
  return (chain || []).map((id) => labelOf(fighterId, id)).join('→');
}

const SCENARIOS = {
  ladder: {
    title: '连段阶梯：轻拳→中拳→重拳→专属技→超必杀',
    run: () => run({ plan: ['lp', 'mp', 'hp', 'special', 'super'] }),
    check(r) {
      const problems = [];
      const pairs = r.cancels.map((c) => c.from + '>' + c.into);
      for (const want of ['lp>mp', 'mp>hp', 'hp>special', 'special>super']) {
        if (!pairs.includes(want)) problems.push('missing cancel ' + want);
      }
      const chain = r.hits.length ? r.hits[r.hits.length - 1].chain : [];
      for (const want of ['lp', 'mp', 'hp', 'special']) {
        if (!chain.includes(want)) problems.push('chain misses ' + want);
      }
      if (!r.comboStarts.length) problems.push('no combo_start');
      if (!r.comboEnds.length) problems.push('no combo_end');
      const best = r.state.a.comboBest;
      if (best < 5) problems.push('best combo ' + best + ' hits, want 5+');
      // Damage must scale down past the fourth hit, so a long string stays
      // worth landing without being a one-button kill.
      const scaled = r.hits.filter((h) => h.scale < 1);
      if (!scaled.length) problems.push('no damage scaling after the fourth hit');
      return problems;
    },
  },
  confirm: {
    title: '确反规则：空振的轻拳不能接中拳',
    run: () => run({ plan: ['lp', 'mp'], dx: 460, ticks: 20 }),
    check(r) {
      const problems = [];
      const pairs = r.cancels.map((c) => c.from + '>' + c.into);
      if (pairs.includes('lp>mp')) problems.push('whiffed light punch chained into a medium');
      if (r.hits.length) problems.push('a whiff landed ' + r.hits.length + ' hits');
      return problems;
    },
  },
  'chain-cancel': {
    title: '连打取消：空振的轻拳可以接气槽技',
    run: () => run({ plan: ['lp', 'special'], dx: 460, ticks: 24, confirm: false }),
    check(r) {
      const problems = [];
      const pairs = r.cancels.map((c) => c.from + '>' + c.into);
      if (!pairs.includes('lp>special')) problems.push('whiff did not chain into the meter move');
      return problems;
    },
  },
};

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const only = args[0];
const names = only ? (SCENARIOS[only] ? [only] : Object.keys(SCENARIOS)) : Object.keys(SCENARIOS);

let allOk = true;
for (const name of names) {
  const scenario = SCENARIOS[name];
  const result = scenario.run();
  const problems = scenario.check(result);
  const ok = problems.length === 0;
  allOk = allOk && ok;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name.padEnd(14) + ' ' + scenario.title);
  console.log('        fighter    ' + result.fighter + ' vs ' + result.opponent);
  console.log('        inputs     ' + result.policy.log.map((l) => l.action + '@' + l.tick).join(' '));
  console.log('        cancels    ' + (result.cancels.length
    ? result.cancels.map((c) => c.from + '→' + c.into + (c.buffered ? '(buffered)' : '')).join(' ')
    : 'none'));
  console.log('        hits       ' + result.hits.length
    + (result.hits.length ? ' [' + result.hits.map((h) => h.damage + (h.scale < 1 ? '@' + h.scale : '')).join('/') + ']' : ''));
  console.log('        chain      ' + chainText(result.hits.length ? result.hits[result.hits.length - 1].chain : [], result.fighter));
  console.log('        best combo ' + result.state.a.comboBest + ' hits, '
    + result.state.a.comboBestDamage + ' damage, opponent hp ' + result.hpB);
  if (problems.length) console.log('        !! ' + problems.join('; '));
  console.log('');
}

console.log(allOk ? 'combo ladder behaves as declared' : 'some combo scenario did not behave as declared');
process.exitCode = allOk ? 0 : 1;
