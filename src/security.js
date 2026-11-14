/**
 * security.js — minimum production hardening for the public HTTP surface.
 *
 * Three independently configurable concerns:
 *   1. Request-body byte cap   — memory-exhaustion / DoS guard (413)
 *   2. Per-IP sliding-window rate limit — abuse / brute-force guard (429)
 *   3. Baseline security response headers
 *
 * Defaults are generous enough for normal play and the bundled test suites;
 * tighten them via env for a hardened public deployment (see docs/deployment.md).
 * Keeping this logic in one deep module keeps server.js's route code unchanged.
 */

export const BODY_LIMIT = Number(process.env.AFL_MAX_BODY_BYTES || 1_048_576); // 1 MiB

export class BodyTooLargeError extends Error {
  constructor(limit) {
    super(`request body exceeds ${limit} bytes`);
    this.name = 'BodyTooLargeError';
    this.limit = limit;
  }
}

/** Read a request body with a hard byte cap; rejects and destroys on overflow. */
export function readBodyCapped(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > limit) {
        aborted = true;
        reject(new BodyTooLargeError(limit));
        req.pause(); // stop buffering; the handler replies 413 with Connection: close
        return;
      }
      body += chunk;
    });
    req.on('end', () => { if (!aborted) resolve(body); });
    req.on('error', (err) => { if (!aborted) reject(err); });
  });
}

/** True when the request arrived over TLS (directly or via a trusted proxy). */
export function isSecure(req) {
  return Boolean(req.socket && req.socket.encrypted)
    || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

// Conservative CSP: blocks framing/object/embedding while allowing the inline
// styles/scripts and ws(s) connections the arcade UI needs. Tighten once the
// frontend is confirmed nonce/hash-compatible.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self' ws: wss:",
  "font-src 'self' data:",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
].join('; ');

export function applySecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', CSP);
  if (isSecure(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

/** Client IP. Trust X-Forwarded-For only when AFL_TRUST_PROXY=1 (behind a known proxy). */
export function clientIp(req) {
  if (process.env.AFL_TRUST_PROXY === '1') {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/** Sliding-window per-key limiter. max <= 0 disables it. */
export class RateLimiter {
  constructor({ windowMs = 60_000, max = 1000, name = 'global' } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.name = name;
    this.hits = new Map();
  }
  check(key) {
    if (this.max <= 0) return { allowed: true, retryAfter: 0, remaining: Infinity };
    const now = Date.now();
    let arr = this.hits.get(key);
    if (!arr) { arr = []; this.hits.set(key, arr); }
    const cutoff = now - this.windowMs;
    while (arr.length && arr[0] <= cutoff) arr.shift();
    if (arr.length >= this.max) {
      const retryAfter = Math.max(1, Math.ceil((arr[0] + this.windowMs - now) / 1000));
      return { allowed: false, retryAfter, remaining: 0 };
    }
    arr.push(now);
    return { allowed: true, retryAfter: 0, remaining: this.max - arr.length };
  }
  sweep() {
    const cutoff = Date.now() - this.windowMs;
    for (const [k, arr] of this.hits) {
      while (arr.length && arr[0] <= cutoff) arr.shift();
      if (!arr.length) this.hits.delete(k);
    }
  }
}

export function createLimiters() {
  const auth = new RateLimiter({ name: 'auth', max: Number(process.env.AFL_RATE_AUTH ?? 300) });
  const global = new RateLimiter({ name: 'global', max: Number(process.env.AFL_RATE_GLOBAL ?? 3000) });
  const timer = setInterval(() => { auth.sweep(); global.sweep(); }, 60_000);
  if (timer.unref) timer.unref();
  return { auth, global };
}