import { randomBytes } from 'node:crypto';
import { normalizeUsername } from './player-shared.js';

/**
 * Create the first admin through Better Auth (so the password hash and
 * account row are standard), then promote the profile row to admin.
 */
export async function bootstrapAdmin({ auth, players }) {
  if (!auth) return null;
  const existing = await players.findAdmin();
  if (existing) return existing;

  const username = normalizeUsername(process.env.AFL_ADMIN_USERNAME || 'admin');
  const password = process.env.AFL_ADMIN_PASSWORD || randomBytes(15).toString('base64url');
  const email = `${username}@players.local`;

  let result;
  try {
    result = await auth.api.signUpEmail({
      body: {
        email,
        password,
        name: '联赛管理员',
        username,
      },
    });
  } catch (err) {
    console.error('[afl] admin bootstrap failed:', err?.message ?? err);
    throw new Error('could not create the admin account; check AFL_ADMIN_USERNAME / AFL_ADMIN_PASSWORD and the auth schema');
  }

  let profile = await players.playerByUserId(result.user.id);
  if (!profile) {
    profile = await players.createProfile({
      userId: result.user.id,
      username,
      displayName: '联赛管理员',
      role: 'admin',
    });
  } else {
    profile = await players.setRole(profile.id, 'admin');
  }

  if (process.env.AFL_ADMIN_PASSWORD) {
    console.log('[afl] admin account "' + username + '" created from AFL_ADMIN_PASSWORD');
  } else {
    console.log('[afl] admin account "' + username + '" password: ' + password);
    console.log('[afl] set AFL_ADMIN_PASSWORD (and AFL_ADMIN_USERNAME) to choose your own credentials');
  }
  return profile;
}
