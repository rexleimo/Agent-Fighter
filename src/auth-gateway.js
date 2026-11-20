import { auth } from './auth.js';

/**
 * Better Auth adapter (outer layer) for the credential-entry port.
 *
 * Translates better-auth's thrown API errors into the typed Result the
 * application layer expects. Framework specifics stop at this boundary.
 */
export function createAuthGateway() {
  return {
    isConfigured: () => Boolean(auth),

    async submit(kind, credentials) {
      if (!auth) {
        return {
          ok: false,
          status: 503,
          error: 'auth is not configured: set DATABASE_URL and run pnpm db:migrate',
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
    },
  };
}
