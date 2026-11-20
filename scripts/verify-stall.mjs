/**
 * Task 7 acceptance: anti-stall (rules 2.2).
 *  - passive vs passive -> double_loss / time_up_stall, both penalised
 *  - passive vs active  -> active wins, passive penalised
 *  - defender blocking a fireball is NOT penalised
 *  - 2.1 replays reproduce their stateHash byte for byte
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../src/config.js';
import { parseReplay } from '../src/replay.js';
import { createMatch, runMatch, replayMatch } from '../src/engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  PASS  ${name}  |  ${detail}`); }
  else { fail += 1; console.error(`  FAIL  ${name}  |  ${detail}`); }
}

function stallEvents(replay) {
  let penalties = 0;
  for (const t of replay.ticks) {
    penalties += 0; // tick records do not carry events; counted from live match below
  }
  return penalties;
}

// 1. both passive
{
  const m = createMatch({ seed: 7, matchId: 'stall-both' });
  let penalties = { a: 0, b: 0 };
  let warnings = { a: 0, b: 0 };
  while (!m.over) {
    const out = m.advance('block', 'block');
    for (const e of out.events) {
      if (e.type === 'stall_penalty') penalties[e.by] += 1;
      if (e.type === 'stall_warning') warnings[e.by] += 1;
    }
  }
  check('双方全程 block -> double_loss / time_up_stall',
    m.state.winner === 'double_loss' && m.state.reason === 'time_up_stall',
    `${m.state.winner}/${m.state.reason}`);
  check('双方都收到 stall_warning 与 stall_penalty',
    warnings.a > 0 && warnings.b > 0 && penalties.a > 0 && penalties.b > 0,
    `warn=${JSON.stringify(warnings)} penalty=${JSON.stringify(penalties)}`);
  check('消极扣血但不会致死（hp >= 1）',
    m.state.a.hp >= 1 && m.state.b.hp >= 1,
    `hp=${m.state.a.hp}/${m.state.b.hp}`);
}

// 2. active beats passive
{
  const m = createMatch({ seed: 11, matchId: 'stall-active' });
  let penalties = { a: 0, b: 0 };
  while (!m.over) {
    const out = m.advance('walk_f', 'lp');
    for (const e of out.events) if (e.type === 'stall_penalty') penalties[e.by] += 1;
  }
  check('积极方（持续出招）胜消极方',
    m.state.winner === 'b',
    `winner=${m.state.winner} reason=${m.state.reason} hp=${m.state.a.hp}/${m.state.b.hp}`);
  check('积极方全程没有被判消极',
    penalties.b === 0, JSON.stringify(penalties));
}

// 3. defending an attacking opponent is not passive
{
  const m = createMatch({ seed: 13, matchId: 'stall-defend' });
  let penaltiesB = 0;
  while (!m.over) {
    const out = m.advance('fireball', 'block');
    for (const e of out.events) if (e.type === 'stall_penalty' && e.by === 'b') penaltiesB += 1;
  }
  // The attacker is a quartz (volley) so fireball is allowed. The defender
  // blocks while projectiles arrive: guarding an attacking opponent is active.
  check('防守方持续格挡对手进攻不算消极',
    penaltiesB === 0, `penaltiesB=${penaltiesB} hp=${m.state.a.hp}/${m.state.b.hp}`);
}

// 4. version gate: 2.1 passive match keeps old draw behaviour
{
  const m = createMatch({ seed: 7, matchId: 'stall-21', rulesVersion: '2.1' });
  while (!m.over) m.advance('block', 'block');
  check('2.1 规则下双方 block 仍为 draw（版本门控）',
    m.state.winner === 'draw' && m.state.reason === 'time_up',
    `${m.state.winner}/${m.state.reason}`);
}

// 5. real 2.1 replays reproduce
{
  const dir = path.join(ROOT, 'src/data/replays');
  let total = 0;
  let ok = 0;
  const bad = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const rep = parseReplay(readFileSync(path.join(dir, f), 'utf8'));
    if (rep.rulesVersion !== '2.1') continue;
    total += 1;
    if (replayMatch(rep).ok) ok += 1; else bad.push(f);
  }
  check('全部 2.1 历史回放 stateHash 逐帧一致', total > 0 && ok === total,
    `${ok}/${total} 失败样例=${bad.slice(0, 3).join(',')}`);
}

// 6. damageDealt feeds the time_up chain
{
  const r = runMatch({
    seed: 21, matchId: 'damage-chain',
    policyA: () => 'block',
    policyB: (o) => (o.derived.inRange.lp ? 'lp' : 'walk_f'),
  });
  check('结算暴露 damageDealt 且攻方更高',
    r.state.b.damageDealt > r.state.a.damageDealt,
    `a=${r.state.a.damageDealt} b=${r.state.b.damageDealt}`);
}

console.log(`\n${pass}/${pass + fail} stall checks passed`);
if (fail) process.exit(1);
