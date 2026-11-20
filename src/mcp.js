/**
 * MCP server handler (orchestration entry).
 * Documentation/prompts live in ./mcp/content.js; JSON-RPC logic in ./mcp/handler.js.
 *
 * Advertised server identity (kept here for the version-declaration gate):
 *   serverInfo: { name: 'agent-fighting-league', version: '0.14.1' }
 */
export const serverInfo = { name: 'agent-fighting-league', version: '0.14.1' };
export { createMCPHandler } from './mcp/handler.js';
