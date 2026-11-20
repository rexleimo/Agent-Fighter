/**
 * Rooms and matchmaking (orchestration entry).
 * ./rooms/room-* owns the Room lifecycle and ./rooms/manager-* the lobby.
 * Both public classes are re-exported unchanged.
 */
export { Room } from './rooms/room.js';
export { RoomManager } from './rooms/manager.js';
