import { randomBytes } from 'node:crypto';

export function createInventoryService({ db }) {
  const insertItem = db.prepare(`
    INSERT INTO items (id, user_id, item_type, item_id, quantity, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, item_type, item_id)
    DO UPDATE SET quantity = quantity + excluded.quantity
  `);
  const selectItems = db.prepare(`
    SELECT item_type, item_id, quantity, created_at
    FROM items
    WHERE user_id = ?
    ORDER BY item_type, item_id
  `);

  function grantItem(userId, itemType, itemId, quantity = 1) {
    const safeQuantity = Math.max(1, Number(quantity) || 1);
    const id = `item_${randomBytes(8).toString('hex')}`;
    insertItem.run(
      id,
      userId,
      String(itemType),
      String(itemId),
      safeQuantity,
      new Date().toISOString(),
    );
    return {
      itemType: String(itemType),
      itemId: String(itemId),
      quantity: safeQuantity,
    };
  }

  function list(userId) {
    return selectItems.all(userId);
  }

  return { grantItem, list };
}
