import crypto from 'node:crypto';

/**
 * captcha.js — self-contained arithmetic challenge for the public auth surface.
 *
 * Player accounts have no email sender, so a verification code cannot be
 * delivered out of band. A short-lived, single-use arithmetic challenge bound
 * to an httpOnly cookie raises the cost of scripted registration without an
 * external service. It is a speed bump, not bot-proof: the per-IP auth rate
 * limiter in security.js stays the primary abuse guard.
 *
 * Ownership: challenge generation, storage and consumption live here. HTTP
 * concerns (cookie headers, status codes) stay in server.js through the two
 * small cookie helpers at the bottom.
 */

export const CAPTCHA_COOKIE = 'afl_captcha';
const TTL = Number(process.env.AFL_CAPTCHA_TTL_MS || 300_000);
const CLEANUP_MS = 60_000;

export function createCaptchaStore() {
  /** @type {Map<string, {answer: number, expiresAt: number}>} */
  const challenges = new Map();

  function sweep() {
    const now = Date.now();
    for (const [token, rec] of challenges) {
      if (rec.expiresAt <= now) challenges.delete(token);
    }
  }
  const timer = setInterval(sweep, CLEANUP_MS);
  if (timer.unref) timer.unref();

  /** Issue a fresh challenge and return the text shown to the human. */
  function issue() {
    sweep();
    const subtract = Math.random() < 0.5;
    let left = 1 + Math.floor(Math.random() * 20);
    let right = 1 + Math.floor(Math.random() * 20);
    if (subtract) {
      if (left < right) [left, right] = [right, left];
      if (left === right) left += 1; // keep the answer positive and unambiguous
    }
    const answer = subtract ? left - right : left + right;
    const op = subtract ? '-' : '+';
    const question = `${left} ${op} ${right} = ?`;

    const token = crypto.randomBytes(16).toString('hex');
    challenges.set(token, { answer, expiresAt: Date.now() + TTL });
    // Structured operands let automation solve the puzzle without parsing the
    // display text. The answer itself is never returned.
    return { token, question, left, op, right };
  }

  /**
   * Consume a challenge and check the submitted answer. The token is removed
   * on every attempt (success or failure), so a challenge cannot be replayed;
   * clients fetch a new one after a failed submit.
   */
  function verify(token, input) {
    if (!token) return false;
    const rec = challenges.get(token);
    challenges.delete(token);
    if (!rec || rec.expiresAt <= Date.now()) return false;
    if (typeof input !== 'string' && typeof input !== 'number') return false;
    const answer = Number(input);
    return Number.isInteger(answer) && answer === rec.answer;
  }

  return { issue, verify };
}

export function captchaCookie(token, secure = false) {
  const parts = [
    `${CAPTCHA_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(TTL / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function captchaFromRequest(req) {
  const cookies = String(req?.headers?.cookie || '');
  for (const part of cookies.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === CAPTCHA_COOKIE) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return '';
}
