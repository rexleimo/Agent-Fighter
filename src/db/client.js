import 'dotenv/config';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

const { Pool } = pg;

export function createDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL is required for the Postgres account store');
  const pool = new Pool({ connectionString: url, max: 10 });
  return { db: drizzle(pool, { schema }), pool };
}

let cached;

/** One pool per process; both Better Auth and the player store share it. */
export function getDb() {
  if (!cached) cached = createDb();
  return cached;
}
