// Shared helper for harnesses that create/login players over HTTP.
//
// Credential endpoints are captcha-guarded: the raw Better Auth sign-up/sign-in
// routes return 403. Callers must first fetch a challenge, solve it from the
// structured operands, and carry the challenge cookie into the guarded POST.

import { parseOr } from './no-throw.mjs';

/** Fetch a challenge and return its answer plus the httpOnly token cookie. */
export async function fetchCaptcha(base) {
  const res = await fetch(base + '/api/captcha');
  const text = await res.text();
  const data = await parseOr(text, null);
  if (!res.ok || !data || typeof data.left !== 'number'
    || typeof data.right !== 'number' || (data.op !== '+' && data.op !== '-')) {
    throw new Error('captcha challenge failed ' + res.status + ' ' + text.slice(0, 160));
  }
  const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const cookie = setCookie.map((line) => line.split(';')[0]).join('; ');
  const answer = data.op === '+' ? data.left + data.right : data.left - data.right;
  return { answer, cookie };
}
