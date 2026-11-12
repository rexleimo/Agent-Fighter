import 'dotenv/config';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { username } from 'better-auth/plugins';
import { getDb } from './db/client.js';
import * as schema from './db/schema.js';
import { getPlayerStore } from './players.js';

function buildAuth() {
  if (!process.env.DATABASE_URL) return null;
  return betterAuth({
    database: drizzleAdapter(getDb().db, { provider: 'pg', schema }),
    secret: process.env.BETTER_AUTH_SECRET || 'dev-only-secret-change-me-at-least-32-chars',
    baseURL: process.env.BETTER_AUTH_URL || `http://localhost:${process.env.PORT || 8787}`,
    trustedOrigins: (process.env.BETTER_AUTH_TRUSTED_ORIGINS
      || `http://localhost:${process.env.PORT || 8787},http://localhost:5173,http://localhost:5174`)
      .split(',').map((origin) => origin.trim()).filter(Boolean),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            const players = await getPlayerStore();
            await players.createProfile({
              userId: user.id,
              username: user.username || user.email.split('@')[0],
              displayName: user.name || user.displayUsername || user.username || '玩家',
              role: 'player',
            });
          },
        },
      },
    },
    plugins: [
      username({
        minUsernameLength: 3,
        maxUsernameLength: 32,
        immutableUsername: true,
        usernameValidator: (value) => /^[a-z0-9][a-z0-9_-]*$/i.test(value),
        displayUsername: true,
      }),
    ],
  });
}

/**
 * Better Auth owns users, password hashes, email/password login, sessions and
 * cookies. It is only constructed when DATABASE_URL is configured; without a
 * database the game still runs but auth is explicitly disabled.
 */
export const auth = buildAuth();
