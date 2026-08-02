import { WebSocketServer } from 'ws';

import { httpError } from './httpError.js';

export function createRealtimeHub({ server, accountService, lobbyService, battleService }) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const socketAuth = new Map();
  const socketRooms = new Map();
  const roomSockets = new Map();

  function send(ws, message) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(message));
    }
  }

  function broadcast(roomId, message) {
    for (const ws of roomSockets.get(roomId) || []) {
      send(ws, message);
    }
  }

  function sendError(ws, code) {
    send(ws, { type: 'error', code });
  }

  function requireAuth(ws) {
    const auth = socketAuth.get(ws);
    if (!auth) {
      throw httpError(401, 'auth_required');
    }
    return auth;
  }

  function joinRoom(ws, roomId) {
    const auth = requireAuth(ws);
    lobbyService.get(auth.token, roomId);
    socketRooms.get(ws).add(roomId);
    if (!roomSockets.has(roomId)) {
      roomSockets.set(roomId, new Set());
    }
    roomSockets.get(roomId).add(ws);
  }

  function leaveRoom(ws, roomId) {
    socketRooms.get(ws).delete(roomId);
    const members = roomSockets.get(roomId);
    if (members) {
      members.delete(ws);
      if (members.size === 0) {
        roomSockets.delete(roomId);
      }
    }
  }

  wss.on('connection', (ws) => {
    socketAuth.set(ws, null);
    socketRooms.set(ws, new Set());

    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        sendError(ws, 'bad_json');
        return;
      }

      try {
        switch (message.type) {
          case 'auth': {
            const user = accountService.resolveToken(message.token);
            socketAuth.set(ws, { token: message.token, user });
            send(ws, { type: 'auth.ok', user: accountService.getUser(message.token) });
            break;
          }
          case 'lobby.join': {
            const auth = requireAuth(ws);
            joinRoom(ws, message.roomId);
            send(ws, { type: 'room.state', room: lobbyService.get(auth.token, message.roomId) });
            break;
          }
          case 'lobby.leave': {
            leaveRoom(ws, message.roomId);
            send(ws, { type: 'lobby.left', roomId: message.roomId });
            break;
          }
          case 'battle.roll': {
            const auth = requireAuth(ws);
            const roll = battleService.roll(auth.token, message);
            const battle = battleService.get(auth.token, message.battleId);
            broadcast(battle.roomId, { type: 'battle.rolled', battleId: battle.id, roll });
            break;
          }
          default:
            sendError(ws, 'unknown_message');
        }
      } catch (err) {
        sendError(ws, err.code || err.message || 'internal_error');
      }
    });

    ws.on('close', () => {
      const rooms = socketRooms.get(ws);
      if (rooms) {
        for (const roomId of rooms) {
          const members = roomSockets.get(roomId);
          if (members) {
            members.delete(ws);
            if (members.size === 0) {
              roomSockets.delete(roomId);
            }
          }
        }
      }
      socketRooms.delete(ws);
      socketAuth.delete(ws);
    });
  });

  return { broadcast, wss };
}
