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
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status} ${text}`);
  }
  return payload;
}

async function connect(token) {
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
  const events = [];
  const waiters = [];
  let resolveAuth;
  const authDone = new Promise((resolve) => {
    resolveAuth = resolve;
  });

  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    events.push(message);
    if (message.type === 'auth.ok') {
      resolveAuth();
    }
    const index = waiters.findIndex((waiter) =>
      waiter.predicate ? waiter.predicate(message) : waiter.type === message.type,
    );
    if (index !== -1) {
      const [waiter] = waiters.splice(index, 1);
      waiter.resolve(message);
    }
  });

  await new Promise((resolveOpen, rejectOpen) => {
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token }));
      resolveOpen();
    });
    ws.once('error', rejectOpen);
  });
  await authDone;

  return {
    ws,
    events,
    send(message) {
      ws.send(JSON.stringify(message));
    },
    waitFor(type, timeoutMs = 5000) {
      const existing = events.find((message) => message.type === type);
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
        waiters.push({
          type,
          resolve: (message) => {
            clearTimeout(timer);
            resolve(message);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
      });
    },
    waitForMessage(predicate, timeoutMs = 5000) {
      const existing = events.find(predicate);
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('timeout waiting for message')),
          timeoutMs,
        );
        waiters.push({
          predicate,
          resolve: (message) => {
            clearTimeout(timer);
            resolve(message);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
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
  body: { username: `smoke_a_${suffix}`, password: 'secret1' },
});
const b = await request('/api/auth/register', {
  method: 'POST',
  body: { username: `smoke_b_${suffix}`, password: 'secret2' },
});

if (process.env.TEST_PASSWORDLESS === 'true') {
  const passwordless = await request('/api/auth/login', {
    method: 'POST',
    body: { username: a.user.username, password: '' },
  });
  if (!passwordless.token) {
    throw new Error('passwordless login failed');
  }
}

const me = await request('/api/me', { token: a.token });
const room = await request('/api/lobby/create', {
  method: 'POST',
  token: a.token,
});
const joined = await request('/api/lobby/join', {
  method: 'POST',
  token: b.token,
  body: { roomId: room.id },
});
const smokeMap = {
  Name: 'smoke_map',
  Version: 3,
  Orientation: 'ew',
  InitiativeOwner: 'player',
  Terrain: { '0,0': 2, '1,0': 1 },
  Generation: {
    '0,0': { SourceId: 2, Side: 0 },
    '1,0': { SourceId: 2, Side: 0 },
    '-2,0': { SourceId: 2, Side: 1 },
    '-3,0': { SourceId: 2, Side: 1 },
  },
  Special: {},
  Ships: {
    '0,0': [{ ShipId: 'dreadnought', Direction: 0, Speed: 2 }],
    '1,0': [{ ShipId: 'cruiser', Direction: 0, Speed: 2 }],
    '-2,0': [{ ShipId: 'destroyer', Direction: 3, Speed: 2 }],
    '-3,0': [{ ShipId: 'frigate', Direction: 3, Speed: 2 }],
  },
};
const roomWithMap = await request(`/api/lobby/rooms/${room.id}/map`, {
  method: 'PUT',
  token: a.token,
  body: smokeMap,
});
const combatStats = {
  dreadnought: {
    attackRange: 10, attackPower: 40, mainAmmo: 20,
    forwardFire: 6, sideFire: 9, backwardFire: 3, gunCaliber: 40,
    secondaryForwardFire: 6, secondarySideFire: 10, secondaryBackwardFire: 6,
    secondaryGunCaliber: 12, secondaryAttackPower: 20,
    armorClose: 9, armorMedium: 13, armorFar: 11,
  },
  cruiser: {
    attackRange: 7, attackPower: 15, mainAmmo: 15,
    forwardFire: 6, sideFire: 15, backwardFire: 6, gunCaliber: 15,
    secondaryForwardFire: 0, secondarySideFire: 0, secondaryBackwardFire: 0,
    secondaryGunCaliber: 12, secondaryAttackPower: 0,
    armorClose: 3, armorMedium: 7, armorFar: 8,
  },
  destroyer: {
    attackRange: 4, attackPower: 12, mainAmmo: 12,
    forwardFire: 2, sideFire: 5, backwardFire: 2, gunCaliber: 12,
    secondaryForwardFire: 0, secondarySideFire: 0, secondaryBackwardFire: 0,
    secondaryGunCaliber: 12, secondaryAttackPower: 0,
    armorClose: 0, armorMedium: 0, armorFar: 0,
  },
  frigate: {
    attackRange: 4, attackPower: 12, mainAmmo: 12,
    forwardFire: 2, sideFire: 4, backwardFire: 2, gunCaliber: 12,
    secondaryForwardFire: 0, secondarySideFire: 0, secondaryBackwardFire: 0,
    secondaryGunCaliber: 12, secondaryAttackPower: 0,
    armorClose: 0, armorMedium: 0, armorFar: 0,
  },
};
const uploadedShipData = [
  { shipId: 'dreadnought', pv: 42, maxHp: 42, shipClass: 'BB', hull: [11, 21, 32, 42], speeds: [5, 5, 3, 2], ...combatStats.dreadnought },
  { shipId: 'cruiser', pv: 16, maxHp: 18, shipClass: 'CL', hull: [4, 9, 13, 18], speeds: [6, 5, 4, 2], ...combatStats.cruiser },
  { shipId: 'destroyer', pv: 6, maxHp: 6, shipClass: 'DD', hull: [2, 3, 5, 6], speeds: [6, 6, 4, 2], ...combatStats.destroyer },
  { shipId: 'frigate', pv: 5, maxHp: 4, shipClass: 'DD', hull: [1, 2, 3, 4], speeds: [6, 5, 4, 2], ...combatStats.frigate },
];
await request(`/api/lobby/rooms/${room.id}/shipdata`, {
  method: 'PUT',
  token: a.token,
  body: { ships: uploadedShipData },
});
if (!roomWithMap.hasMap) {
  throw new Error('map upload failed');
}
const downloadedMap = await request(`/api/lobby/rooms/${room.id}/map`, {
  token: b.token,
});
if (downloadedMap.map.Name !== 'smoke_map') {
  throw new Error('map download failed');
}
const battle = await request('/api/battle/start', {
  method: 'POST',
  token: a.token,
  body: { roomId: room.id },
});
const battleAgain = await request('/api/battle/start', {
  method: 'POST',
  token: a.token,
  body: { roomId: room.id },
});
if (battleAgain.id !== battle.id) {
  throw new Error(`battle id mismatch: ${battle.id} vs ${battleAgain.id}`);
}

const clientA = await connect(a.token);
const clientB = await connect(b.token);
clientA.send({ type: 'lobby.join', roomId: room.id });
await clientA.waitFor('room.state');
clientB.send({ type: 'lobby.join', roomId: room.id });
await clientB.waitFor('room.state');

clientA.send({ type: 'battle.state.get', battleId: battle.id });
const initial = await clientA.waitForMessage(
  (message) => message.type === 'battle.state' && message.state.phase === 'speed',
);
if (initial.state.turn !== 1) {
  throw new Error(`initial turn mismatch: ${initial.state.turn}`);
}
if (typeof initial.state.playerCP !== 'number' || typeof initial.state.enemyCP !== 'number') {
  throw new Error('battle state missing cp fields');
}
if (typeof initial.state.timerTotal !== 'number' || initial.state.timerTotal <= 0) {
  throw new Error('battle state missing authoritative timer');
}
if (typeof initial.state.timerEndAt !== 'number' || initial.state.timerEndAt <= 0 ||
  typeof initial.state.timerStartAt !== 'number' || initial.state.timerStartAt <= 0) {
  throw new Error('battle state missing timer timestamps');
}
for (const ship of initial.state.ships) {
  if (typeof ship.stackIndex !== 'number' || typeof ship.stackTotal !== 'number') {
    throw new Error('battle state missing stacking fields');
  }
}

const firstId = initial.state.activePlayer;
const secondId = firstId === a.user.id ? b.user.id : a.user.id;
const firstSide = initial.state.players.indexOf(firstId);
const clientsById = { [a.user.id]: clientA, [b.user.id]: clientB };
const sideShips = (state, side, action, detail) =>
  state.ships
    .filter((ship) => ship.side === side)
    .map((ship) => ({ id: ship.id, action, detail }));
const sendShips = (playerId, ships) => {
  clientsById[playerId].send({
    type: 'battle.command',
    battleId: battle.id,
    ships,
  });
};

sendShips(firstId, sideShips(initial.state, firstSide, 'accelerate'));
await clientA.waitForMessage(
  (message) =>
    message.type === 'battle.state' &&
    message.state.phase === 'speed' &&
    message.state.activePlayer === secondId,
);
sendShips(secondId, sideShips(initial.state, 1 - firstSide, 'wait'));
const afterSpeed = await clientB.waitForMessage(
  (message) => message.type === 'battle.state' && message.state.phase === 'move1',
);
const firstShipId = afterSpeed.state.ships.find((ship) => ship.side === firstSide).id;
const firstShipAfterSpeed = afterSpeed.state.ships.find((ship) => ship.id === firstShipId);
if (firstShipAfterSpeed.speed !== 3) {
  throw new Error(`accelerate failed: ${firstShipAfterSpeed.speed}`);
}
const expectedShip = uploadedShipData.find((entry) => entry.shipId === firstShipAfterSpeed.shipId);
if (!expectedShip || firstShipAfterSpeed.maxHp !== expectedShip.maxHp) {
  throw new Error('uploaded ship data not used');
}

sendShips(firstId, sideShips(afterSpeed.state, firstSide, 'turn_left'));
await clientA.waitForMessage(
  (message) =>
    message.type === 'battle.state' &&
    message.state.phase === 'move1' &&
    message.state.activePlayer === secondId,
);
sendShips(secondId, sideShips(afterSpeed.state, 1 - firstSide, 'wait'));
const afterMove1 = await clientA.waitForMessage(
  (message) => message.type === 'battle.state' && message.state.phase === 'move2',
);
const firstShipAfterMove1 = afterMove1.state.ships.find((ship) => ship.id === firstShipId);
const initialFacing = firstSide === 0 ? 0 : 3;
const expectedFacing = (initialFacing + 5) % 6;
if (firstShipAfterMove1.facing !== expectedFacing) {
  throw new Error(`turn_left failed: ${firstShipAfterMove1.facing} != ${expectedFacing}`);
}
const initialFirstHex = initial.state.ships.find((ship) => ship.id === firstShipId).hex;
const move1Hex = firstShipAfterMove1.hex;
const hexDistance = Math.max(
  Math.abs(move1Hex[0] - initialFirstHex[0]),
  Math.abs(move1Hex[1] - initialFirstHex[1]),
  Math.abs(-move1Hex[0] - move1Hex[1] + initialFirstHex[0] + initialFirstHex[1]),
);
if (hexDistance !== 1) {
  throw new Error(`speed table phase1 move failed: ${hexDistance}`);
}

sendShips(firstId, sideShips(afterMove1.state, firstSide, 'wait'));
await clientA.waitForMessage(
  (message) =>
    message.type === 'battle.state' &&
    message.state.phase === 'move2' &&
    message.state.activePlayer === secondId,
);
sendShips(secondId, sideShips(afterMove1.state, 1 - firstSide, 'wait'));
const afterMove2 = await clientB.waitForMessage(
  (message) => message.type === 'battle.state' && message.state.phase === 'move3',
);

sendShips(firstId, sideShips(afterMove2.state, firstSide, 'wait'));
await clientA.waitForMessage(
  (message) =>
    message.type === 'battle.state' &&
    message.state.phase === 'move3' &&
    message.state.activePlayer === secondId,
);
sendShips(secondId, sideShips(afterMove2.state, 1 - firstSide, 'wait'));
const afterMove3 = await clientA.waitForMessage(
  (message) => message.type === 'battle.state' && message.state.phase === 'gunnery',
);

const enemyShipId = afterMove3.state.ships.find((ship) => ship.side !== firstSide).id;
sendShips(
  firstId,
  sideShips(afterMove3.state, firstSide, 'fire', { targetShipId: enemyShipId }),
);
await clientA.waitForMessage(
  (message) =>
    message.type === 'battle.state' &&
    message.state.phase === 'gunnery' &&
    message.state.activePlayer === secondId,
);
sendShips(secondId, sideShips(afterMove3.state, 1 - firstSide, 'wait'));
const afterGunnery = await clientB.waitForMessage(
  (message) =>
    message.type === 'battle.state' &&
    message.state.phase === 'speed' &&
    message.state.turn === 2,
);
if (!afterGunnery.state.eventLog.some((entry) => entry.message.includes('炮击'))) {
  throw new Error('gunnery event missing');
}
const firedBefore = afterMove3.state.ships.find((ship) => ship.side === firstSide);
const firedAfter = afterGunnery.state.ships.find((ship) => ship.id === firedBefore.id);
if (firedAfter.mainAmmo >= firedBefore.mainAmmo) {
  throw new Error('main ammo not consumed');
}
const cpBefore = firstSide === 0 ? afterMove3.state.playerCP : afterMove3.state.enemyCP;
const cpAfter = firstSide === 0 ? afterGunnery.state.playerCP : afterGunnery.state.enemyCP;
const fireCost = afterMove3.state.ships
  .filter((ship) => ship.side === firstSide)
  .reduce((sum, ship) => sum + (/^(BB|BC)/i.test(ship.shipClass) ? 2 : 1), 0);
const commandAfter = firstSide === 0 ? afterGunnery.state.playerCommand : afterGunnery.state.enemyCommand;
const maxAfter = firstSide === 0 ? afterGunnery.state.playerMaxCP : afterGunnery.state.enemyMaxCP;
const expectedCP = Math.min(
  cpBefore + commandAfter - fireCost,
  maxAfter,
);
if (cpAfter !== expectedCP) {
  throw new Error(`cp not consumed: ${cpBefore} -> ${cpAfter}, expected ${expectedCP}, firstSide=${firstSide}, ammo ${firedBefore.mainAmmo} -> ${firedAfter.mainAmmo}`);
}
if (afterGunnery.state.turnOrder[0] !== secondId) {
  throw new Error('initiative did not swap after turn end');
}
if (afterGunnery.state.playerCP < 0 || afterGunnery.state.enemyCP < 0) {
  throw new Error('cp went negative');
}

const broadcastPromise = clientB.waitFor('battle.rolled');
clientA.send({
  type: 'battle.roll',
  battleId: battle.id,
  count: 3,
  sides: 100,
  reason: 'ws-smoke',
});
const wsRoll = await broadcastPromise;
clientA.close();
clientB.close();
await new Promise((resolve) => setTimeout(resolve, 400));

const roomsAfterClose = await request('/api/lobby/rooms', { token: a.token });
if (roomsAfterClose.rooms.some((entry) => entry.id === room.id)) {
  throw new Error(`zombie room after both clients closed: ${room.id}`);
}

const pools = await request('/api/gacha/pools', { token: a.token });
const idempotencyKey = `smoke_${suffix}`;
const pull = await request('/api/gacha/pull', {
  method: 'POST',
  token: a.token,
  body: { pool: 'naval', count: 2, idempotencyKey },
});
const replay = await request('/api/gacha/pull', {
  method: 'POST',
  token: a.token,
  body: { pool: 'naval', count: 2, idempotencyKey },
});
if (replay.id !== pull.id || replay.replay !== true) {
  throw new Error('gacha idempotency replay failed');
}
const history = await request('/api/gacha/history', { token: a.token });

console.log(
  JSON.stringify(
    {
      me: me.username,
      room: joined,
      mapName: downloadedMap.map.Name,
      battle,
      battleReplayId: battleAgain.id,
      battleState: {
        turn: afterGunnery.state.turn,
        phase: afterGunnery.state.phase,
        ships: afterGunnery.state.ships.length,
      },
      wsRoll: {
        battleId: wsRoll.battleId,
        values: wsRoll.roll.values,
        sides: wsRoll.roll.sides,
      },
      roomCleanedAfterClose: true,
      gacha: {
        pool: pools.pools[0].id,
        pullId: pull.id,
        items: pull.items.map((item) => item.id),
        creditsLeft: pull.creditsLeft,
        replayId: replay.id,
        historyCount: history.pulls.length,
      },
    },
    null,
    2,
  ),
);
