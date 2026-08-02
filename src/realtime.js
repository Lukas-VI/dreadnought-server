import { WebSocketServer } from 'ws';

import { httpError } from './httpError.js';

export function createRealtimeHub({
  server,
  accountService,
  lobbyService,
  battleService,
  battleStateService,
}) {
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

  function cleanupPlayerRooms(ws) {
    const auth = socketAuth.get(ws);
    const rooms = socketRooms.get(ws);
    if (!auth || !rooms) {
      return;
    }

    for (const roomId of rooms) {
      try {
        const room = lobbyService.leave(auth.token, roomId);
        if (room) {
          broadcast(room.id, { type: 'room.updated', room });
        } else {
          broadcast(roomId, { type: 'room.removed', roomId });
        }
      } catch {
        // 房间可能已被删除，忽略清理竞态。
      }
      leaveRoom(ws, roomId);
    }
  }

  wss.on('connection', (ws) => {
    console.log('[ws] connection', new Date().toISOString());
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
            console.log('[ws] auth', user.id, new Date().toISOString());
            send(ws, { type: 'auth.ok', user: accountService.getUser(message.token) });
            break;
          }
          case 'lobby.join': {
            const auth = requireAuth(ws);
            joinRoom(ws, message.roomId);
            console.log('[ws] join', auth.user.id, message.roomId);
            send(ws, { type: 'room.state', room: lobbyService.get(auth.token, message.roomId) });
            break;
          }
          case 'lobby.leave': {
            const auth = requireAuth(ws);
            console.log('[ws] leave', auth.user.id, message.roomId);
            const room = lobbyService.leave(auth.token, message.roomId);
            if (room) {
              broadcast(room.id, { type: 'room.updated', room });
            } else {
              broadcast(message.roomId, { type: 'room.removed', roomId: message.roomId });
            }
            leaveRoom(ws, message.roomId);
            send(ws, { type: 'lobby.left', roomId: message.roomId });
            break;
          }
          case 'battle.roll': {
            const auth = requireAuth(ws);
            console.log('[ws] roll', auth.user.id, message.battleId, new Date().toISOString());
            const roll = battleService.roll(auth.token, message);
            const battle = battleService.get(auth.token, message.battleId);
            broadcast(battle.roomId, { type: 'battle.rolled', battleId: battle.id, roll });
            break;
          }
          case 'battle.state.get': {
            const auth = requireAuth(ws);
            const state = battleStateService.getState(auth.token, message.battleId);
            send(ws, { type: 'battle.state', state });
            break;
          }
          case 'battle.command': {
            const auth = requireAuth(ws);
            const state = battleStateService.command(auth.token, message);
            broadcast(state.roomId, { type: 'battle.state', state });
            break;
          }
          case 'battle.advance': {
            const auth = requireAuth(ws);
            const state = battleStateService.advance(auth.token, message);
            broadcast(state.roomId, { type: 'battle.state', state });
            break;
          }
          default:
            sendError(ws, 'unknown_message');
        }
      } catch (err) {
        sendError(ws, err.code || err.message || 'internal_error');
      }
    });

    ws.on('close', (code, reason) => {
      const auth = socketAuth.get(ws);
      console.log('[ws] close', auth?.user?.id, code, reason, new Date().toISOString());
      cleanupPlayerRooms(ws);
      socketRooms.delete(ws);
      socketAuth.delete(ws);
    });
  });

  return { broadcast, wss };
}
