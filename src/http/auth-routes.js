/**
 * Credential-entry, first-run setup and Better Auth passthrough routes.
 * The raw Better Auth sign-up/sign-in endpoints stay blocked so the captcha
 * guard on /api/register and /api/login cannot be bypassed.
 */
import { needsSetup, createFirstAdmin } from '../auth-bootstrap.js';
import { captchaCookie, captchaFromRequest } from '../captcha.js';
import { authUnavailable, isSecureRequest, json, readJson } from './shared.js';

const NOT_CONFIGURED = 'auth is not configured: set DATABASE_URL and run pnpm db:migrate';

/** Credential entry and Better Auth passthrough. Returns true when handled. */
export async function handleCredentialRoutes(ctx, req, res, url, p) {
  const { players, auth, handleAuth, authEntry } = ctx;

  if (p === '/api/captcha' && req.method === 'GET') {
    if (!authEntry.isConfigured()) { json(res, 503, { error: NOT_CONFIGURED }); return true; }
    const challenge = authEntry.issueChallenge();
    const { token, ...payload } = challenge;
    json(res, 200, payload, { 'Set-Cookie': captchaCookie(token, isSecureRequest(req)) });
    return true;
  }

  if ((p === '/api/login' || p === '/api/register') && req.method === 'POST') {
    if (!authEntry.isConfigured()) { json(res, 503, { error: NOT_CONFIGURED }); return true; }
    const args = await readJson(req) ?? {};
    const { captchaAnswer, ...credentials } = args;
    const outcome = await authEntry.submitCredentials({
      kind: p === '/api/register' ? 'register' : 'login',
      captchaToken: captchaFromRequest(req),
      captchaAnswer,
      credentials,
    });
    if (!outcome.ok) {
      json(res, outcome.status, { error: outcome.error, code: outcome.code });
      return true;
    }
    const headers = outcome.result.headers;
    const cookies = typeof headers?.getSetCookie === 'function'
      ? headers.getSetCookie()
      : (headers?.get?.('set-cookie') ? [headers.get('set-cookie')] : []);
    const user = outcome.result.response?.user ?? outcome.result.user ?? null;
    json(res, 200, { ok: true, user }, cookies.length ? { 'Set-Cookie': cookies } : {});
    return true;
  }

  if (p.startsWith('/api/auth/')) {
    if (p === '/api/auth/sign-up/email' || p === '/api/auth/sign-in/username') {
      json(res, 403, { error: 'credential endpoints are captcha-guarded: use /api/register or /api/login' });
      return true;
    }
    if (!handleAuth) { authUnavailable(res); return true; }
    await handleAuth(req, res);
    return true;
  }

  return false;
}

/** First-run administrator setup. Returns true when handled. */
export async function handleSetupRoutes(ctx, req, res, url, p) {
  const { players, auth } = ctx;

  if (p === '/api/setup/status' && req.method === 'GET') {
    json(res, 200, { needsSetup: await needsSetup({ players }) });
    return true;
  }

  if (p === '/api/setup' && req.method === 'POST') {
    if (!players || !auth) { authUnavailable(res); return true; }
    const args = await readJson(req);
    await createFirstAdmin({ auth, players, input: args }).then(
      ({ profile, headers }) => {
        const cookies = typeof headers?.getSetCookie === 'function' ? headers.getSetCookie() : [];
        json(res, 200, { player: players.publicPlayer(profile) }, cookies.length ? { 'Set-Cookie': cookies } : {});
      },
      (err) => {
        if (err?.code === 'SETUP_DONE') json(res, 409, { error: 'setup is already complete' });
        else json(res, 400, { error: err?.message || 'setup failed' });
      },
    );
    return true;
  }

  return false;
}
