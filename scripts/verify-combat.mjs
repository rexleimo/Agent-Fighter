/**
 * Combat-system acceptance: skeleton, authoritative boxes, skills, cancels,
 * meter, guard heights, anti-air, knockdown, hitstop and the defensive layer
 * (站防 / 蹲防 / 招架 / 闪避). Pure kernel checks, no server, no browser —
 * `node scripts/verify-combat.mjs`.
 *
 * The checks live in scripts/verify-parts/combat-*.mjs, grouped by responsibility.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './verify-parts/combat-helpers.mjs';
import { runCore } from './verify-parts/combat-core.mjs';
import { runKits } from './verify-parts/combat-kits.mjs';
import { runFencing } from './verify-parts/combat-fencing.mjs';
import { runDefense } from './verify-parts/combat-defense.mjs';
import { runDefenseMore } from './verify-parts/combat-defense-more.mjs';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  |  ' + detail : ''));
}

runCore(check);
runKits(check);
runFencing(check);
runDefense(check);
await runDefenseMore(check);

{
  // The check count the README advertises is itself a claim about the kernel.
  // Asserting it here (as the last item, so it can count itself) means the
  // number can never quietly drift from the suite.
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const claims = [...readme.matchAll(/(\d+) 项战斗内核验收/g)].map((m) => Number(m[1]));
  const expected = results.length + 1;
  check('K62 README 公布的验收项数 == 本文件实际跑完的项数',
    claims.length >= 2 && claims.every((c) => c === expected),
    'claims=' + JSON.stringify(claims) + ' actual=' + expected);
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' combat checks passed');
if (failed.length) {
  console.log('FAILED: ' + failed.map((f) => f.name).join(' | '));
  process.exit(1);
}
