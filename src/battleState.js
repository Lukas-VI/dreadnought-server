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

const PHASE_INDEX = {
  speed: 0,
  move1: 1,
  move2: 2,
  move3: 3,
  recon: 4,
  gunnery: 5,
  torpedo: 6,
};

const FACING_VECTORS = [
  [0, -1], // N
  [1, -1], // NE
  [1, 0],  // SE
  [0, 1],  // S
  [-1, 1], // SW
  [-1, 0], // NW
];

const SHIP_STATS = {
  dreadnought: { pv: 42, maxHp: 42, shipClass: 'BB', hull: [11, 21, 32, 42], speeds: [5, 5, 3, 2] },
  cruiser: { pv: 16, maxHp: 18, shipClass: 'CL', hull: [4, 9, 13, 18], speeds: [6, 5, 4, 2] },
  destroyer: { pv: 6, maxHp: 6, shipClass: 'DD', hull: [2, 3, 5, 6], speeds: [6, 6, 4, 2] },
  frigate: { pv: 5, maxHp: 4, shipClass: 'DD', hull: [1, 2, 3, 4], speeds: [6, 5, 4, 2] },
};

function addHex(a, b) {
  return [a[0] + b[0], a[1] + b[1]];
}

function hexDistance(a, b) {
  return Math.max(
    Math.abs(a[0] - b[0]),
    Math.abs(a[1] - b[1]),
    Math.abs(-a[0] - a[1] + b[0] + b[1]),
  );
}

function makeShip(side, index) {
  const stats = SHIP_STATS.frigate;
  return {
    id: `${side === 0 ? 'p' : 'e'}_${index}_${randomBytes(3).toString('hex')}`,
    name: `${side === 0 ? 'Player' : 'Enemy'} Ship ${index + 1}`,
    shipId: 'frigate',
    pv: stats.pv,
    shipClass: stats.shipClass,
    hull: stats.hull,
    speeds: stats.speeds,
    formationLeadId: null,
    formationIndex: -1,
    side,
    hex: side === 0 ? [2 - index, 0] : [-2 + index, 0],
    facing: side === 0 ? 0 : 3,
    speed: 2,
    maxSpeed: stats.speeds[0],
    hp: stats.maxHp,
    maxHp: stats.maxHp,
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
    const statsMap = loadShipStatsMap(db, roomId);
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
        const stats = statsMap[shipId] || SHIP_STATS[shipId] || SHIP_STATS.frigate;
        const facing = parseDirection(spawn.Direction);
        const speed = clamp(Number(spawn.Speed || 0), 0, stats.speeds[0]);
        ships.push({
          id: `${side === 0 ? 'p' : 'e'}_${index}_${key.replace(',', '_')}`,
          name: `${side === 0 ? 'Player' : 'Enemy'} ${shipId} ${index + 1}`,
          shipId,
          pv: stats.pv,
          shipClass: stats.shipClass,
          hull: stats.hull,
          speeds: stats.speeds,
          formationLeadId: null,
          formationIndex: -1,
          side,
          hex: [q, r],
          facing,
          speed,
          maxSpeed: stats.speeds[0],
          hp: stats.maxHp,
          maxHp: stats.maxHp,
          status: 'intact',
        });
      });
    }
    return ships.length > 0 ? ships : null;
  } catch {
    return null;
  }
}

function loadShipStatsMap(db, roomId) {
  const row = db.prepare('SELECT ship_data_json FROM rooms WHERE id = ?').get(roomId);
  if (!row || !row.ship_data_json) {
    return {};
  }
  try {
    const entries = JSON.parse(row.ship_data_json);
    const result = {};
    for (const entry of entries || []) {
      if (!entry || !entry.shipId) {
        continue;
      }
      result[entry.shipId] = {
        pv: Number(entry.pv) || 5,
        maxHp: Number(entry.maxHp) || 4,
        shipClass: entry.shipClass || 'DD',
        hull: Array.isArray(entry.hull) && entry.hull.length >= 4
          ? entry.hull
          : [1, 2, 3, 4],
        speeds: Array.isArray(entry.speeds) && entry.speeds.length >= 4
          ? entry.speeds
          : [6, 5, 4, 2],
      };
    }
    return result;
  } catch {
    return {};
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

function tierOf(ship) {
  const cls = ship.shipClass || '';
  if (/^(BB|BC)/i.test(cls)) {
    return 'large';
  }
  if (/^(CA|CL|CB)/i.test(cls)) {
    return 'medium';
  }
  return 'small';
}

function damageStateOf(ship) {
  const damage = Math.max(0, ship.maxHp - ship.hp);
  const [light, moderate, heavy, sunk] = ship.hull || [1, 2, 3, 4];
  if (damage >= sunk) {
    return 'sunk';
  }
  if (damage >= heavy) {
    return 'heavy';
  }
  if (damage >= moderate) {
    return 'moderate';
  }
  if (damage >= light) {
    return 'light';
  }
  return 'intact';
}

function maxSpeedForState(ship) {
  const state = ship.hp <= 0 ? 'sunk' : damageStateOf(ship);
  const speeds = ship.speeds || [6, 5, 4, 2];
  const index = { intact: 0, light: 1, moderate: 2, heavy: 3 }[state];
  return index == null ? 0 : speeds[index];
}

function commandValue(ships, base) {
  let largeLight = 0;
  let largeSevere = 0;
  let mediumSevere = 0;
  let smallSevere = 0;
  for (const ship of ships) {
    if (ship.hp <= 0) {
      const tier = tierOf(ship);
      if (tier === 'large') {
        largeSevere += 1;
      } else if (tier === 'medium') {
        mediumSevere += 1;
      } else {
        smallSevere += 1;
      }
      continue;
    }
    const state = damageStateOf(ship);
    if (state === 'intact') {
      continue;
    }
    const tier = tierOf(ship);
    if (tier === 'large') {
      if (state === 'light') {
        largeLight += 1;
      } else {
        largeSevere += 1;
      }
    } else if (tier === 'medium') {
      if (state !== 'light') {
        mediumSevere += 1;
      }
    } else if (state !== 'light') {
      smallSevere += 1;
    }
  }
  const reduction = largeSevere * 2 + largeLight + mediumSevere
    + (smallSevere >= 3 ? 1 : 0);
  return Math.max(1, Math.max(1, base) - reduction);
}

function pvScoreForShip(ship) {
  const state = ship.hp <= 0 ? 'sunk' : damageStateOf(ship);
  if (state === 'sunk') {
    return ship.pv || 0;
  }
  if (state === 'heavy') {
    return Math.floor((ship.pv || 0) / 2);
  }
  if (state === 'moderate') {
    return Math.floor((ship.pv || 0) / 4);
  }
  return 0;
}

function recomputeEconomy(state) {
  state.playerScore = state.ships
    .filter((ship) => ship.side === 1)
    .reduce((sum, ship) => sum + pvScoreForShip(ship), 0);
  state.enemyScore = state.ships
    .filter((ship) => ship.side === 0)
    .reduce((sum, ship) => sum + pvScoreForShip(ship), 0);
  state.playerCommand = commandValue(
    state.ships.filter((ship) => ship.side === 0),
    state.basePlayerCommand,
  );
  state.enemyCommand = commandValue(
    state.ships.filter((ship) => ship.side === 1),
    state.baseEnemyCommand,
  );
  state.playerMaxCP = Math.max(1, state.playerCommand * 2);
  state.enemyMaxCP = Math.max(1, state.enemyCommand * 2);
  state.playerCP = Math.min(state.playerCP, state.playerMaxCP);
  state.enemyCP = Math.min(state.enemyCP, state.enemyMaxCP);
}

function computeFormations(state) {
  for (const side of [0, 1]) {
    const ships = state.ships.filter((ship) => ship.side === side && ship.hp > 0);
    const previousGroups = new Map();
    for (const ship of ships) {
      if (!ship.formationLeadId) {
        continue;
      }
      if (!previousGroups.has(ship.formationLeadId)) {
        previousGroups.set(ship.formationLeadId, {
          leadWasSelf: ship.formationLeadId === ship.id,
          members: [],
        });
      }
      previousGroups.get(ship.formationLeadId).members.push({
        id: ship.id,
        index: ship.formationIndex,
      });
    }

    for (const ship of ships) {
      ship.formationLeadId = null;
      ship.formationIndex = -1;
    }

    const used = new Set();
    for (const [leadId, group] of previousGroups) {
      if (!group.leadWasSelf) {
        continue;
      }
      const lead = ships.find((ship) => ship.id === leadId);
      if (!lead) {
        continue;
      }
      const ordered = group.members
        .sort((a, b) => a.index - b.index)
        .map((member) => ships.find((ship) => ship.id === member.id))
        .filter(Boolean);
      if (ordered.length < 2) {
        continue;
      }
      let adjacent = true;
      for (let i = 1; i < ordered.length; i++) {
        if (hexDistance(ordered[i - 1].hex, ordered[i].hex) > 1) {
          adjacent = false;
          break;
        }
      }
      if (!adjacent) {
        continue;
      }
      ordered.forEach((ship, index) => {
        ship.formationLeadId = lead.id;
        ship.formationIndex = index;
        used.add(ship.id);
      });
    }

    const remaining = ships.filter((ship) => !used.has(ship.id));
    const ungrouped = new Set(remaining);
    for (const lead of ships) {
      if (!remaining.includes(lead) || !ungrouped.has(lead)) {
        continue;
      }
      const cells = new Map();
      for (const ship of ships) {
        if (!ungrouped.has(ship) || ship.facing !== lead.facing || ship.speed !== lead.speed) {
          continue;
        }
        const key = ship.hex.join(',');
        if (!cells.has(key)) {
          cells.set(key, []);
        }
        cells.get(key).push(ship);
      }

      const chain = [];
      const visited = new Set();
      const forward = FACING_VECTORS[lead.facing];
      const backward = [-forward[0], -forward[1]];
      const collect = (key) => {
        for (const ship of cells.get(key) || []) {
          if (visited.add(ship)) {
            chain.push(ship);
          }
        }
      };

      let cursor = addHex(lead.hex, forward);
      while (cells.has(cursor.join(','))) {
        collect(cursor.join(','));
        cursor = addHex(cursor, forward);
      }
      collect(lead.hex.join(','));
      cursor = addHex(lead.hex, backward);
      while (cells.has(cursor.join(','))) {
        collect(cursor.join(','));
        cursor = addHex(cursor, backward);
      }

      if (chain.length >= 2) {
        chain.forEach((ship, index) => {
          ship.formationLeadId = lead.id;
          ship.formationIndex = index;
        });
        for (const ship of chain) {
          ungrouped.delete(ship);
        }
      } else {
        ungrouped.delete(lead);
      }
    }
  }
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
    mapType: config.MapType || 'day',
    torpedoPhaseEnabled: Boolean(config.TorpedoPhaseEnabled),
    phaseSeconds: Array.isArray(config.PhaseSecondsPerShip) &&
      config.PhaseSecondsPerShip.length >= 5
      ? config.PhaseSecondsPerShip
      : [5, 5, 5, 5, 5, 10, 10, 0],
    phaseExtra: Number(config.PhaseExtraSeconds) || 5,
    timerRemaining: 0,
    timerTotal: 0,
    timerActivePlayer: null,
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
  const timers = new Map();
  let broadcastState = null;
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
      mapType: state.mapType,
      torpedoPhaseEnabled: state.torpedoPhaseEnabled,
      timerRemaining: state.timerRemaining,
      timerTotal: state.timerTotal,
      timerActivePlayer: state.timerActivePlayer,
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
    computeFormations(state);
    state.commands = Object.fromEntries(state.players.map((playerId) => [playerId, null]));
    const settledPhase = state.phase;

    if (settledPhase === 'gunnery') {
      state.eventLog.push({
        at: new Date().toISOString(),
        message: `第 ${state.turn} 回合结算完成`,
      });
      if (state.mapType === 'night') {
        state.eventLog.push({
          at: new Date().toISOString(),
          message: '夜战地图：视野阶段由服务端自动跳过',
        });
      }
      if (state.torpedoPhaseEnabled) {
        state.eventLog.push({
          at: new Date().toISOString(),
          message: '鱼雷阶段已启用：当前由服务端自动跳过',
        });
      }
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
    const moves = [];
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
          ship.speed = clamp(ship.speed + delta, 0, maxSpeedForState(ship));
          continue;
        }

        if (state.phase.startsWith('move')) {
          let facing = ship.facing;
          if (action === 'turn_left') {
            facing = (facing + 5) % 6;
          } else if (action === 'turn_right') {
            facing = (facing + 1) % 6;
          }
          moves.push({
            ship,
            facing,
            target: addHex(ship.hex, FACING_VECTORS[facing]),
          });
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

    if (state.phase.startsWith('move')) {
      const counts = new Map();
      for (const move of moves) {
        const key = move.target.join(',');
        const count = counts.get(key) || { 0: 0, 1: 0 };
        count[move.ship.side] += 1;
        counts.set(key, count);
      }

      for (const move of moves) {
        move.ship.facing = move.facing;
        const count = counts.get(move.target.join(','));
        const blocked = count[1 - move.ship.side] > 0 || count[move.ship.side] > 2;
        if (blocked) {
          state.eventLog.push({
            at: new Date().toISOString(),
            message: `${move.ship.name} 移动被阻挡（堆叠上限或敌格）`,
          });
          continue;
        }
        move.ship.hex = move.target;
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

  function stopTimer(battleId) {
    const entry = timers.get(battleId);
    if (entry && entry.handle) {
      clearInterval(entry.handle);
    }
    timers.delete(battleId);
  }

  function advanceState(state) {
    if (state.status !== 'active') {
      return;
    }
    if (!state.commands[state.activePlayer]) {
      state.commands[state.activePlayer] = { ships: [] };
    }
    if (state.activePlayer === state.turnOrder[0]) {
      state.activePlayer = state.turnOrder[1];
    } else {
      settle(state);
    }
    persist(state);
  }

  function startTimer(state) {
    stopTimer(state.id);
    state.timerActivePlayer = state.activePlayer;
    if (state.status !== 'active' || PHASE_INDEX[state.phase] == null) {
      state.timerRemaining = 0;
      state.timerTotal = 0;
      return;
    }
    const phaseIndex = PHASE_INDEX[state.phase];
    const perShip = Number(state.phaseSeconds[phaseIndex]) || 5;
    const side = state.players.indexOf(state.activePlayer);
    const count = state.ships.filter((ship) => ship.side === side && ship.hp > 0).length;
    const total = Math.max(1, perShip * count + (Number(state.phaseExtra) || 5));
    state.timerRemaining = total;
    state.timerTotal = total;
    const battleId = state.id;
    timers.set(battleId, {
      remaining: total,
      total,
      handle: setInterval(() => {
        const entry = timers.get(battleId);
        if (!entry) {
          return;
        }
        entry.remaining = Math.max(0, entry.remaining - 1);
        state.timerRemaining = entry.remaining;
        persist(state);
        if (broadcastState) {
          broadcastState(battleId, publicState(state));
        }
        if (entry.remaining <= 0) {
          stopTimer(battleId);
          advanceState(state);
          startTimer(state);
          persist(state);
          if (broadcastState) {
            broadcastState(battleId, publicState(state));
          }
        }
      }, 1000),
    });
  }

  function syncTimer(state) {
    if (state.status === 'active' && !timers.has(state.id)) {
      startTimer(state);
    } else if (state.status !== 'active') {
      stopTimer(state.id);
    }
  }

  return {
    getState(token, battleId) {
      const { state } = resolveBattle(token, battleId);
      syncTimer(state);
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

      advanceState(state);
      startTimer(state);
      persist(state);
      return publicState(state);
    },

    advance(token, { battleId }) {
      const { user, state } = resolveBattle(token, battleId);
      if (state.status !== 'active') {
        throw httpError(409, 'battle_not_active');
      }
      advanceState(state);
      startTimer(state);
      persist(state);
      return publicState(state);
    },

    setBroadcastCallback(callback) {
      broadcastState = callback;
    },
  };
}
