import http from 'node:http';

import { createAccountService } from './account.js';
import { createBattleService } from './battle.js';
import { createLobbyService } from './lobby.js';

const port = Number(process.env.PORT || 3000);
const accountService = createAccountService();
const lobbyService = createLobbyService({ accountService });
const battleService = createBattleService({ accountService, lobbyService });

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
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function bearerToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
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

    if (req.method === 'GET' && path === '/api/lobby/rooms') {
      sendJson(res, 200, { rooms: lobbyService.list(bearerToken(req)) });
      return;
    }

    if (req.method === 'POST' && path === '/api/lobby/create') {
      sendJson(res, 201, lobbyService.create(bearerToken(req)));
      return;
    }

    if (req.method === 'POST' && path === '/api/lobby/join') {
      const body = await readJson(req);
      sendJson(res, 200, lobbyService.join(bearerToken(req), body.roomId));
      return;
    }

    if (req.method === 'GET' && path.startsWith('/api/lobby/rooms/')) {
      const roomId = decodeURIComponent(path.slice('/api/lobby/rooms/'.length));
      sendJson(res, 200, lobbyService.get(bearerToken(req), roomId));
      return;
    }

    if (req.method === 'POST' && path === '/api/battle/start') {
      const body = await readJson(req);
      sendJson(res, 201, battleService.start(bearerToken(req), body.roomId));
      return;
    }

    if (req.method === 'POST' && path === '/api/battle/roll') {
      const body = await readJson(req);
      sendJson(res, 200, battleService.roll(bearerToken(req), body));
      return;
    }

    if (req.method === 'GET' && path === '/api/battle/rolls') {
      sendJson(res, 200, { rolls: battleService.rollLog(bearerToken(req)) });
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  } catch (err) {
    const status = err.status || 500;
    const code = err.code || 'internal_error';
    if (status === 500) {
      console.error(err);
    }
    sendJson(res, status, { error: code });
  }
}

const server = http.createServer(handleRequest);

server.listen(port, '0.0.0.0', () => {
  console.log(`dreadnought-server listening on ${port}`);
});
