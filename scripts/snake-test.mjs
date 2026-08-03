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
  body: { username: `snake_a_${suffix}`, password: 'secret1' },
});
const b = await request('/api/auth/register', {
  method: 'POST',
  body: { username: `snake_b_${suffix}`, password: 'secret2' },
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
  Name: 'snake_map',
  Version: 3,
  Orientation: 'ew',
  Terrain: { '0,0': 2, '0,1': 2, '-1,0': 2, '-2,0': 2 },
  Generation: {
    '0,0': { SourceId: 2, Side: 0 },
    '0,1': { SourceId: 2, Side: 0 },
    '-4,0': { SourceId: 2, Side: 1 },
    '-4,1': { SourceId: 2, Side: 1 },
  },
  Ships: {
    '0,0': [{ ShipId: 'dreadnought', Direction: 'N', Speed: 2 }],
    '0,1': [{ ShipId: 'destroyer', Direction: 'N', Speed: 2 }],
    '-4,0': [{ ShipId: 'frigate', Direction: 'N', Speed: 2 }],
    '-4,1': [{ ShipId: 'frigate', Direction: 'N', Speed: 2 }],
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
      { shipId: 'dreadnought', pv: 42, maxHp: 42, shipClass: 'BB', hull: [11, 21, 32, 42], speeds: [5, 5, 3, 2] },
      { shipId: 'destroyer', pv: 6, maxHp: 6, shipClass: 'DD', hull: [2, 3, 5, 6], speeds: [6, 6, 4, 2] },
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
const initial = await clientA.waitForMessage(
  (m) => m.type === 'battle.state' && m.state.phase === 'speed',
);

const clients = { [a.user.id]: clientA, [b.user.id]: clientB };
const submit = (playerId, ships) => clients[playerId].send({
  type: 'battle.command',
  battleId: battle.id,
  ships,
});
const waitAll = (state, side) => state.ships
  .filter((ship) => ship.side === side)
  .map((ship) => ({ id: ship.id, action: 'wait' }));

let firstId = initial.state.activePlayer;
let secondId = firstId === a.user.id ? b.user.id : a.user.id;
submit(firstId, waitAll(initial.state, initial.state.players.indexOf(firstId)));
await clientA.waitForMessage((m) => m.type === 'battle.state' && m.state.activePlayer === secondId);
submit(secondId, waitAll(initial.state, initial.state.players.indexOf(secondId)));
const afterSpeed = await clientA.waitForMessage(
  (m) => m.type === 'battle.state' && m.state.phase === 'move1',
);

const leaderId = afterSpeed.state.ships.find((s) => s.shipId === 'dreadnought').id;
const followerId = afterSpeed.state.ships.find((s) => s.shipId === 'destroyer').id;
const commandFor = (state, playerId) => {
  if (playerId === a.user.id) {
    return state.ships
      .filter((ship) => ship.side === 0)
      .map((ship) => ({
        id: ship.id,
        action: ship.id === leaderId ? 'turn_left' : 'wait',
      }));
  }
  return waitAll(state, 1);
};
submit(firstId, commandFor(afterSpeed.state, firstId));
await clientA.waitForMessage((m) => m.type === 'battle.state' && m.state.activePlayer === secondId);
submit(secondId, commandFor(afterSpeed.state, secondId));
const afterMove1 = await clientA.waitForMessage(
  (m) => m.type === 'battle.state' && m.state.phase === 'move2',
);

const leader1 = afterMove1.state.ships.find((s) => s.id === leaderId);
const follower1 = afterMove1.state.ships.find((s) => s.id === followerId);
if (leader1.hex.join(',') !== '-1,0' || leader1.facing !== 5) {
  throw new Error(`leader turn failed: ${leader1.hex} ${leader1.facing}`);
}
if (follower1.hex.join(',') !== '0,0' || follower1.facing !== 5) {
  throw new Error(`follower first follow failed: ${follower1.hex} ${follower1.facing}`);
}

submit(firstId, waitAll(afterMove1.state, afterMove1.state.players.indexOf(firstId)));
await clientA.waitForMessage((m) => m.type === 'battle.state' && m.state.activePlayer === secondId);
submit(secondId, waitAll(afterMove1.state, afterMove1.state.players.indexOf(secondId)));
const afterMove2 = await clientA.waitForMessage(
  (m) => m.type === 'battle.state' && m.state.phase === 'move3',
);

const leader2 = afterMove2.state.ships.find((s) => s.id === leaderId);
const follower2 = afterMove2.state.ships.find((s) => s.id === followerId);
if (leader2.hex.join(',') !== '-1,0' || follower2.hex.join(',') !== '0,0' || follower2.facing !== 5) {
  throw new Error(`second phase follow failed: ${leader2.hex} ${follower2.hex} ${follower2.facing}`);
}

clientA.close();
clientB.close();
console.log(JSON.stringify({
  battle: battle.id,
  leader: { hex: leader2.hex, facing: leader2.facing },
  follower: { hex: follower2.hex, facing: follower2.facing },
  snakeTurn: 'ok',
}, null, 2));
