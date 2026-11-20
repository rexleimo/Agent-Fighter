/**
 * Shared frontend domain types.
 *
 * The definitions live in domain-scoped modules under `./types/` and are
 * re-exported here so every existing `from '.../lib/types'` import keeps
 * working unchanged. Component-local types that were previously inline in a
 * page/component are also exported from `./types/ui` (see below).
 */
export * from './types/core';
export * from './types/leaderboard';
export * from './types/training';
export * from './types/account';
export * from './types/ui';
