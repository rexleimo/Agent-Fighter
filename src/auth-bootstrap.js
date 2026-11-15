import { normalizeUsername, cleanDisplayName } from './player-shared.js';

/**
 * First-run setup: the ONE way an administrator is created.
 *
 * While the player store has no admin, the server offers POST /api/setup
 * (and the web app guides visitors to /setup). Once an admin exists the
 * setup is locked forever — there is no reopen path, by design. The lock is
 * the database state itself (an admin row), so it survives restarts.
 *
 * A process-level mutex serializes concurrent setup attempts; combined with
 * the findAdmin() re-check inside the critical section this closes the
 * land-grab race on the single-instance architecture (docs/deployment.md §7).
 */

export async function needsSetup({ players }) {
  if (!players) return false;
  return !(await players.findAdmin());
}

let setupLock = Promise.resolve();

export function createFirstAdmin({ auth, players, input }) {
  const run = setupLock.then(async () => {
    const existing = await players.findAdmin();
    if (existing) {
      const err = new Error('setup is already complete');
      err.code = 'SETUP_DONE';
      throw err;
    }

    const username = normalizeUsername(input?.username);
    const password = String(input?.password || '');
    if (password.length < 8) throw new Error('password must be at least 8 characters');
    if (password.length > 128) throw new Error('password must be at most 128 characters');
    const displayName = cleanDisplayName(input?.displayName, username);
    const email = `${username}@players.local`;

    // Standard better-auth signup so the password hash and account row are
    // indistinguishable from any other account; returnHeaders carries the
    // auto-sign-in session cookie back to the caller.
    const result = await auth.api.signUpEmail({
      body: { email, password, name: displayName, username },
      returnHeaders: true,
    });
    const user = result.response?.user ?? result.user;
    if (!user?.id) throw new Error('admin signup did not return a user');

    let profile = await players.playerByUserId(user.id);
    if (!profile) {
      profile = await players.createProfile({
        userId: user.id,
        username,
        displayName,
        role: 'admin',
      });
    } else {
      profile = await players.setRole(profile.id, 'admin');
    }
    console.log('[afl] admin account "' + username + '" created through first-run setup');
    return { profile, headers: result.headers };
  });
  // Keep the chain alive even when this attempt fails validation.
  setupLock = run.catch(() => {});
  return run;
}
