import { httpError } from './httpError.js';

export function createAdminService({ db, accountService }) {
  function requireAdmin(token) {
    const user = accountService.resolveToken(token);
    if (user.role !== 'admin') {
      throw httpError(403, 'admin_required');
    }
    return user;
  }

  function stats() {
    const row = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM users WHERE role = 'admin') AS admins,
        (SELECT COUNT(*) FROM users WHERE banned = 1) AS banned,
        (SELECT COUNT(*) FROM rooms) AS rooms,
        (SELECT COUNT(*) FROM battles) AS battles,
        (SELECT COUNT(*) FROM battles WHERE status = 'active') AS activeBattles,
        (SELECT COUNT(*) FROM sessions) AS sessions,
        (SELECT COUNT(*) FROM rolls) AS rolls,
        (SELECT COUNT(*) FROM gacha_pulls) AS pulls,
        (SELECT COALESCE(SUM(credits), 0) FROM users) AS credits
    `).get();
    return row;
  }

  function dailyCounts(days = 14) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const daySeries = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      daySeries.push(day);
    }
    const byDay = (table, column) => {
      const rows = db.prepare(`
        SELECT substr(${column}, 1, 10) AS day, COUNT(*) AS count
        FROM ${table}
        WHERE substr(${column}, 1, 10) >= ?
        GROUP BY day
      `).all(since);
      const map = new Map(rows.map((row) => [row.day, row.count]));
      return daySeries.map((day) => ({ day, count: map.get(day) || 0 }));
    };
    return {
      users: byDay('users', 'created_at'),
      sessions: byDay('sessions', 'created_at'),
      rolls: byDay('rolls', 'at'),
      pulls: byDay('gacha_pulls', 'created_at'),
      battles: byDay('battles', 'started_at'),
    };
  }

  function listUsers({ search = '', page = 1, pageSize = 20 } = {}) {
    const safePage = Math.max(1, Number(page) || 1);
    const safeSize = Math.min(100, Math.max(1, Number(pageSize) || 20));
    const like = `%${search}%`;
    const total = db.prepare(`
      SELECT COUNT(*) AS count FROM users
      WHERE ? = '' OR username LIKE ? OR email LIKE ?
    `).get(search, like, like).count;
    const rows = db.prepare(`
      SELECT u.id, u.username, u.email, u.role, u.banned, u.credits, u.created_at,
        (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS session_count
      FROM users u
      WHERE ? = '' OR u.username LIKE ? OR u.email LIKE ?
      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?
    `).all(search, like, like, safeSize, (safePage - 1) * safeSize);
    return { total, page: safePage, pageSize: safeSize, users: rows };
  }

  function setCredits(userId, credits) {
    const value = Math.max(0, Number(credits) || 0);
    db.prepare('UPDATE users SET credits = ? WHERE id = ?').run(value, userId);
    return { ok: true, credits: value };
  }

  function setBan(userId, banned) {
    db.prepare('UPDATE users SET banned = ? WHERE id = ?').run(banned ? 1 : 0, userId);
    return { ok: true, banned: Boolean(banned) };
  }

  function listRooms() {
    return db.prepare(`
      SELECT r.id, r.status, r.created_at, u.username AS owner_name,
        (SELECT COUNT(*) FROM room_players rp WHERE rp.room_id = r.id) AS player_count,
        (SELECT COUNT(*) FROM battles b WHERE b.room_id = r.id) AS battle_count
      FROM rooms r
      LEFT JOIN users u ON u.id = r.owner_id
      ORDER BY r.created_at DESC
      LIMIT 200
    `).all();
  }

  function closeRoom(roomId) {
    db.transaction(() => {
      db.prepare('DELETE FROM battles WHERE room_id = ?').run(roomId);
      db.prepare('DELETE FROM room_players WHERE room_id = ?').run(roomId);
      db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
    })();
    return { ok: true };
  }

  function listBattles() {
    return db.prepare(`
      SELECT b.id, b.room_id, b.status, b.turn, b.phase, b.started_at,
        (SELECT COUNT(*) FROM rooms r WHERE r.id = b.room_id) AS room_exists
      FROM battles b
      ORDER BY b.started_at DESC
      LIMIT 200
    `).all();
  }

  function finishBattle(battleId) {
    db.prepare("UPDATE battles SET status = 'finished' WHERE id = ?").run(battleId);
    return { ok: true };
  }

  function listSessions() {
    return db.prepare(`
      SELECT s.token, s.user_id, u.username, u.email, s.created_at, s.last_seen_at
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      ORDER BY COALESCE(s.last_seen_at, s.created_at) DESC
      LIMIT 200
    `).all();
  }

  function revokeSession(token) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return { ok: true };
  }

  function listRolls() {
    return db.prepare(`
      SELECT r.id, r.user_id, u.username, r.count, r.sides, r.values_json, r.reason, r.at
      FROM rolls r
      JOIN users u ON u.id = r.user_id
      ORDER BY r.id DESC
      LIMIT 200
    `).all();
  }

  function listGachaPulls() {
    return db.prepare(`
      SELECT p.id, p.user_id, u.username, p.pool, p.count, p.cost, p.result_json, p.created_at
      FROM gacha_pulls p
      JOIN users u ON u.id = p.user_id
      ORDER BY p.created_at DESC
      LIMIT 200
    `).all();
  }

  function overview() {
    return {
      stats: stats(),
      daily: dailyCounts(),
      rooms: listRooms().slice(0, 8),
      battles: listBattles().slice(0, 8),
      users: listUsers({ pageSize: 8 }).users,
    };
  }

  return {
    requireAdmin,
    overview,
    stats,
    dailyCounts,
    listUsers,
    setCredits,
    setBan,
    listRooms,
    closeRoom,
    listBattles,
    finishBattle,
    listSessions,
    revokeSession,
    listRolls,
    listGachaPulls,
  };
}
