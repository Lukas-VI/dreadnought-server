import { randomInt } from 'node:crypto';

import { httpError } from './httpError.js';

export function createBattleService({ accountService, lobbyService }) {
  const battles = new Map();
  const rolls = [];
  let nextId = 1;

  return {
    start(token, roomId) {
      const playerId = accountService.resolveToken(token);
      const room = lobbyService.get(token, roomId);
      if (!room.players.includes(playerId)) {
        throw httpError(403, 'not_in_room');
      }
      if (room.players.length < 2) {
        throw httpError(409, 'room_not_ready');
      }
      const battle = {
        id: `battle_${nextId++}`,
        roomId,
        players: room.players,
        turn: 0,
        phase: 'setup',
        status: 'active',
        startedAt: new Date().toISOString(),
      };
      battles.set(battle.id, battle);
      return battle;
    },

    roll(token, { count = 1, sides = 100, reason = 'generic' }) {
      accountService.resolveToken(token);
      const safeCount = Math.max(1, Math.min(100, Number(count) || 1));
      const safeSides = Math.max(2, Math.min(1000, Number(sides) || 100));
      const values = Array.from({ length: safeCount }, () => randomInt(1, safeSides + 1));
      const record = {
        id: rolls.length + 1,
        count: safeCount,
        sides: safeSides,
        values,
        reason,
        at: new Date().toISOString(),
      };
      rolls.push(record);
      return { id: record.id, values, sides: safeSides };
    },

    rollLog(token) {
      accountService.resolveToken(token);
      return rolls;
    },
  };
}
