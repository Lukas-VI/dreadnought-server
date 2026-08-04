import { randomBytes } from 'node:crypto';

import { httpError } from './httpError.js';

const shopCatalog = [
  { id: 'ship_south_dakota', name: '南达科他', itemType: 'ship', itemId: 'south_dakota', quantity: 1, cost: 2000, rarity: 'SSR', description: '大型战列舰蓝图' },
  { id: 'ship_honolulu', name: '火奴鲁鲁', itemType: 'ship', itemId: 'honolulu', quantity: 1, cost: 800, rarity: 'SR', description: '轻巡洋舰蓝图' },
  { id: 'ship_shiratsuyu', name: '白露(b)', itemType: 'ship', itemId: 'shiratsuyu', quantity: 1, cost: 500, rarity: 'SR', description: '驱逐舰蓝图' },
  { id: 'ship_nicholas', name: '尼古拉斯', itemType: 'ship', itemId: 'nicholas', quantity: 1, cost: 300, rarity: 'R', description: '驱逐舰蓝图' },
  { id: 'fuel_pack', name: '燃油补给包', itemType: 'consumable', itemId: 'fuel_pack', quantity: 5, cost: 100, rarity: 'N', description: '战斗补给用消耗品' },
  { id: 'radar_parts', name: '雷达零件', itemType: 'consumable', itemId: 'radar_parts', quantity: 3, cost: 150, rarity: 'N', description: '雷达强化材料' },
];

export function createContentService({ db, accountService, inventoryService }) {
  const selectCredits = db.prepare('SELECT credits FROM users WHERE id = ?');
  const updateCredits = db.prepare('UPDATE users SET credits = ? WHERE id = ?');
  const insertMail = db.prepare(`
    INSERT INTO mails (id, user_id, title, body, sender, attachments_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const selectMails = db.prepare(`
    SELECT * FROM mails WHERE user_id = ? ORDER BY created_at DESC LIMIT 200
  `);
  const selectMail = db.prepare('SELECT * FROM mails WHERE id = ? AND user_id = ?');
  const updateMailRead = db.prepare('UPDATE mails SET is_read = 1 WHERE id = ? AND user_id = ?');
  const updateMailClaimed = db.prepare('UPDATE mails SET claimed = 1, is_read = 1 WHERE id = ? AND user_id = ?');

  function decodeAttachments(row) {
    try {
      return JSON.parse(row.attachments_json || '[]');
    } catch {
      return [];
    }
  }

  function sendMail(userId, title, body, attachments = []) {
    const id = `mail_${randomBytes(8).toString('hex')}`;
    insertMail.run(
      id,
      userId,
      String(title),
      String(body),
      '系统',
      JSON.stringify(attachments),
      new Date().toISOString(),
    );
    return id;
  }

  function welcomeMail(userId) {
    sendMail(
      userId,
      '欢迎来到 Dreadnought Departure',
      '这是你的第一封系统邮件，领取附件可以获得初始驱逐舰“尼古拉斯”。',
      [{ itemType: 'ship', itemId: 'nicholas', quantity: 1 }],
    );
  }

  function requireUser(token) {
    return accountService.resolveToken(token);
  }

  return {
    profile(token) {
      return accountService.getUser(token);
    },

    backpack(token) {
      const user = requireUser(token);
      return inventoryService.list(user.id);
    },

    shopCatalog() {
      return shopCatalog.map((entry) => ({ ...entry }));
    },

    shopBuy(token, itemId) {
      const user = requireUser(token);
      const entry = shopCatalog.find((item) => item.id === itemId);
      if (!entry) {
        throw httpError(404, 'shop_item_not_found');
      }
      db.transaction(() => {
        const row = selectCredits.get(user.id);
        const credits = row ? row.credits : 0;
        if (credits < entry.cost) {
          throw httpError(402, 'insufficient_credits');
        }
        updateCredits.run(credits - entry.cost, user.id);
        inventoryService.grantItem(
          user.id,
          entry.itemType,
          entry.itemId,
          entry.quantity,
        );
      })();
      return {
        item: entry,
        credits: selectCredits.get(user.id).credits,
      };
    },

    welcomeMail,
    sendMail,

    mailList(token) {
      const user = requireUser(token);
      return selectMails.all(user.id).map((row) => ({
        id: row.id,
        title: row.title,
        body: row.body,
        sender: row.sender,
        isRead: Boolean(row.is_read),
        claimed: Boolean(row.claimed),
        attachments: decodeAttachments(row),
        createdAt: row.created_at,
      }));
    },

    mailRead(token, mailId) {
      const user = requireUser(token);
      const row = selectMail.get(mailId, user.id);
      if (!row) {
        throw httpError(404, 'mail_not_found');
      }
      updateMailRead.run(mailId, user.id);
      return { ok: true };
    },

    mailClaim(token, mailId) {
      const user = requireUser(token);
      const row = selectMail.get(mailId, user.id);
      if (!row) {
        throw httpError(404, 'mail_not_found');
      }
      if (row.claimed) {
        return { ok: true, attachments: decodeAttachments(row) };
      }
      const attachments = decodeAttachments(row);
      db.transaction(() => {
        for (const attachment of attachments) {
          inventoryService.grantItem(
            user.id,
            attachment.itemType || 'item',
            attachment.itemId,
            attachment.quantity || 1,
          );
        }
        updateMailClaimed.run(mailId, user.id);
      })();
      return { ok: true, attachments };
    },
  };
}
