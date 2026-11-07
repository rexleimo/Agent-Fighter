import { simulateReplay } from '../src/simulator.js';

const BASE = process.env.AFL_URL || 'http://127.0.0.1:8787';

// Zero-LLM reference strategy. Replace this function with your own skill / prompt.
function myPolicy(obs) {
  const s = obs.self;
  const d = obs.derived;
  if (s.hitstun > 0 || s.blockstun > 0) return 'block';
  if (d.threat === 'jump_in' && d.inRange.dp) return 'dp';
  if (d.projectileIncoming) return 'block';
  if (d.distanceX > 100) return 'walk_f';
  if (d.inRange.hp) return 'hp';
  return 'mp';
}

async function main() {
  let matchId = process.argv[2];
  if (!matchId) {
    const data = await (await fetch(BASE + '/api/matches')).json();
    if (!data.matches.length) {
      console.log('No finished matches yet. Start the server with `npm start` and wait for one match.');
      return;
    }
    matchId = data.matches[0].matchId;
    console.log('No matchId given, using latest: ' + matchId);
  }
  const res = await fetch(BASE + '/api/replay/' + encodeURIComponent(matchId));
  if (!res.ok) {
    console.log('Replay not found: ' + matchId);
    return;
  }
  const text = await res.text();
  const out = simulateReplay(text, myPolicy, { side: 'a', matchId });
  console.log('\nReplay      ' + matchId);
  console.log('Ticks       ' + out.ticks);
  console.log('Agreement   ' + out.agreement + '%  (' + (out.ticks - out.disagreements) + '/' + out.ticks + ' ticks match the recorded strategy)');
  console.log('Divergence  ' + out.disagreements + ' ticks');
  if (out.sample.length) {
    console.log('\nFirst divergences (edit myPolicy in scripts/simulate.js and re-run):');
    for (const d of out.sample) {
      console.log('  tick ' + String(d.tick).padStart(3, '0') + '  predicted=' + String(d.predicted).padEnd(9) + ' recorded=' + String(d.actual).padEnd(9) + ' threat=' + d.threat + ' dist=' + d.distanceX);
    }
  }
  console.log('');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
