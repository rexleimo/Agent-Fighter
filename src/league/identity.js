/** Ladder identity rules, team constants and Glicko-2 rating maths. */
const SCALE = 173.7178;

// Official baselines are the league's own reference fighters: the four built-in
// rule policies and the hosted strategy demo. They exist to give every visitor
// a picture and every registrant an opponent. They are NOT competitors: they
// hold a fixed nominal rating, never appear on the ladder, and never take or
// give a ladder win.
/** How often the replay store is measured against the retention limit. */
export const RETENTION_CHECK_EVERY = 25;

export const OFFICIAL_NOMINAL_RATING = 1500;
export const OFFICIAL_NOMINAL_RD = 350;

/** An agent owned by a registered player account: the only kind the ladder ranks. */
export function isLadderCompetitor(agent) {
  if (!agent) return false;
  if (agent.source === 'builtin' || agent.demo) return false;
  return Boolean(agent.playerId);
}

/** The league's own reference opponent. Fixed rating, exhibition only. */
export function isOfficialBaseline(agent) {
  return Boolean(agent) && !isLadderCompetitor(agent);
}

// Official baselines need a declared roster too: they run the always-on 3v3
// showcase room and stand in as sparring partners in the team queue. Their
// teams are shown as exhibition entries, never as ladder rows.
export const BUILTIN_TEAMS = {
  brawler: ['ember', 'forge', 'basalt'],
  zoner: ['tide', 'gale', 'quartz'],
  turtle: ['basalt', 'quartz', 'noct'],
  random: ['volt', 'noct', 'gale'],
};

// Declared roster of the official hosted baseline, used by the 3v3 showcase room.
export const BUILTIN_TEAMS_HOSTED = ['quartz', 'volt', 'ember'];

export function nextSeason(season) {
  const n = Number(String(season || 'S1').replace(/^S/i, '')) || 1;
  return 'S' + (n + 1);
}

export function cleanTeamName(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new Error('teamName must be a string');
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 32) throw new Error('teamName must be 2-32 characters');
  return name;
}

export function g(phi) {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

export function expected(mu, muj, phij) {
  return 1 / (1 + Math.exp(-g(phij) * (mu - muj)));
}

export function updateVolatility(sigma, phi, v, delta) {
  const tau = 0.5;
  const a = Math.log(sigma * sigma);
  const phi2 = phi * phi;
  const d2 = delta * delta;
  const f = (x) => {
    const ex = Math.exp(x);
    const den = 2 * Math.pow(phi2 + v + ex, 2);
    return (ex * (d2 - phi2 - v - ex)) / den - (x - a) / (tau * tau);
  };
  let A = a;
  let B;
  if (d2 > phi2 + v) {
    B = Math.log(d2 - phi2 - v);
  } else {
    let k = 1;
    while (f(a - k * tau) < 0 && k < 100) k += 1;
    B = a - k * tau;
  }
  let fA = f(A);
  let fB = f(B);
  let iter = 0;
  while (Math.abs(B - A) > 1e-6 && iter < 100) {
    const C = A + ((A - B) * fA) / (fB - fA || 1e-12);
    const fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; } else { fA /= 2; }
    B = C;
    fB = fC;
    iter += 1;
  }
  return Math.exp(A / 2);
}

export function glicko2(player, opponent, score) {
  const mu = (player.rating - 1500) / SCALE;
  const phi = player.rd / SCALE;
  const muj = (opponent.rating - 1500) / SCALE;
  const phij = opponent.rd / SCALE;
  const e = expected(mu, muj, phij);
  const gj = g(phij);
  const v = 1 / Math.max(gj * gj * e * (1 - e), 1e-12);
  const delta = v * gj * (score - e);
  const sigmaP = updateVolatility(player.sigma || 0.06, phi, v, delta);
  const phiStar = Math.sqrt(phi * phi + sigmaP * sigmaP);
  const phiP = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muP = mu + phiP * phiP * gj * (score - e);
  return {
    rating: Math.round((SCALE * muP + 1500) * 10) / 10,
    rd: Math.min(350, Math.round(SCALE * phiP * 10) / 10),
    sigma: sigmaP,
  };
}
