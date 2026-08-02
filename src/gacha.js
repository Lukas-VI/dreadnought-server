import { randomBytes, randomInt } from 'node:crypto';

import { httpError } from './httpError.js';

const pools = {
  naval: {
    id: 'naval',
    name: 'Naval Shipyard',
    costPerPull: 100,
    items: [
      { id: 'south_dakota', name: 'South Dakota', rarity: 'SSR', weight: 5 },
      { id: 'honolulu', name: 'Honolulu', rarity: 'SR', weight: 20 },
      { id: 'shiratsuyu', name: 'Shiratsuyu', rarity: 'SR', weight: 25 },
      { id: 'nicholas', name: 'Nicholas', rarity: 'R', weight: 50 },
    ],
  },
};

function drawItem(pool) {
  const totalWeight = pool.items.reduce((sum, item) => sum + item.weight, 0);
  let cursor = randomInt(1, totalWeight + 1);
  for (const item of pool.items) {
    cursor -= item.weight;
    if (cursor <= 0) {
      return item;
    }
  }
  return pool.items[pool.items.length - 1];
}

export function createGachaService({ db, accountService }) {
  const rateLimitMs = Number(process.env.GACHA_RATE_LIMIT_MS || 300);
  const lastPullAt = new Map();
  const selectCredits = db.prepare('SELECT credits FROM users WHERE id = ?');
  const updateCredits = db.prepare('UPDATE users SET credits = ? WHERE id = ?');
  const selectByIdempotency = db.prepare('SELECT * FROM gacha_pulls WHERE idempotency_key = ?');
  const insertPull = db.prepare(
    'INSERT INTO gacha_pulls (id, user_id, pool, count, cost, result_json, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const selectPulls = db.prepare('SELECT * FROM gacha_pulls WHERE user_id = ? ORDER BY created_at DESC LIMIT 100');

  function decodePull(row) {
    return {
      id: row.id,
      pool: row.pool,
      count: row.count,
      cost: row.cost,
      items: JSON.parse(row.result_json),
      idempotencyKey: row.idempotency_key,
      createdAt: row.created_at,
    };
  }

  return {
    pools() {
      return Object.values(pools).map((pool) => ({
        id: pool.id,
        name: pool.name,
        costPerPull: pool.costPerPull,
        items: pool.items.map((item) => ({
          id: item.id,
          name: item.name,
          rarity: item.rarity,
          weight: item.weight,
          rate: item.weight / pool.items.reduce((sum, entry) => sum + entry.weight, 0),
        })),
      }));
    },

    pull(token, { pool: poolId, count, idempotencyKey }) {
      const pool = pools[poolId];
      if (!pool) {
        throw httpError(404, 'pool_not_found');
      }
      const safeCount = Math.max(1, Math.min(10, Number(count) || 1));
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
        throw httpError(400, 'idempotency_key_required');
      }

      const existing = selectByIdempotency.get(idempotencyKey);
      if (existing) {
        return { ...decodePull(existing), replay: true };
      }

      const user = accountService.resolveToken(token);
      const cost = safeCount * pool.costPerPull;
      const pullId = `gacha_${randomBytes(8).toString('hex')}`;
      const items = Array.from({ length: safeCount }, () => drawItem(pool));
      const createdAt = new Date().toISOString();
      const now = Date.now();
      const last = lastPullAt.get(user.id) || 0;
      if (now - last < rateLimitMs) {
        throw httpError(429, 'rate_limited');
      }
      lastPullAt.set(user.id, now);

      db.transaction(() => {
        const row = selectCredits.get(user.id);
        const credits = row ? row.credits : 0;
        if (credits < cost) {
          throw httpError(402, 'insufficient_credits');
        }
        updateCredits.run(credits - cost, user.id);
        insertPull.run(
          pullId,
          user.id,
          pool.id,
          safeCount,
          cost,
          JSON.stringify(items),
          idempotencyKey,
          createdAt,
        );
      })();

      const creditsLeft = selectCredits.get(user.id).credits;
      return {
        id: pullId,
        pool: pool.id,
        count: safeCount,
        cost,
        items,
        creditsLeft,
        replay: false,
        createdAt,
      };
    },

    history(token) {
      const user = accountService.resolveToken(token);
      return selectPulls.all(user.id).map(decodePull);
    },
  };
}
