import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';
import { user } from './auth-schema.js';

export * from './auth-schema.js';

/**
 * App-owned player profile. Better Auth owns identity, password hashes and
 * sessions in `user` / `account` / `session`; this table only stores the game
 * bindings a human or Agent needs: role, agent slot and MCP service key.
 */
export const players = pgTable('players', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().unique().references(() => user.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('player'),
  status: text('status').notNull().default('active'),
  agentId: text('agent_id'),
  mcpKey: text('mcp_key').unique(),
  mcpIssuedAt: timestamp('mcp_issued_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
}, (table) => [
  index('players_mcp_key_idx').on(table.mcpKey),
  index('players_role_idx').on(table.role),
]);
