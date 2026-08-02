import { randomBytes } from 'node:crypto';

import { httpError } from './httpError.js';

export function createLobbyService({ db, accountService }) {
  const insertRoom = db.prepare('INSERT INTO rooms (id, owner_id, status, created_at) VALUES (?, ?, ?, ?)');
  const selectRoom = db.prepare('SELECT * FROM rooms WHERE id = ?');
  const selectPlayers = db.prepare(
    'SELECT player_id FROM room_players WHERE room_id = ? ORDER BY rowid',
  );
  const insertPlayer = db.prepare('INSERT INTO room_players (room_id, player_id) VALUES (?, ?)');
  const updateStatus = db.prepare('UPDATE rooms SET status = ? WHERE id = ?');
  const selectRoomIds = db.prepare('SELECT id FROM rooms ORDER BY created_at DESC');

  function loadRoom(roomId) {
    const row = selectRoom.get(roomId);
    if (!row) {
      return null;
    }
    const players = selectPlayers.all(roomId).map((entry) => entry.player_id);
    return {
      id: row.id,
      ownerId: row.owner_id,
      players,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  function publicRoom(room) {
    return {
      id: room.id,
      ownerId: room.ownerId,
      players: room.players,
      status: room.status,
      createdAt: room.createdAt,
    };
  }

  return {
    create(token) {
      const user = accountService.resolveToken(token);
      const roomId = `room_${randomBytes(6).toString('hex')}`;
      db.transaction(() => {
        insertRoom.run(roomId, user.id, 'waiting', new Date().toISOString());
        insertPlayer.run(roomId, user.id);
      })();
      return publicRoom(loadRoom(roomId));
    },

    join(token, roomId) {
      const user = accountService.resolveToken(token);
      const room = loadRoom(roomId);
      if (!room) {
        throw httpError(404, 'room_not_found');
      }
      if (room.status !== 'waiting') {
        throw httpError(409, 'room_already_started');
      }
      if (room.players.includes(user.id)) {
        return publicRoom(room);
      }
      if (room.players.length >= 2) {
        throw httpError(409, 'room_full');
      }
      db.transaction(() => {
        insertPlayer.run(roomId, user.id);
        updateStatus.run('ready', roomId);
      })();
      return publicRoom(loadRoom(roomId));
    },

    get(token, roomId) {
      accountService.resolveToken(token);
      const room = loadRoom(roomId);
      if (!room) {
        throw httpError(404, 'room_not_found');
      }
      return publicRoom(room);
    },

    list(token) {
      accountService.resolveToken(token);
      return selectRoomIds
        .all()
        .map((entry) => publicRoom(loadRoom(entry.id)))
        .filter(Boolean);
    },
  };
}
