import { httpError } from './httpError.js';

export function createLobbyService({ accountService }) {
  const rooms = new Map();
  let nextId = 1;

  function publicRoom(room) {
    return {
      id: room.id,
      players: room.players,
      status: room.status,
      createdAt: room.createdAt,
    };
  }

  return {
    create(token) {
      const ownerId = accountService.resolveToken(token);
      const room = {
        id: `room_${nextId++}`,
        ownerId,
        players: [ownerId],
        status: 'waiting',
        createdAt: new Date().toISOString(),
      };
      rooms.set(room.id, room);
      return publicRoom(room);
    },

    join(token, roomId) {
      const playerId = accountService.resolveToken(token);
      const room = rooms.get(roomId);
      if (!room) {
        throw httpError(404, 'room_not_found');
      }
      if (room.status !== 'waiting') {
        throw httpError(409, 'room_already_started');
      }
      if (room.players.includes(playerId)) {
        return publicRoom(room);
      }
      if (room.players.length >= 2) {
        throw httpError(409, 'room_full');
      }
      room.players.push(playerId);
      room.status = 'ready';
      return publicRoom(room);
    },

    get(token, roomId) {
      accountService.resolveToken(token);
      const room = rooms.get(roomId);
      if (!room) {
        throw httpError(404, 'room_not_found');
      }
      return publicRoom(room);
    },

    list(token) {
      accountService.resolveToken(token);
      return [...rooms.values()].map(publicRoom);
    },
  };
}
