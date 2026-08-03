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
  body: { username: `rules_a_${suffix}`, password: 'secret1' },
});
const b = await request('/api/auth/register', {
  method: 'POST',
  body: { username: `rules_b_${suffix}`, password: 'secret2' },
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
  Name: 'rules_island',
  Version: 3,
  Orientation: 'ew',
  MapType: 'night',
  TorpedoPhaseEnabled: true,
  InitiativeOwner: 'enemy',
  Terrain: { '0,0': 2, '0,-1': 1, '2,0': 2, '-4,0': 2 },
  Generation: {
    '0,0': { SourceId: 2, Side: 0 },
    '2,0': { SourceId: 2, Side: 0 },
    '-4,0': { SourceId: 2, Side: 1 },
  },
  Ships: {
    '0,0': [{ ShipId: 'frigate', Direction: 'N', Speed: 1 }],
    '2,0': [{ ShipId: 'frigate', Direction: 'N', Speed: 1 }],
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
const initial = await clientA.waitForMessage(
  (m) => m.type === 'battle.state' && m.state.phase === 'speed',
);

if (initial.state.activePlayer !== b.user.id) {
  throw new Error('map InitiativeOwner enemy not applied');
}

const clients = { [a.user.id]: clientA, [b.user.id]: clientB };
const waitAll = (state, side) => state.ships
  .filter((ship) => ship.side === side && ship.hp > 0)
  .map((ship) => ({ id: ship.id, action: 'wait' }));
const submit = (playerId, ships) => clients[playerId].send({
  type: 'battle.command',
  battleId: battle.id,
  ships,
});
const firstId = initial.state.activePlayer;
const secondId = firstId === a.user.id ? b.user.id : a.user.id;
submit(firstId, waitAll(initial.state, initial.state.players.indexOf(firstId)));
await clientA.waitForMessage((m) => m.type === 'battle.state' && m.state.activePlayer === secondId);
submit(secondId, waitAll(initial.state, initial.state.players.indexOf(secondId)));
const afterSpeed = await clientA.waitForMessage(
  (m) => m.type === 'battle.state' && m.state.phase === 'move1',
);

submit(firstId, waitAll(afterSpeed.state, afterSpeed.state.players.indexOf(firstId)));
await clientA.waitForMessage((m) => m.type === 'battle.state' && m.state.activePlayer === secondId);
submit(secondId, waitAll(afterSpeed.state, afterSpeed.state.players.indexOf(secondId)));
const afterMove1 = await clientA.waitForMessage(
  (m) => m.type === 'battle.state' && m.state.phase === 'move2',
);

const playerShip = afterMove1.state.ships.find((ship) => ship.side === 0 && ship.hex.join(',') === '0,0');
if (playerShip.hp !== 0 || playerShip.hex.join(',') !== '0,0' || playerShip.status !== 'sunk') {
  throw new Error(`island sink failed: ${JSON.stringify(playerShip)}`);
}

const advanceBoth = async (fromState, nextPhase, turn) => {
  const state = fromState.state || fromState;
  submit(firstId, waitAll(state, state.players.indexOf(firstId)));
  const firstResult = await clients[firstId].waitForMessage(
    (m) => m.type === 'error'
      || (m.type === 'battle.state' && m.state.phase === state.phase && m.state.activePlayer === secondId),
  );
  if (firstResult.type === 'error') {
    throw new Error(`first submit failed: ${firstResult.code}`);
  }
  submit(secondId, waitAll(state, state.players.indexOf(secondId)));
  const secondResult = await clients[secondId].waitForMessage(
    (m) => m.type === 'error'
      || (m.type === 'battle.state'
        && m.state.phase === nextPhase
        && (turn == null || m.state.turn === turn)),
  );
  if (secondResult.type === 'error') {
    throw new Error(`second submit failed: ${secondResult.code}`);
  }
  return secondResult;
};

const afterMove2 = await advanceBoth(afterMove1, 'move3');
const afterMove3 = await advanceBoth(afterMove2, 'recon');
const afterRecon = await advanceBoth(afterMove3, 'gunnery');
if (!afterRecon.state.eventLog.some((entry) => entry.message.includes('视野阶段完成'))) {
  throw new Error('night recon phase not entered');
}
const afterGunnery = await advanceBoth(afterRecon, 'torpedo');
const afterTorpedo = await advanceBoth(afterGunnery, 'speed', 2);
if (!afterTorpedo.state.eventLog.some((entry) => entry.message.includes('鱼雷阶段完成'))) {
  throw new Error('torpedo phase not entered');
}
if (afterTorpedo.state.turnOrder[0] === firstId) {
  throw new Error('turn order did not swap after torpedo phase');
}

clientA.close();
clientB.close();
console.log(JSON.stringify({
  initiative: 'map-owner',
  island: 'sunk-in-place',
  recon: 'entered',
  torpedo: 'entered',
  battle: battle.id,
}, null, 2));
