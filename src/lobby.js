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
  const updateOwner = db.prepare('UPDATE rooms SET owner_id = ? WHERE id = ?');
  const updateMap = db.prepare('UPDATE rooms SET map_json = ? WHERE id = ?');
  const updateShipData = db.prepare('UPDATE rooms SET ship_data_json = ? WHERE id = ?');
  const deletePlayer = db.prepare('DELETE FROM room_players WHERE room_id = ? AND player_id = ?');
  const deleteBattles = db.prepare('DELETE FROM battles WHERE room_id = ?');
  const deleteRoom = db.prepare('DELETE FROM rooms WHERE id = ?');
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
      hasMap: Boolean(row.map_json),
      hasShipData: Boolean(row.ship_data_json),
    };
  }

  function publicRoom(room) {
    return {
      id: room.id,
      ownerId: room.ownerId,
      players: room.players,
      status: room.status,
      createdAt: room.createdAt,
      hasMap: room.hasMap,
      hasShipData: room.hasShipData,
    };
  }

  function requireMember(room, userId) {
    if (!room.players.includes(userId)) {
      throw httpError(403, 'not_in_room');
    }
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

    setMap(token, roomId, mapJson) {
      const user = accountService.resolveToken(token);
      const room = loadRoom(roomId);
      if (!room) {
        throw httpError(404, 'room_not_found');
      }
      if (room.ownerId !== user.id) {
        throw httpError(403, 'not_room_owner');
      }
      if (typeof mapJson !== 'string' || mapJson.length === 0) {
        throw httpError(400, 'map_required');
      }
      try {
        JSON.parse(mapJson);
      } catch {
        throw httpError(400, 'invalid_map_json');
      }
      updateMap.run(mapJson, roomId);
      return publicRoom(loadRoom(roomId));
    },

    setShipData(token, roomId, shipDataJson) {
      const user = accountService.resolveToken(token);
      const room = loadRoom(roomId);
      if (!room) {
        throw httpError(404, 'room_not_found');
      }
      if (room.ownerId !== user.id) {
        throw httpError(403, 'not_room_owner');
      }
      if (typeof shipDataJson !== 'string' || shipDataJson.length === 0) {
        throw httpError(400, 'ship_data_required');
      }
      try {
        JSON.parse(shipDataJson);
      } catch {
        throw httpError(400, 'invalid_ship_data_json');
      }
      updateShipData.run(shipDataJson, roomId);
      return publicRoom(loadRoom(roomId));
    },

    getMap(token, roomId) {
      const user = accountService.resolveToken(token);
      const room = loadRoom(roomId);
      if (!room) {
        throw httpError(404, 'room_not_found');
      }
      requireMember(room, user.id);
      if (!room.hasMap) {
        return null;
      }
      return JSON.parse(selectRoom.get(roomId).map_json);
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

    leave(token, roomId) {
      const user = accountService.resolveToken(token);
      const room = loadRoom(roomId);
      if (!room) {
        return null;
      }
      if (!room.players.includes(user.id)) {
        return publicRoom(room);
      }

      db.transaction(() => {
        deletePlayer.run(roomId, user.id);
        const remaining = selectPlayers
          .all(roomId)
          .map((entry) => entry.player_id);
        if (remaining.length === 0) {
          deleteBattles.run(roomId);
          deleteRoom.run(roomId);
        } else {
          if (room.ownerId === user.id) {
            updateOwner.run(remaining[0], roomId);
          }
          updateStatus.run(remaining.length >= 2 ? 'ready' : 'waiting', roomId);
        }
      })();

      return loadRoom(roomId);
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
        .map((entry) => loadRoom(entry.id))
        .filter((room) => room && (room.status === 'waiting' || room.status === 'ready'))
        .map(publicRoom);
    },
  };
}
