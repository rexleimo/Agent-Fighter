import { randomBytes } from 'node:crypto';

export const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/;

export function normalizeUsername(value) {
  const username = String(value || '').trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    throw new Error('username must be 3-32 characters: letters, digits, "_" or "-"');
  }
  return username;
}

export function cleanDisplayName(value, fallback) {
  const raw = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (raw || fallback).slice(0, 32);
}

export function newProfileId() {
  return 'ply_' + randomBytes(6).toString('hex');
}

export function publicPlayer(player, { includeMcpKey = false } = {}) {
  if (!player) return null;
  const mcp = player.mcpKey
    ? {
      assigned: true,
      issuedAt: player.mcpIssuedAt,
      ...(includeMcpKey ? { key: player.mcpKey, path: '/mcp/' + player.mcpKey } : {}),
    }
    : { assigned: false };
  return {
    id: player.id,
    userId: player.userId,
    username: player.username,
    displayName: player.displayName,
    role: player.role,
    status: player.status,
    agentId: player.agentId,
    mcp,
    createdAt: player.createdAt,
    lastLoginAt: player.lastLoginAt,
  };
}
