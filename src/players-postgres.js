import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from './db/client.js';
import { players, user } from './db/schema.js';
import { newProfileId, publicPlayer } from './player-shared.js';

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function toPlayer(row) {
  if (!row) return null;
  const profile = row.profile;
  const account = row.user;
  return {
    id: profile.id,
    userId: profile.userId,
    username: account?.username || account?.email?.split('@')[0] || '',
    displayName: account?.name || account?.displayUsername || account?.username || '',
    role: profile.role,
    status: profile.status,
    agentId: profile.agentId,
    mcpKey: profile.mcpKey,
    mcpIssuedAt: iso(profile.mcpIssuedAt),
    createdAt: iso(profile.createdAt),
    lastLoginAt: iso(profile.lastLoginAt),
  };
}

export class PostgresPlayerStore {
  static async create() {
    return new PostgresPlayerStore();
  }

  constructor() {
    this.db = getDb().db;
  }

  async createProfile({ userId, username, displayName, role = 'player' } = {}) {
    const [existing] = await this.db.select().from(players).where(eq(players.userId, userId)).limit(1);
    if (existing) return this.playerByUserId(userId);
    try {
      await this.db.insert(players).values({
        id: newProfileId(),
        userId,
        role: role === 'admin' ? 'admin' : 'player',
      });
    } catch (err) {
      const code = err && (err.code ?? err.cause?.code);
      if (code !== '23505') {
        console.error('[afl] profile insert failed:', err?.message ?? err);
        throw new Error('could not create player profile');
      }
    }
    return this.playerByUserId(userId);
  }

  async playerByUserId(userId) {
    if (!userId) return null;
    const [row] = await this.db.select({ profile: players, user })
      .from(players)
      .innerJoin(user, eq(players.userId, user.id))
      .where(eq(players.userId, userId))
      .limit(1);
    return toPlayer(row);
  }

  async playerById(playerId) {
    if (!playerId) return null;
    const [row] = await this.db.select({ profile: players, user })
      .from(players)
      .innerJoin(user, eq(players.userId, user.id))
      .where(eq(players.id, playerId))
      .limit(1);
    return toPlayer(row);
  }

  async playerByMcpKey(key) {
    if (!key) return null;
    const [row] = await this.db.select({ profile: players, user })
      .from(players)
      .innerJoin(user, eq(players.userId, user.id))
      .where(eq(players.mcpKey, String(key)))
      .limit(1);
    return row && row.profile.status === 'active' ? toPlayer(row) : null;
  }

  async findAdmin() {
    const [row] = await this.db.select({ profile: players, user })
      .from(players)
      .innerJoin(user, eq(players.userId, user.id))
      .where(eq(players.role, 'admin'))
      .limit(1);
    return toPlayer(row);
  }

  async listPlayers({ includeMcpKey = false } = {}) {
    const rows = await this.db.select({ profile: players, user })
      .from(players)
      .innerJoin(user, eq(players.userId, user.id))
      .orderBy(players.createdAt);
    return rows.map((row) => this.publicPlayer(toPlayer(row), { includeMcpKey }));
  }

  async linkAgent(playerId, agentId) {
    const result = await this.db.update(players).set({ agentId }).where(eq(players.id, playerId)).returning();
    if (!result.length) throw new Error('player not found');
    return this.playerById(playerId);
  }

  async setRole(playerId, role) {
    const result = await this.db.update(players).set({ role: role === 'admin' ? 'admin' : 'player' }).where(eq(players.id, playerId)).returning();
    if (!result.length) throw new Error('player not found');
    return this.playerById(playerId);
  }

  async issueMcp(playerId) {
    const key = 'mcp_' + randomBytes(24).toString('base64url');
    const [row] = await this.db.update(players)
      .set({ mcpKey: key, mcpIssuedAt: new Date() })
      .where(eq(players.id, playerId))
      .returning();
    if (!row) throw new Error('player not found');
    return {
      key,
      path: '/mcp/' + key,
      issuedAt: iso(row.mcpIssuedAt),
    };
  }

  publicPlayer(player, options) {
    return publicPlayer(player, options);
  }
}
