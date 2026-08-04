import http from 'node:http';
import { readFileSync } from 'node:fs';

import { createAccountService } from './account.js';
import { createAdminService } from './admin.js';
import { createBattleService } from './battle.js';
import { createBattleStateService } from './battleState.js';
import { createContentService } from './content.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db.js';
import { createGachaService } from './gacha.js';
import { createInventoryService } from './inventory.js';
import { createLobbyService } from './lobby.js';
import { createRealtimeHub } from './realtime.js';

const port = Number(process.env.PORT || 3000);
const db = createDatabase();
const config = loadConfig();
const accountService = createAccountService({
  db,
  passwordlessLogin:
    (config.DEV_PASSWORDLESS_LOGIN ?? process.env.DEV_PASSWORDLESS_LOGIN) === 'true',
});
const adminService = createAdminService({ db, accountService });
const inventoryService = createInventoryService({ db });
const contentService = createContentService({ db, accountService, inventoryService });
const lobbyService = createLobbyService({ db, accountService });
const battleService = createBattleService({ db, accountService, lobbyService });
const battleStateService = createBattleStateService({ db, accountService, battleService });
const gachaService = createGachaService({ db, accountService, inventoryService });
accountService.ensureAdmin(
  config.ADMIN_EMAIL ?? process.env.ADMIN_EMAIL,
  config.ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD,
);

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const err = new Error('bad_json');
    err.status = 400;
    err.code = 'bad_json';
    throw err;
  }
}

function bearerToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function handleError(res, err) {
  const status = err.status || 500;
  const code = err.code || 'internal_error';
  if (status === 500) {
    console.error(err);
  }
  sendJson(res, status, { error: code });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  try {
    if (req.method === 'GET' && path === '/health') {
      sendJson(res, 200, {
        ok: true,
        service: 'dreadnought-server',
        time: new Date().toISOString(),
      });
      return;
    }

    if (req.method === 'GET' && path === '/api/time') {
      sendJson(res, 200, { serverTime: Date.now() });
      return;
    }

    if (req.method === 'POST' && path === '/api/auth/register') {
      const body = await readJson(req);
      const auth = accountService.register(body);
      contentService.welcomeMail(auth.user.id);
      sendJson(res, 201, auth);
      return;
    }

    if (req.method === 'POST' && path === '/api/auth/login') {
      const body = await readJson(req);
      sendJson(res, 200, accountService.login(body));
      return;
    }

    if (req.method === 'POST' && path === '/api/auth/logout') {
      sendJson(res, 200, accountService.logout(bearerToken(req)));
      return;
    }

    if (req.method === 'GET' && path === '/api/me') {
      sendJson(res, 200, accountService.getUser(bearerToken(req)));
      return;
    }

    if (req.method === 'PATCH' && path === '/api/me/profile') {
      const body = await readJson(req);
      sendJson(res, 200, accountService.updateProfile(bearerToken(req), body));
      return;
    }

    if (req.method === 'GET' && path === '/api/backpack') {
      sendJson(res, 200, { items: contentService.backpack(bearerToken(req)) });
      return;
    }

    if (req.method === 'GET' && path === '/api/shop') {
      sendJson(res, 200, { items: contentService.shopCatalog() });
      return;
    }

    if (req.method === 'POST' && path === '/api/shop/buy') {
      const body = await readJson(req);
      sendJson(res, 200, contentService.shopBuy(bearerToken(req), body.itemId));
      return;
    }

    if (req.method === 'GET' && path === '/api/mail') {
      sendJson(res, 200, { mails: contentService.mailList(bearerToken(req)) });
      return;
    }

    const mailMatch = path.match(/^\/api\/mail\/([^/]+)\/(read|claim)$/);
    if (req.method === 'POST' && mailMatch) {
      const mailId = decodeURIComponent(mailMatch[1]);
      const action = mailMatch[2];
      const result = action === 'read'
        ? contentService.mailRead(bearerToken(req), mailId)
        : contentService.mailClaim(bearerToken(req), mailId);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'GET' && (path === '/admin' || path === '/admin/')) {
      const html = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (path.startsWith('/api/admin/')) {
      adminService.requireAdmin(bearerToken(req));

      if (req.method === 'GET' && path === '/api/admin/overview') {
        sendJson(res, 200, adminService.overview());
        return;
      }
      if (req.method === 'GET' && path === '/api/admin/stats') {
        sendJson(res, 200, adminService.stats());
        return;
      }
      if (req.method === 'GET' && path === '/api/admin/daily') {
        sendJson(res, 200, adminService.dailyCounts());
        return;
      }
      if (req.method === 'GET' && path === '/api/admin/users') {
        sendJson(res, 200, adminService.listUsers({
          search: url.searchParams.get('search') || '',
          page: url.searchParams.get('page') || 1,
          pageSize: url.searchParams.get('pageSize') || 20,
        }));
        return;
      }
      if (req.method === 'GET' && path === '/api/admin/rooms') {
        sendJson(res, 200, { rooms: adminService.listRooms() });
        return;
      }
      if (req.method === 'GET' && path === '/api/admin/battles') {
        sendJson(res, 200, { battles: adminService.listBattles() });
        return;
      }
      if (req.method === 'GET' && path === '/api/admin/sessions') {
        sendJson(res, 200, { sessions: adminService.listSessions() });
        return;
      }
      if (req.method === 'GET' && path === '/api/admin/rolls') {
        sendJson(res, 200, { rolls: adminService.listRolls() });
        return;
      }
      if (req.method === 'GET' && path === '/api/admin/gacha') {
        sendJson(res, 200, { pulls: adminService.listGachaPulls() });
        return;
      }

      const userMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/(credits|ban|unban|password|role)$/);
      if (req.method === 'POST' && userMatch) {
        const userId = decodeURIComponent(userMatch[1]);
        const action = userMatch[2];
        const body = await readJson(req);
        if (action === 'credits') {
          sendJson(res, 200, adminService.setCredits(userId, body.credits));
        } else if (action === 'ban') {
          sendJson(res, 200, adminService.setBan(userId, true));
        } else if (action === 'unban') {
          sendJson(res, 200, adminService.setBan(userId, false));
        } else if (action === 'password') {
          sendJson(res, 200, accountService.adminSetPassword(userId, body.password));
        } else {
          sendJson(res, 200, accountService.adminSetRole(userId, body.role));
        }
        return;
      }

      const roomMatch = path.match(/^\/api\/admin\/rooms\/([^/]+)\/close$/);
      if (req.method === 'POST' && roomMatch) {
        sendJson(res, 200, adminService.closeRoom(decodeURIComponent(roomMatch[1])));
        return;
      }

      const battleMatch = path.match(/^\/api\/admin\/battles\/([^/]+)\/finish$/);
      if (req.method === 'POST' && battleMatch) {
        const battleId = decodeURIComponent(battleMatch[1]);
        adminService.finishBattle(battleId);
        sendJson(res, 200, battleStateService.adminFinish(battleId));
        return;
      }

      if (req.method === 'POST' && path === '/api/admin/sessions/revoke') {
        const body = await readJson(req);
        sendJson(res, 200, adminService.revokeSession(body.token));
        return;
      }

      sendJson(res, 404, { error: 'not_found' });
      return;
    }

    if (req.method === 'GET' && path === '/api/lobby/rooms') {
      sendJson(res, 200, { rooms: lobbyService.list(bearerToken(req)) });
      return;
    }

    if (req.method === 'POST' && path === '/api/lobby/create') {
      const room = lobbyService.create(bearerToken(req));
      hub.broadcast(room.id, { type: 'room.updated', room });
      sendJson(res, 201, room);
      return;
    }

    if (req.method === 'POST' && path === '/api/lobby/join') {
      const body = await readJson(req);
      const room = lobbyService.join(bearerToken(req), body.roomId);
      hub.broadcast(room.id, { type: 'room.updated', room });
      sendJson(res, 200, room);
      return;
    }

    if (req.method === 'POST' && path === '/api/lobby/leave') {
      const body = await readJson(req);
      const room = lobbyService.leave(bearerToken(req), body.roomId);
      if (room) {
        hub.broadcast(room.id, { type: 'room.updated', room });
      } else {
        hub.broadcast(body.roomId, { type: 'room.removed', roomId: body.roomId });
      }
      sendJson(res, 200, { ok: true, room });
      return;
    }

    if (req.method === 'GET' && path.startsWith('/api/lobby/rooms/') && !path.endsWith('/map')) {
      const roomId = decodeURIComponent(path.slice('/api/lobby/rooms/'.length));
      sendJson(res, 200, lobbyService.get(bearerToken(req), roomId));
      return;
    }

    if (req.method === 'PUT' && path.startsWith('/api/lobby/rooms/') && path.endsWith('/map')) {
      const roomId = decodeURIComponent(
        path.slice('/api/lobby/rooms/'.length, path.length - '/map'.length),
      );
      const map = await readJson(req);
      const room = lobbyService.setMap(bearerToken(req), roomId, JSON.stringify(map));
      hub.broadcast(room.id, { type: 'room.updated', room });
      sendJson(res, 200, room);
      return;
    }

    if (req.method === 'GET' && path.startsWith('/api/lobby/rooms/') && path.endsWith('/map')) {
      const roomId = decodeURIComponent(
        path.slice('/api/lobby/rooms/'.length, path.length - '/map'.length),
      );
      const map = lobbyService.getMap(bearerToken(req), roomId);
      sendJson(res, 200, { map });
      return;
    }

    if (req.method === 'PUT' && path.startsWith('/api/lobby/rooms/') && path.endsWith('/shipdata')) {
      const roomId = decodeURIComponent(
        path.slice('/api/lobby/rooms/'.length, path.length - '/shipdata'.length),
      );
      const body = await readJson(req);
      const room = lobbyService.setShipData(
        bearerToken(req),
        roomId,
        JSON.stringify(body.ships || []),
      );
      hub.broadcast(room.id, { type: 'room.updated', room });
      sendJson(res, 200, room);
      return;
    }

    if (req.method === 'POST' && path === '/api/battle/start') {
      const body = await readJson(req);
      const battle = battleService.start(bearerToken(req), body.roomId);
      const room = lobbyService.get(bearerToken(req), body.roomId);
      hub.broadcast(room.id, { type: 'room.updated', room });
      hub.broadcast(room.id, { type: 'battle.started', battle });
      hub.broadcast(room.id, {
        type: 'battle.state',
        state: battleStateService.getState(bearerToken(req), battle.id),
      });
      sendJson(res, 201, battle);
      return;
    }

    if (req.method === 'POST' && path === '/api/battle/roll') {
      const body = await readJson(req);
      const roll = battleService.roll(bearerToken(req), body);
      hub.broadcast(roll.roomId, { type: 'battle.rolled', battleId: roll.battleId, roll });
      sendJson(res, 200, roll);
      return;
    }

    if (req.method === 'GET' && path === '/api/battle/rolls') {
      sendJson(res, 200, { rolls: battleService.rollLog(bearerToken(req)) });
      return;
    }

    if (req.method === 'GET' && path === '/api/gacha/pools') {
      sendJson(res, 200, { pools: gachaService.pools() });
      return;
    }

    if (req.method === 'POST' && path === '/api/gacha/pull') {
      const body = await readJson(req);
      sendJson(res, 200, gachaService.pull(bearerToken(req), body));
      return;
    }

    if (req.method === 'GET' && path === '/api/gacha/history') {
      sendJson(res, 200, { pulls: gachaService.history(bearerToken(req)) });
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  } catch (err) {
    handleError(res, err);
  }
}

const server = http.createServer(handleRequest);
const hub = createRealtimeHub({
  server,
  accountService,
  lobbyService,
  battleService,
  battleStateService,
});

server.listen(port, '0.0.0.0', () => {
  console.log(`dreadnought-server listening on ${port}`);
});
