import { randomBytes, randomInt } from 'node:crypto';

import { httpError } from './httpError.js';

export function createBattleService({ db, accountService, lobbyService }) {
  const insertBattle = db.prepare(
    'INSERT INTO battles (id, room_id, players_json, turn, phase, status, started_at) VALUES (?, ?, ?, 0, ?, ?, ?)',
  );
  const selectBattle = db.prepare('SELECT * FROM battles WHERE id = ?');
  const updateRoomStatus = db.prepare("UPDATE rooms SET status = 'battle' WHERE id = ?");
  const insertRoll = db.prepare(
    'INSERT INTO rolls (user_id, count, sides, values_json, reason, at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const selectRolls = db.prepare('SELECT * FROM rolls ORDER BY id DESC LIMIT 200');

  function loadBattle(battleId) {
    const row = selectBattle.get(battleId);
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      roomId: row.room_id,
      players: JSON.parse(row.players_json),
      turn: row.turn,
      phase: row.phase,
      status: row.status,
      startedAt: row.started_at,
    };
  }

  function requireMember(battle, userId) {
    if (!battle.players.includes(userId)) {
      throw httpError(403, 'not_in_battle');
    }
  }

  return {
    start(token, roomId) {
      const user = accountService.resolveToken(token);
      const room = lobbyService.get(token, roomId);
      if (!room.players.includes(user.id)) {
        throw httpError(403, 'not_in_room');
      }
      if (room.players.length < 2) {
        throw httpError(409, 'room_not_ready');
      }
      const battle = {
        id: `battle_${randomBytes(6).toString('hex')}`,
        roomId,
        players: room.players,
        turn: 0,
        phase: 'setup',
        status: 'active',
        startedAt: new Date().toISOString(),
      };
      db.transaction(() => {
        insertBattle.run(
          battle.id,
          battle.roomId,
          JSON.stringify(battle.players),
          battle.phase,
          battle.status,
          battle.startedAt,
        );
        updateRoomStatus.run(roomId);
      })();
      return battle;
    },

    get(token, battleId) {
      const user = accountService.resolveToken(token);
      const battle = loadBattle(battleId);
      if (!battle) {
        throw httpError(404, 'battle_not_found');
      }
      requireMember(battle, user.id);
      return battle;
    },

    roll(token, { battleId, count = 1, sides = 100, reason = 'generic' }) {
      const user = accountService.resolveToken(token);
      if (!battleId) {
        throw httpError(400, 'battle_required');
      }
      const battle = loadBattle(battleId);
      if (!battle) {
        throw httpError(404, 'battle_not_found');
      }
      requireMember(battle, user.id);
      const safeCount = Math.max(1, Math.min(100, Number(count) || 1));
      const safeSides = Math.max(2, Math.min(1000, Number(sides) || 100));
      const values = Array.from({ length: safeCount }, () => randomInt(1, safeSides + 1));
      const at = new Date().toISOString();
      const result = insertRoll.run(user.id, safeCount, safeSides, JSON.stringify(values), reason, at);
      return {
        id: Number(result.lastInsertRowid),
        battleId,
        roomId: battle.roomId,
        values,
        sides: safeSides,
        count: safeCount,
        reason,
        at,
      };
    },

    rollLog(token) {
      accountService.resolveToken(token);
      return selectRolls
        .all()
        .map((row) => ({
          id: row.id,
          userId: row.user_id,
          count: row.count,
          sides: row.sides,
          values: JSON.parse(row.values_json),
          reason: row.reason,
          at: row.at,
        }));
    },
  };
}
