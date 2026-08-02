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
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];

function addHex(a, b) {
  return [a[0] + b[0], a[1] + b[1]];
}

function makeShip(side, index) {
  return {
    id: `${side === 0 ? 'p' : 'e'}_${index}_${randomBytes(3).toString('hex')}`,
    name: `${side === 0 ? 'Player' : 'Enemy'} Ship ${index + 1}`,
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function createState(battle) {
  return {
    id: battle.id,
    roomId: battle.roomId,
    players: battle.players,
    turn: 1,
    phase: 'speed',
    status: 'active',
    winner: null,
    maxTurns: 18,
    commands: Object.fromEntries(battle.players.map((playerId) => [playerId, null])),
    ships: [
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
    const state = createState(battle);
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
      commands: Object.fromEntries(
        Object.entries(state.commands).map(([playerId, command]) => [
          playerId,
          command ? command.action : null,
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

  function validateCommand(state, action, detail) {
    const allowed = {
      speed: ['accelerate', 'decelerate', 'wait'],
      move1: ['turn_left', 'turn_right', 'wait'],
      move2: ['turn_left', 'turn_right', 'wait'],
      move3: ['turn_left', 'turn_right', 'wait'],
      gunnery: ['fire', 'wait'],
    };
    if (!allowed[state.phase] || !allowed[state.phase].includes(action)) {
      throw httpError(400, 'invalid_command_for_phase');
    }
    if (action === 'fire') {
      const targetId = detail && detail.targetShipId;
      const target = state.ships.find((ship) => ship.id === targetId);
      if (!target) {
        throw httpError(400, 'invalid_target');
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
    } else {
      state.phase = NEXT_PHASE[state.phase];
      state.eventLog.push({
        at: new Date().toISOString(),
        message: `进入阶段 ${state.phase}`,
      });
    }
  }

  function applyPhase(state) {
    for (const playerId of state.players) {
      const command = state.commands[playerId];
      const ships = state.ships.filter((ship) => ship.side === state.players.indexOf(playerId));
      for (const ship of ships) {
        if (state.phase === 'speed') {
          const delta = command.action === 'accelerate'
            ? 1
            : command.action === 'decelerate'
              ? -1
              : 0;
          ship.speed = clamp(ship.speed + delta, 0, ship.maxSpeed);
          continue;
        }

        if (state.phase.startsWith('move')) {
          if (command.action === 'turn_left') {
            ship.facing = (ship.facing + 5) % 6;
          } else if (command.action === 'turn_right') {
            ship.facing = (ship.facing + 1) % 6;
          }
          ship.hex = addHex(ship.hex, FACING_VECTORS[ship.facing]);
          continue;
        }

        if (state.phase === 'gunnery' && command.action === 'fire') {
          const target = state.ships.find((entry) => entry.id === command.detail.targetShipId);
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
  }

  return {
    getState(token, battleId) {
      const { state } = resolveBattle(token, battleId);
      return publicState(state);
    },

    command(token, { battleId, action, detail }) {
      const { user, state } = resolveBattle(token, battleId);
      if (state.status !== 'active') {
        throw httpError(409, 'battle_not_active');
      }
      if (state.commands[user.id]) {
        throw httpError(409, 'already_submitted');
      }
      validateCommand(state, action, detail);
      state.commands[user.id] = { action, detail: detail || null };
      persist(state);

      const submitted = state.players.filter((playerId) => state.commands[playerId]);
      if (submitted.length === state.players.length) {
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
          state.commands[playerId] = { action: 'wait', detail: null };
        }
      }
      settle(state);
      persist(state);
      return publicState(state);
    },
  };
}
