import { auth } from './auth.js';
import { createCaptchaStore } from './captcha.js';

/**
 * auth-entry.js — credential entry policy for the public surface.
 *
 * Owns the captcha challenge lifecycle and the decision of which better-auth
 * endpoint serves registration vs. login. Expected failures are returned as
 * typed results so the HTTP adapter needs no exception handling.
 */

const captcha = createCaptchaStore();

export function issueChallenge() {
  return captcha.issue();
}

export function isConfigured() {
  return Boolean(auth);
}

/**
 * Consume the challenge and submit credentials. Returns { ok: false, status,
 * error, code } for expected failures instead of throwing.
 */
export async function submitCredentials({ kind, captchaToken, captchaAnswer, credentials }) {
  if (!captcha.verify(captchaToken, captchaAnswer)) {
    return {
      ok: false,
      status: 400,
      error: '验证码错误或已过期，请重新输入',
      code: 'CAPTCHA_INVALID',
    };
  }

  const operation = kind === 'register'
    ? auth.api.signUpEmail({ body: credentials, returnHeaders: true })
    : auth.api.signInUsername({ body: credentials, returnHeaders: true });

  const settled = await operation.then(
    (result) => ({ ok: true, result }),
    (error) => ({ ok: false, error }),
  );

  if (!settled.ok) {
    const err = settled.error;
    return {
      ok: false,
      status: err?.statusCode ?? (typeof err?.status === 'number' ? err.status : 400),
      error: err?.body?.message ?? err?.message ?? (kind === 'register' ? 'registration failed' : 'login failed'),
      code: err?.body?.code,
    };
  }

  return { ok: true, result: settled.result };
}
