import WebSocket from 'ws';

const base = process.env.BASE_URL || 'http://127.0.0.1:3000';

async function request(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status} ${text}`);
  }
  return payload;
}

async function requestStatus(path, { token } = {}) {
  const response = await fetch(base + path, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }
  return { ok: response.ok, status: response.status, payload };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect(token) {
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
  const events = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    events.push(message);
    const index = waiters.findIndex(
      (waiter) => waiter.predicate ? waiter.predicate(message) : waiter.type === message.type,
    );
    if (index !== -1) {
      const [waiter] = waiters.splice(index, 1);
      waiter.resolve(message);
    }
  });
  await new Promise((resolve, reject) => {
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token }));
      resolve();
    });
    ws.once('error', reject);
  });
  return {
    ws,
    send(message) {
      ws.send(JSON.stringify(message));
    },
    waitForMessage(predicate, timeoutMs = 6000) {
      const existing = events.find(predicate);
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        waiters.push({
          predicate,
          resolve: (message) => {
            clearTimeout(timer);
            resolve(message);
          },
        });
      });
    },
    close() {
      ws.close();
    },
  };
}

const suffix = Date.now().toString(36);
const a = await request('/api/auth/register', {
  method: 'POST',
  body: { username: `reconnect_a_${suffix}`, password: 'secret1' },
});
const b = await request('/api/auth/register', {
  method: 'POST',
  body: { username: `reconnect_b_${suffix}`, password: 'secret2' },
});
const room = await request('/api/lobby/create', {
  method: 'POST',
  token: a.token,
});
await request('/api/lobby/join', {
  method: 'POST',
  token: b.token,
  body: { roomId: room.id },
});

const map = {
  Name: 'reconnect_map',
  Version: 3,
  Orientation: 'ew',
  Terrain: { '0,0': 2, '-4,0': 2 },
  Generation: {
    '0,0': { SourceId: 2, Side: 0 },
    '-4,0': { SourceId: 2, Side: 1 },
  },
  Ships: {
    '0,0': [{ ShipId: 'frigate', Direction: 'N', Speed: 1 }],
    '-4,0': [{ ShipId: 'frigate', Direction: 'S', Speed: 1 }],
  },
};
await request(`/api/lobby/rooms/${room.id}/map`, {
  method: 'PUT',
  token: a.token,
  body: map,
});
await request(`/api/lobby/rooms/${room.id}/shipdata`, {
  method: 'PUT',
  token: a.token,
  body: {
    ships: [
      { shipId: 'frigate', pv: 5, maxHp: 4, shipClass: 'DD', hull: [1, 2, 3, 4], speeds: [6, 5, 4, 2] },
    ],
  },
});
const battle = await request('/api/battle/start', {
  method: 'POST',
  token: a.token,
  body: { roomId: room.id },
});

const clientA = await connect(a.token);
const clientB = await connect(b.token);
clientA.send({ type: 'lobby.join', roomId: room.id });
await clientA.waitForMessage((m) => m.type === 'room.state');
clientB.send({ type: 'lobby.join', roomId: room.id });
await clientB.waitForMessage((m) => m.type === 'room.state');
clientA.send({ type: 'battle.state.get', battleId: battle.id });
await clientA.waitForMessage((m) => m.type === 'battle.state' && m.state.phase === 'speed');

clientB.close();
const paused = await clientA.waitForMessage(
  (m) => m.type === 'battle.state' && m.state.paused === true,
  6000,
);
if (paused.state.pausedReason !== 'opponent_disconnected') {
  throw new Error(`wrong pause reason: ${paused.state.pausedReason}`);
}
const roomAfterDisconnect = await request(`/api/lobby/rooms/${room.id}`, {
  token: a.token,
});
if (roomAfterDisconnect.id !== room.id) {
  throw new Error('room deleted after single disconnect');
}

clientA.send({ type: 'battle.command', battleId: battle.id, ships: [] });
const pausedError = await clientA.waitForMessage((m) => m.type === 'error', 4000);
if (pausedError.code !== 'battle_paused') {
  throw new Error(`expected battle_paused, got ${pausedError.code}`);
}

const clientB2 = await connect(b.token);
clientB2.send({ type: 'lobby.join', roomId: room.id });
await clientB2.waitForMessage((m) => m.type === 'room.state');
const resumed = await clientA.waitForMessage(
  (m) => m.type === 'battle.state' && m.state.paused === false,
  6000,
);
if (resumed.state.pausedReason !== '') {
  throw new Error(`resume reason not cleared: ${resumed.state.pausedReason}`);
}

clientA.close();
clientB2.close();
await sleep(Number(process.env.ABANDON_ROOM_MS || 500) + 800);
const abandoned = await requestStatus(`/api/lobby/rooms/${room.id}`, {
  token: a.token,
});
if (abandoned.status !== 404) {
  throw new Error(`abandoned room not deleted: ${abandoned.status}`);
}

console.log(JSON.stringify({
  pauseOnDisconnect: 'ok',
  reconnectResumes: 'ok',
  abandonAfterBothLeave: 'ok',
  battle: battle.id,
}, null, 2));
