import { PostgresPlayerStore } from './players-postgres.js';

let storePromise;

/**
 * One profile store per process. Better Auth and the game profile share the
 * same Postgres database; there is no second profile store.
 */
export function getPlayerStore() {
  if (!storePromise) storePromise = PostgresPlayerStore.create();
  return storePromise;
}
