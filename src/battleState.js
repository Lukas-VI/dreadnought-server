import { randomBytes, randomInt } from 'node:crypto';

import { httpError } from './httpError.js';

const NEXT_PHASE = {
  speed: 'move1',
  move1: 'move2',
  move2: 'move3',
  move3: 'gunnery',
  gunnery: 'settlement',
  settlement: 'speed',
};

const FACING_VECTORS = [
  [0, -1], // N
  [1, -1], // NE
  [1, 0],  // SE
  [0, 1],  // S
  [-1, 1], // SW
  [-1, 0], // NW
];

function addHex(a, b) {
  return [a[0] + b[0], a[1] + b[1]];
}

function makeShip(side, index) {
  return {
    id: `${side === 0 ? 'p' : 'e'}_${index}_${randomBytes(3).toString('hex')}`,
    name: `${side === 0 ? 'Player' : 'Enemy'} Ship ${index + 1}`,
    shipId: 'frigate',
    pv: 10,
    side,
    hex: side === 0 ? [2 - index, 0] : [-2 + index, 0],
    facing: side === 0 ? 0 : 3,
    speed: 2,
    maxSpeed: 5,
    hp: 10,
    maxHp: 10,
    status: 'intact',
  };
}

const DIRECTION_FACING = {
  N: 0,
  NE: 1,
  SE: 2,
  S: 3,
  SW: 4,
  NW: 5,
};

function parseDirection(value) {
  if (typeof value === 'number') {
    return value % 6;
  }
  if (typeof value === 'string') {
    return DIRECTION_FACING[value.toUpperCase()] ?? 0;
  }
  return 0;
}

function loadMapShips(db, roomId) {
  const row = db.prepare('SELECT map_json FROM rooms WHERE id = ?').get(roomId);
  if (!row || !row.map_json) {
    return null;
  }
  try {
    const map = JSON.parse(row.map_json);
    const generation = map.Generation || {};
    const shipMap = map.Ships || {};
    const ships = [];
    for (const [key, gen] of Object.entries(generation)) {
      const [q, r] = key.split(',').map(Number);
      if (!Number.isInteger(q) || !Number.isInteger(r)) {
        continue;
      }
      const side = gen.Side === 1 ? 1 : 0;
      const spawns = shipMap[key] || [];
      spawns.forEach((spawn, index) => {
        const shipId = spawn.ShipId || 'frigate';
        const facing = parseDirection(spawn.Direction);
        const speed = clamp(Number(spawn.Speed || 0), 0, 5);
        ships.push({
          id: `${side === 0 ? 'p' : 'e'}_${index}_${key.replace(',', '_')}`,
          name: `${side === 0 ? 'Player' : 'Enemy'} ${shipId} ${index + 1}`,
          shipId,
          pv: 10,
          side,
          hex: [q, r],
          facing,
          speed,
          maxSpeed: 5,
          hp: 10,
          maxHp: 10,
          status: 'intact',
        });
      });
    }
    return ships.length > 0 ? ships : null;
  } catch {
    return null;
  }
}

function loadMapConfig(db, roomId) {
  const row = db.prepare('SELECT map_json FROM rooms WHERE id = ?').get(roomId);
  if (!row || !row.map_json) {
    return {};
  }
  try {
    return JSON.parse(row.map_json);
  } catch {
    return {};
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function recomputeEconomy(state) {
  state.playerScore = state.ships
    .filter((ship) => ship.side === 1 && ship.hp <= 0)
    .reduce((sum, ship) => sum + (ship.pv || 10), 0);
  state.enemyScore = state.ships
    .filter((ship) => ship.side === 0 && ship.hp <= 0)
    .reduce((sum, ship) => sum + (ship.pv || 10), 0);
  state.playerCommand = Math.max(
    1,
    state.basePlayerCommand - state.ships.filter((ship) => ship.side === 0 && ship.hp <= 0).length,
  );
  state.enemyCommand = Math.max(
    1,
    state.baseEnemyCommand - state.ships.filter((ship) => ship.side === 1 && ship.hp <= 0).length,
  );
  state.playerMaxCP = Math.max(1, state.playerCommand * 2);
  state.enemyMaxCP = Math.max(1, state.enemyCommand * 2);
  state.playerCP = Math.min(state.playerCP, state.playerMaxCP);
  state.enemyCP = Math.min(state.enemyCP, state.enemyMaxCP);
}

function createState(battle, db) {
  const rollFirst = randomInt(1, 101);
  const rollSecond = randomInt(1, 101);
  const first = rollFirst >= rollSecond ? battle.players[0] : battle.players[1];
  const second = battle.players.find((playerId) => playerId !== first);
  const config = loadMapConfig(db, battle.roomId);
  const basePlayerCommand = Number(config.PlayerCommand) || 5;
  const baseEnemyCommand = Number(config.EnemyCommand) || 4;
  const playerMaxCP = Math.max(1, basePlayerCommand * 2);
  const enemyMaxCP = Math.max(1, baseEnemyCommand * 2);
  return {
    id: battle.id,
    roomId: battle.roomId,
    players: battle.players,
    turn: 1,
    phase: 'speed',
    status: 'active',
    winner: null,
    maxTurns: Number(config.MaxTurns) || 18,
    basePlayerCommand,
    baseEnemyCommand,
    playerCommand: basePlayerCommand,
    enemyCommand: baseEnemyCommand,
    playerMaxCP,
    enemyMaxCP,
    playerCP: Math.min(Number(config.PlayerInitialCP) || 8, playerMaxCP),
    enemyCP: Math.min(Number(config.EnemyInitialCP) || 8, enemyMaxCP),
    playerScore: 0,
    enemyScore: 0,
    turnOrder: [first, second],
    activePlayer: first,
    initiative: {
      [battle.players[0]]: rollFirst,
      [battle.players[1]]: rollSecond,
    },
    commands: Object.fromEntries(battle.players.map((playerId) => [playerId, null])),
    ships: loadMapShips(db, battle.roomId) || [
      makeShip(0, 0),
      makeShip(0, 1),
      makeShip(1, 0),
      makeShip(1, 1),
    ],
    eventLog: [],
  };
}

export function createBattleStateService({ db, accountService, battleService }) {
  const states = new Map();
  const updateState = db.prepare('UPDATE battles SET state_json = ? WHERE id = ?');
  const selectState = db.prepare('SELECT state_json FROM battles WHERE id = ?');

  function persist(state) {
    updateState.run(JSON.stringify(state), state.id);
  }

  function load(battleId) {
    const row = selectState.get(battleId);
    if (!row || !row.state_json) {
      return null;
    }
    const state = JSON.parse(row.state_json);
    states.set(battleId, state);
    return state;
  }

  function getOrCreate(battle) {
    if (states.has(battle.id)) {
      return states.get(battle.id);
    }
    const loaded = load(battle.id);
    if (loaded) {
      return loaded;
    }
    const state = createState(battle, db);
    states.set(battle.id, state);
    persist(state);
    return state;
  }

  function publicState(state) {
    return {
      id: state.id,
      roomId: state.roomId,
      players: state.players,
      turn: state.turn,
      phase: state.phase,
      status: state.status,
      winner: state.winner,
      maxTurns: state.maxTurns,
      turnOrder: state.turnOrder,
      activePlayer: state.activePlayer,
      initiative: state.initiative,
      playerCommand: state.playerCommand,
      enemyCommand: state.enemyCommand,
      playerMaxCP: state.playerMaxCP,
      enemyMaxCP: state.enemyMaxCP,
      playerCP: state.playerCP,
      enemyCP: state.enemyCP,
      playerScore: state.playerScore,
      enemyScore: state.enemyScore,
      commands: Object.fromEntries(
        Object.entries(state.commands).map(([playerId, command]) => [
          playerId,
          command
            ? { submitted: true, shipCount: (command.ships || []).length }
            : { submitted: false, shipCount: 0 },
        ]),
      ),
      ships: state.ships,
      eventLog: state.eventLog.slice(-30),
    };
  }

  function resolveBattle(token, battleId) {
    const user = accountService.resolveToken(token);
    const battle = battleService.get(token, battleId);
    const state = getOrCreate(battle);
    if (!state.players.includes(user.id)) {
      throw httpError(403, 'not_in_battle');
    }
    return { user, state };
  }

  function validateCommand(state, playerSide, command) {
    const allowed = {
      speed: ['accelerate', 'decelerate', 'wait'],
      move1: ['turn_left', 'turn_right', 'wait'],
      move2: ['turn_left', 'turn_right', 'wait'],
      move3: ['turn_left', 'turn_right', 'wait'],
      gunnery: ['fire', 'wait'],
    };
    for (const entry of command.ships || []) {
      if (!allowed[state.phase] || !allowed[state.phase].includes(entry.action)) {
        throw httpError(400, 'invalid_command_for_phase');
      }
      const ship = state.ships.find((candidate) => candidate.id === entry.id);
      if (!ship || ship.side !== playerSide) {
        throw httpError(400, 'invalid_ship');
      }
      if (entry.action === 'fire') {
        const targetId = entry.detail && entry.detail.targetShipId;
        const target = state.ships.find((candidate) => candidate.id === targetId);
        if (!target || target.side === playerSide) {
          throw httpError(400, 'invalid_target');
        }
      }
    }
  }

  function settle(state) {
    applyPhase(state);
    state.commands = Object.fromEntries(state.players.map((playerId) => [playerId, null]));
    const settledPhase = state.phase;

    if (settledPhase === 'gunnery') {
      state.eventLog.push({
        at: new Date().toISOString(),
        message: `第 ${state.turn} 回合结算完成`,
      });
      if (state.status !== 'active' || state.turn >= state.maxTurns) {
        if (state.status === 'active') {
          state.status = 'finished';
          state.winner = state.players[0];
        }
        return;
      }
      state.turn += 1;
      state.phase = 'speed';
      state.turnOrder = [state.turnOrder[1], state.turnOrder[0]];
      state.playerCP = Math.min(state.playerCP + state.playerCommand, state.playerMaxCP);
      state.enemyCP = Math.min(state.enemyCP + state.enemyCommand, state.enemyMaxCP);
      state.eventLog.push({
        at: new Date().toISOString(),
        message: `第 ${state.turn} 回合，先手权交换`,
      });
    } else {
      state.phase = NEXT_PHASE[state.phase];
      state.eventLog.push({
        at: new Date().toISOString(),
        message: `进入阶段 ${state.phase}`,
      });
    }
    state.activePlayer = state.turnOrder[0];
  }

  function applyPhase(state) {
    for (const playerId of state.turnOrder) {
      const command = state.commands[playerId];
      const playerSide = state.players.indexOf(playerId);
      const ships = state.ships.filter((ship) => ship.side === state.players.indexOf(playerId));
      for (const ship of ships) {
        const entry = (command.ships || []).find((candidate) => candidate.id === ship.id)
          || { action: 'wait', detail: null };
        const action = entry.action || 'wait';
        if (state.phase === 'speed') {
          const delta = action === 'accelerate'
            ? 1
            : action === 'decelerate'
              ? -1
              : 0;
          ship.speed = clamp(ship.speed + delta, 0, ship.maxSpeed);
          continue;
        }

        if (state.phase.startsWith('move')) {
          if (action === 'turn_left') {
            ship.facing = (ship.facing + 5) % 6;
          } else if (action === 'turn_right') {
            ship.facing = (ship.facing + 1) % 6;
          }
          ship.hex = addHex(ship.hex, FACING_VECTORS[ship.facing]);
          continue;
        }

        if (state.phase === 'gunnery' && action === 'fire') {
          const target = state.ships.find(
            (candidate) => candidate.id === entry.detail.targetShipId,
          );
          if (target && target.side !== ship.side) {
            const roll = randomInt(1, 101);
            const hit = roll <= 70;
            const damage = hit ? randomInt(1, 5) : 0;
            if (hit) {
              target.hp = Math.max(0, target.hp - damage);
              target.status = target.hp <= 0 ? 'sunk' : 'damaged';
            }
            state.eventLog.push({
              at: new Date().toISOString(),
              message: `${ship.name} 炮击 ${target.name}: d100=${roll} ${hit ? `命中 ${damage} 伤` : '未命中'}`,
            });
          }
        }
      }
    }

    for (const side of [0, 1]) {
      const alive = state.ships.some(
        (ship) => ship.side === side && ship.hp > 0,
      );
      if (!alive) {
        state.status = 'finished';
        state.winner = state.players[side === 0 ? 1 : 0];
        state.eventLog.push({
          at: new Date().toISOString(),
          message: `战斗结束，${state.winner} 获胜`,
        });
      }
    }

    recomputeEconomy(state);
  }

  return {
    getState(token, battleId) {
      const { state } = resolveBattle(token, battleId);
      return publicState(state);
    },

    command(token, { battleId, action, detail, ships }) {
      const { user, state } = resolveBattle(token, battleId);
      if (state.status !== 'active') {
        throw httpError(409, 'battle_not_active');
      }
      if (state.commands[user.id]) {
        throw httpError(409, 'already_submitted');
      }
      if (state.activePlayer !== user.id) {
        throw httpError(409, 'not_your_turn');
      }
      const playerSide = state.players.indexOf(user.id);
      let shipCommands;
      if (Array.isArray(ships) && ships.length > 0) {
        shipCommands = ships;
      } else if (action) {
        shipCommands = state.ships
          .filter((ship) => ship.side === playerSide)
          .map((ship) => ({ id: ship.id, action, detail: detail || null }));
      } else {
        shipCommands = [];
      }
      validateCommand(state, playerSide, { ships: shipCommands });
      state.commands[user.id] = { ships: shipCommands };
      persist(state);

      if (user.id === state.turnOrder[0]) {
        state.activePlayer = state.turnOrder[1];
      } else {
        settle(state);
      }
      persist(state);
      return publicState(state);
    },

    advance(token, { battleId }) {
      const { user, state } = resolveBattle(token, battleId);
      if (state.status !== 'active') {
        throw httpError(409, 'battle_not_active');
      }
      for (const playerId of state.players) {
        if (!state.commands[playerId]) {
          state.commands[playerId] = { ships: [] };
        }
      }
      if (state.activePlayer === state.turnOrder[0]) {
        state.activePlayer = state.turnOrder[1];
      } else {
        settle(state);
      }
      persist(state);
      return publicState(state);
    },
  };
}
