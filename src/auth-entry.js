import { createCaptchaStore } from './captcha.js';

/**
 * Credential-entry policy (application layer).
 *
 * Owns the captcha challenge lifecycle and the rule that a challenge must be
 * consumed before any credential submission. It knows nothing about
 * better-auth, HTTP, or sessions: `credentialGateway` is the port through which
 * the outer adapter performs the actual authentication. This keeps the policy
 * independently testable and makes the dependency direction point inward.
 */
export function createAuthEntry({ credentialGateway, captchaStore = createCaptchaStore() }) {
  function issueChallenge() {
    return captchaStore.issue();
  }

  function isConfigured() {
    return credentialGateway.isConfigured();
  }

  /**
   * Consume the challenge, then delegate to the gateway. Expected failures come
   * back as typed results so no caller needs an exception boundary.
   */
  async function submitCredentials({ kind, captchaToken, captchaAnswer, credentials }) {
    if (!captchaStore.verify(captchaToken, captchaAnswer)) {
      return {
        ok: false,
        status: 400,
        error: '验证码错误或已过期，请重新输入',
        code: 'CAPTCHA_INVALID',
      };
    }
    return credentialGateway.submit(kind, credentials);
  }

  return { issueChallenge, isConfigured, submitCredentials };
}
