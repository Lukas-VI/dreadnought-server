import http from 'node:http';

import { createAccountService } from './account.js';
import { createBattleService } from './battle.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db.js';
import { createGachaService } from './gacha.js';
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
const lobbyService = createLobbyService({ db, accountService });
const battleService = createBattleService({ db, accountService, lobbyService });
const gachaService = createGachaService({ db, accountService });

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

    if (req.method === 'POST' && path === '/api/auth/register') {
      const body = await readJson(req);
      sendJson(res, 201, accountService.register(body));
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

    if (req.method === 'GET' && path.startsWith('/api/lobby/rooms/')) {
      const roomId = decodeURIComponent(path.slice('/api/lobby/rooms/'.length));
      sendJson(res, 200, lobbyService.get(bearerToken(req), roomId));
      return;
    }

    if (req.method === 'POST' && path === '/api/battle/start') {
      const body = await readJson(req);
      const battle = battleService.start(bearerToken(req), body.roomId);
      const room = lobbyService.get(bearerToken(req), body.roomId);
      hub.broadcast(room.id, { type: 'room.updated', room });
      hub.broadcast(room.id, { type: 'battle.started', battle });
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
const hub = createRealtimeHub({ server, accountService, lobbyService, battleService });

server.listen(port, '0.0.0.0', () => {
  console.log(`dreadnought-server listening on ${port}`);
});
