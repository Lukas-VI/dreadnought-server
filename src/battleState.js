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

const DEFAULT_COMBAT = {
  attackRange: 4,
  attackPower: 6,
  mainAmmo: 12,
  forwardFire: 2,
  sideFire: 4,
  backwardFire: 2,
  gunCaliber: 12,
  secondaryForwardFire: 0,
  secondarySideFire: 0,
  secondaryBackwardFire: 0,
  secondaryGunCaliber: 12,
  secondaryAttackPower: 0,
  armorClose: 0,
  armorMedium: 0,
  armorFar: 0,
  radarType: '',
};

function numOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

const SPEED_TABLE = [
  { p1: 0, p2: 0, p3: 0 },
  { p1: 0, p2: 0, p3: 0, alternate: true },
  { p1: 1, p2: 0, p3: 0 },
  { p1: 1, p2: 1, p3: 0 },
  { p1: 1, p2: 1, p3: 0 },
  { p1: 1, p2: 1, p3: 1 },
  { p1: 2, p2: 1, p3: 1 },
  { p1: 2, p2: 2, p3: 1 },
  { p1: 2, p2: 2, p3: 2 },
];

function moveForPhase(speed, phase, oddTurn) {
  const entry = SPEED_TABLE[Math.max(0, Math.min(8, speed))] || SPEED_TABLE[0];
  const base = phase === 1 ? entry.p1 : phase === 2 ? entry.p2 : entry.p3;
  if (entry.alternate && oddTurn && phase === 1) {
    return Math.max(base, 1);
  }
  return base;
}

function facingFromOffset(dx, dy) {
  const index = FACING_VECTORS.findIndex((v) => v[0] === dx && v[1] === dy);
  return index === -1 ? 0 : index;
}

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

function isIsland(terrain, hex) {
  const value = terrain ? terrain[hex.join(',')] : undefined;
  if (typeof value === 'number') {
    return value === 1;
  }
  return value === 'island';
}

function consumeSideCP(state, side, cost) {
  if (cost <= 0) {
    return true;
  }
  if (side === 0) {
    if (state.playerCP < cost) {
      return false;
    }
    state.playerCP -= cost;
    return true;
  }
  if (state.enemyCP < cost) {
    return false;
  }
  state.enemyCP -= cost;
  return true;
}

function baseDamage(caliberInches) {
  const caliber = numOr(caliberInches, 12);
  if (caliber >= 18) return 12;
  if (caliber >= 16) return 10;
  if (caliber >= 14) return 8;
  if (caliber >= 12) return 6;
  if (caliber >= 8) return 4;
  return 2;
}

function radarHitModifier(radarType) {
  if (!radarType) return 0;
  const key = String(radarType).toLowerCase();
  if (key.includes('jp')) return -3;
  if (key.includes('us')) return key.includes('a') ? -2 : 0;
  return 0;
}

function hitThreshold(distanceHex, radarUsed, ship) {
  let threshold = distanceHex <= 2 ? 8
    : distanceHex <= 5 ? 6
      : distanceHex <= 8 ? 4
        : distanceHex <= 12 ? 2
          : 1;
  if (radarUsed) {
    threshold += radarHitModifier(ship.radarType);
  }
  return clamp(threshold, 1, 10);
}

function firingArc(shipHex, targetHex, facing) {
  const dq = targetHex[0] - shipHex[0];
  const dr = targetHex[1] - shipHex[1];
  if (dq === 0 && dr === 0) {
    return 'Center';
  }
  const x = Math.sqrt(3) * (dq + dr / 2);
  const y = 1.5 * dr;
  let angle = Math.atan2(y, x) * 180 / Math.PI % 360;
  if (angle < 0) {
    angle += 360;
  }
  const facingAngle = (facing % 6) * 60 + 60;
  let relAngle = (angle - facingAngle) % 360;
  if (relAngle < 0) {
    relAngle += 360;
  }
  if (relAngle <= 30.1 || relAngle >= 329.9) {
    return 'Front';
  }
  if (relAngle >= 149.9 && relAngle <= 210.1) {
    return 'Rear';
  }
  if (relAngle > 30.1 && relAngle < 149.9) {
    return 'Port';
  }
  return 'Starboard';
}

function arcPowerFor(ship, arc, secondary) {
  if (!ship) {
    return secondary ? 0 : 6;
  }
  const baseKey = arc === 'Front' ? 'forwardFire' : arc === 'Rear' ? 'backwardFire' : 'sideFire';
  const key = secondary
    ? `secondary${baseKey.charAt(0).toUpperCase()}${baseKey.slice(1)}`
    : baseKey;
  return numOr(ship[key], secondary ? 0 : 6);
}

function weaponBasePower(ship, secondary) {
  if (!secondary) {
    return numOr(ship.attackPower, 6);
  }
  const configured = numOr(ship.secondaryAttackPower, 0);
  if (configured > 0) {
    return configured;
  }
  const mainDamage = Math.max(1, baseDamage(ship.gunCaliber));
  const secondaryDamage = Math.max(1, baseDamage(ship.secondaryGunCaliber));
  return Math.max(1, Math.floor(numOr(ship.attackPower, 6) * secondaryDamage / mainDamage));
}

function stateCoeff(ship) {
  const state = damageStateOf(ship);
  return state === 'intact' ? 3 : state === 'light' ? 2 : state === 'moderate' ? 1 : 0;
}

function armorFor(ship, distanceHex) {
  if (distanceHex <= 3) {
    return numOr(ship.armorClose, 8);
  }
  if (distanceHex <= 7) {
    return numOr(ship.armorMedium, 6);
  }
  return numOr(ship.armorFar, 3);
}

function resolveShotCheck(ship, target, distanceHex, radarUsed, secondary) {
  const weapon = secondary ? '副炮' : '主炮';
  const threshold = hitThreshold(distanceHex, radarUsed, ship);
  const roll = randomInt(1, 11);
  const coeff = stateCoeff(ship);
  if (coeff <= 0) {
    return {
      Hit: false,
      HitThreshold: threshold,
      HitRoll: roll,
      Damage: 0,
      Detail: `${ship.name} 大破/沉没，无法射击`,
    };
  }
  const arc = firingArc(ship.hex, target.hex, ship.facing);
  const arcPower = arcPowerFor(ship, arc, secondary);
  if (arcPower <= 0) {
    return {
      Hit: false,
      HitThreshold: threshold,
      HitRoll: roll,
      Damage: 0,
      Detail: `${ship.name} ${weapon} → ${target.name} 目标不在射界内，无法开火`,
    };
  }
  if (roll > threshold) {
    return {
      Hit: false,
      HitThreshold: threshold,
      HitRoll: roll,
      Damage: 0,
      Detail: `${ship.name} ${weapon} → ${target.name} 命中检定：1D10=${roll} > ${threshold}，未命中`,
    };
  }
  const baseDmg = Math.max(1, Math.floor(weaponBasePower(ship, secondary) * arcPower * coeff / 18));
  const distanceFalloff = distanceHex <= 3 ? 0
    : distanceHex <= 7 ? Math.floor(baseDmg / 4)
      : Math.floor(baseDmg / 2);
  const armor = armorFor(target, distanceHex);
  const variance = randomInt(-3, 4);
  const final = Math.max(1, baseDmg - distanceFalloff - armor + variance);
  return {
    Hit: true,
    HitThreshold: threshold,
    HitRoll: roll,
    Damage: final,
    Detail: `${ship.name} ${weapon} → ${target.name} 命中检定：1D10=${roll} ≤ ${threshold}，命中；`
      + `伤害 ${baseDmg} - ${distanceFalloff}(距离) - ${armor}(装甲) + ${variance} = ${final}`,
  };
}

function resolveGunnery(state, ship, target, radarUsed) {
  const distanceHex = hexDistance(ship.hex, target.hex);
  const arc = firingArc(ship.hex, target.hex, ship.facing);
  const mainArc = arcPowerFor(ship, arc, false) > 0;
  const secondaryArc = arcPowerFor(ship, arc, true) > 0;
  if (!mainArc && !secondaryArc) {
    state.eventLog.push({
      at: new Date().toISOString(),
      message: `${ship.name} 炮击 → ${target.name}：主炮/副炮均不在射界内，无法开火`,
    });
    return;
  }

  let totalDamage = 0;
  let mainHit = false;
  let secondaryHit = false;
  if (mainArc) {
    const check = resolveShotCheck(ship, target, distanceHex, radarUsed, false);
    state.eventLog.push({ at: new Date().toISOString(), message: check.Detail });
    if (check.Hit) {
      mainHit = true;
      applyShipDamage(state, target, check.Damage);
      totalDamage += check.Damage;
    }
  }
  if (secondaryArc) {
    const check = resolveShotCheck(ship, target, distanceHex, radarUsed, true);
    state.eventLog.push({ at: new Date().toISOString(), message: check.Detail });
    if (check.Hit) {
      secondaryHit = true;
      applyShipDamage(state, target, check.Damage);
      totalDamage += check.Damage;
    }
  }

  let summary;
  if (mainHit && secondaryHit) {
    summary = `${ship.name} 主炮与副炮炮击命中 ${target.name}，共造成 ${totalDamage} 点损伤`;
  } else if (mainHit) {
    summary = `${ship.name} 主炮炮击命中 ${target.name}，造成 ${totalDamage} 点损伤`;
  } else if (secondaryHit) {
    summary = `${ship.name} 副炮炮击命中 ${target.name}，造成 ${totalDamage} 点损伤`;
  } else {
    summary = `${ship.name} 炮击跨射散布，炮弹落水！`;
  }
  state.eventLog.push({ at: new Date().toISOString(), message: summary });
}

function applyShipDamage(state, ship, damage) {
  if (damage <= 0) {
    return;
  }
  ship.hp = Math.max(0, ship.hp - damage);
  ship.status = ship.hp <= 0 ? 'sunk' : damageStateOf(ship);
}

function collisionDamage(hullSum, roll) {
  if (hullSum <= 8) {
    return Math.max(1, Math.floor(roll / 3));
  }
  return Math.max(1, Math.floor(roll / 2));
}

function addOccupant(occupied, hex, ship) {
  const key = hex.join(',');
  if (!occupied.has(key)) {
    occupied.set(key, []);
  }
  if (!occupied.get(key).includes(ship)) {
    occupied.get(key).push(ship);
  }
}

function removeOccupant(occupied, hex, ship) {
  const key = hex.join(',');
  const list = occupied.get(key);
  if (!list) {
    return;
  }
  const index = list.indexOf(ship);
  if (index !== -1) {
    list.splice(index, 1);
  }
  if (list.length === 0) {
    occupied.delete(key);
  }
}

function canEnterStack(hex, ship, occupied) {
  const key = hex.join(',');
  if (key === ship.hex.join(',')) {
    return true;
  }
  const list = occupied.get(key) || [];
  if (list.length === 0) {
    return true;
  }
  if (list.some((candidate) => candidate.side !== ship.side)) {
    return false;
  }
  return list.length < 2;
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
    stackIndex: 0,
    stackTotal: 1,
    lastPath: null,
    side,
    hex: side === 0 ? [2 - index, 0] : [-2 + index, 0],
    facing: side === 0 ? 0 : 3,
    speed: 2,
    maxSpeed: stats.speeds[0],
    hp: stats.maxHp,
    maxHp: stats.maxHp,
    status: 'intact',
    ...DEFAULT_COMBAT,
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
          stackIndex: 0,
          stackTotal: 1,
          lastPath: null,
          side,
          hex: [q, r],
          facing,
          speed,
          maxSpeed: stats.speeds[0],
          hp: stats.maxHp,
          maxHp: stats.maxHp,
          status: 'intact',
          attackRange: numOr(stats.attackRange, DEFAULT_COMBAT.attackRange),
          attackPower: numOr(stats.attackPower, DEFAULT_COMBAT.attackPower),
          mainAmmo: numOr(stats.mainAmmo, DEFAULT_COMBAT.mainAmmo),
          forwardFire: numOr(stats.forwardFire, DEFAULT_COMBAT.forwardFire),
          sideFire: numOr(stats.sideFire, DEFAULT_COMBAT.sideFire),
          backwardFire: numOr(stats.backwardFire, DEFAULT_COMBAT.backwardFire),
          gunCaliber: numOr(stats.gunCaliber, DEFAULT_COMBAT.gunCaliber),
          secondaryForwardFire: numOr(stats.secondaryForwardFire, DEFAULT_COMBAT.secondaryForwardFire),
          secondarySideFire: numOr(stats.secondarySideFire, DEFAULT_COMBAT.secondarySideFire),
          secondaryBackwardFire: numOr(stats.secondaryBackwardFire, DEFAULT_COMBAT.secondaryBackwardFire),
          secondaryGunCaliber: numOr(stats.secondaryGunCaliber, DEFAULT_COMBAT.secondaryGunCaliber),
          secondaryAttackPower: numOr(stats.secondaryAttackPower, DEFAULT_COMBAT.secondaryAttackPower),
          armorClose: numOr(stats.armorClose, DEFAULT_COMBAT.armorClose),
          armorMedium: numOr(stats.armorMedium, DEFAULT_COMBAT.armorMedium),
          armorFar: numOr(stats.armorFar, DEFAULT_COMBAT.armorFar),
          radarType: stats.radarType || DEFAULT_COMBAT.radarType,
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
        attackRange: numOr(entry.attackRange, DEFAULT_COMBAT.attackRange),
        attackPower: numOr(entry.attackPower, DEFAULT_COMBAT.attackPower),
        mainAmmo: numOr(entry.mainAmmo, DEFAULT_COMBAT.mainAmmo),
        forwardFire: numOr(entry.forwardFire, DEFAULT_COMBAT.forwardFire),
        sideFire: numOr(entry.sideFire, DEFAULT_COMBAT.sideFire),
        backwardFire: numOr(entry.backwardFire, DEFAULT_COMBAT.backwardFire),
        gunCaliber: numOr(entry.gunCaliber, DEFAULT_COMBAT.gunCaliber),
        secondaryForwardFire: numOr(entry.secondaryForwardFire, DEFAULT_COMBAT.secondaryForwardFire),
        secondarySideFire: numOr(entry.secondarySideFire, DEFAULT_COMBAT.secondarySideFire),
        secondaryBackwardFire: numOr(entry.secondaryBackwardFire, DEFAULT_COMBAT.secondaryBackwardFire),
        secondaryGunCaliber: numOr(entry.secondaryGunCaliber, DEFAULT_COMBAT.secondaryGunCaliber),
        secondaryAttackPower: numOr(entry.secondaryAttackPower, DEFAULT_COMBAT.secondaryAttackPower),
        armorClose: numOr(entry.armorClose, DEFAULT_COMBAT.armorClose),
        armorMedium: numOr(entry.armorMedium, DEFAULT_COMBAT.armorMedium),
        armorFar: numOr(entry.armorFar, DEFAULT_COMBAT.armorFar),
        radarType: entry.radarType || DEFAULT_COMBAT.radarType,
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

function applyDeferredSpeedCaps(state) {
  for (const ship of state.ships) {
    if (ship.hp <= 0) {
      continue;
    }
    const cap = maxSpeedForState(ship);
    if (ship.speed > cap) {
      const old = ship.speed;
      ship.speed = cap;
      state.eventLog.push({
        at: new Date().toISOString(),
        message: `${ship.name} 因损伤强制降速 ${old} → ${cap}`,
      });
    }
  }
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

function computeStacking(state) {
  const groups = new Map();
  for (const ship of state.ships) {
    const key = `${ship.side}:${ship.hex.join(',')}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(ship);
  }
  for (const group of groups.values()) {
    group.forEach((ship, index) => {
      ship.stackIndex = index;
      ship.stackTotal = group.length;
    });
  }
}

function createState(battle, db) {
  const rollFirst = randomInt(1, 101);
  const rollSecond = randomInt(1, 101);
  const config = loadMapConfig(db, battle.roomId);
  const initiativeOwner = String(config.InitiativeOwner || '').toLowerCase();
  const first = initiativeOwner === 'enemy'
    ? battle.players[1]
    : initiativeOwner === 'player'
      ? battle.players[0]
      : rollFirst >= rollSecond ? battle.players[0] : battle.players[1];
  const second = battle.players.find((playerId) => playerId !== first);
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
    timerStartAt: 0,
    timerEndAt: 0,
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
    terrain: config.Terrain || {},
    trails: [],
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

  function markRoomFinished(state) {
    db.prepare("UPDATE rooms SET status = 'finished' WHERE id = ?").run(state.roomId);
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
    computeStacking(state);
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
      timerStartAt: state.timerStartAt,
      timerEndAt: state.timerEndAt,
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
    if (state.status === 'finished') {
      markRoomFinished(state);
    }
    computeStacking(state);
    computeFormations(state);
    state.commands = Object.fromEntries(state.players.map((playerId) => [playerId, null]));
    const settledPhase = state.phase;

    if (settledPhase === 'gunnery') {
      applyDeferredSpeedCaps(state);
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
          markRoomFinished(state);
          if (state.playerScore > state.enemyScore) {
            state.winner = state.players[0];
          } else if (state.enemyScore > state.playerScore) {
            state.winner = state.players[1];
          } else {
            state.winner = null;
          }
          state.eventLog.push({
            at: new Date().toISOString(),
            message: state.winner
              ? `回合上限到达，${state.winner} 以 PV 获胜`
              : '回合上限到达，双方 PV 平局',
          });
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
    const oldHex = new Map(state.ships.map((ship) => [ship.id, [...ship.hex]]));
    const phaseNum = state.phase === 'move1' ? 1 : state.phase === 'move2' ? 2 : 3;
    const oddTurn = state.turn % 2 === 1;
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
          if (delta !== 0) {
            if (!consumeSideCP(state, ship.side, 1)) {
              state.eventLog.push({
                at: new Date().toISOString(),
                message: `${ship.name} 航速调整被拒绝（CP 不足）`,
              });
            } else {
              ship.speed = clamp(ship.speed + delta, 0, maxSpeedForState(ship));
            }
          }
          continue;
        }

        if (state.phase.startsWith('move')) {
          let facing = ship.facing;
          if (action === 'turn_left') {
            if (consumeSideCP(state, ship.side, 1)) {
              facing = (facing + 5) % 6;
            } else {
              state.eventLog.push({
                at: new Date().toISOString(),
                message: `${ship.name} 左转被拒绝（CP 不足）`,
              });
            }
          } else if (action === 'turn_right') {
            if (consumeSideCP(state, ship.side, 1)) {
              facing = (facing + 1) % 6;
            } else {
              state.eventLog.push({
                at: new Date().toISOString(),
                message: `${ship.name} 右转被拒绝（CP 不足）`,
              });
            }
          }
          const steps = moveForPhase(ship.speed, phaseNum, oddTurn);
          const vector = FACING_VECTORS[facing];
          const path = [[ship.hex[0], ship.hex[1]]];
          for (let step = 0; step < steps; step++) {
            const last = path[path.length - 1];
            path.push([last[0] + vector[0], last[1] + vector[1]]);
          }
          moves.push({
            ship,
            facing,
            target: path[path.length - 1],
            path,
          });
          continue;
        }

        if (state.phase === 'gunnery' && action === 'fire') {
          const targetId = entry.detail && entry.detail.targetShipId;
          const target = state.ships.find((candidate) => candidate.id === targetId);
          if (target && target.side !== ship.side) {
            if (stateCoeff(ship) <= 0) {
              state.eventLog.push({
                at: new Date().toISOString(),
                message: `${ship.name} 大破/沉没，无法射击`,
              });
            } else if (numOr(ship.mainAmmo, 0) <= 0) {
              state.eventLog.push({
                at: new Date().toISOString(),
                message: `${ship.name} 主炮弹药耗尽，无法射击`,
              });
            } else if (hexDistance(ship.hex, target.hex) > numOr(ship.attackRange, 4)) {
              state.eventLog.push({
                at: new Date().toISOString(),
                message: `${ship.name} 目标不在射程内，无法射击`,
              });
            } else {
              const cost = tierOf(ship) === 'large' ? 2 : 1;
              if (!consumeSideCP(state, ship.side, cost)) {
                state.eventLog.push({
                  at: new Date().toISOString(),
                  message: `${ship.name} 炮击被拒绝（CP 不足，需要 ${cost}）`,
                });
              } else {
                ship.mainAmmo = Math.max(0, numOr(ship.mainAmmo, 0) - 1);
                const radarUsed = Boolean(entry.detail && entry.detail.radarUsed);
                resolveGunnery(state, ship, target, radarUsed);
              }
            }
          }
        }
      }
    }

    const formationGroups = new Map();
    for (const move of moves) {
      const leadId = move.ship.formationLeadId;
      if (!leadId) {
        continue;
      }
      if (!formationGroups.has(leadId)) {
        formationGroups.set(leadId, []);
      }
      formationGroups.get(leadId).push(move);
    }
    for (const group of formationGroups.values()) {
      group.sort((a, b) => a.ship.formationIndex - b.ship.formationIndex);
      const leadMove = group[0];
      const leadId = leadMove.ship.formationLeadId;
      let trail = state.trails.find((entry) => entry.leadId === leadId);
      if (!trail) {
        trail = { leadId, cells: [], headings: [] };
        state.trails.push(trail);
      }
      if (trail.cells.length === 0 ||
        trail.cells[trail.cells.length - 1].join(',') !== leadMove.ship.hex.join(',')) {
        const ordered = group.map((move) => move.ship);
        trail.cells = ordered.map((ship) => [...ship.hex]).reverse();
        trail.headings = ordered.map((ship) => ship.facing).reverse();
      }
      for (let i = 0; i < trail.cells.length; i++) {
        if (trail.cells[i][0] === leadMove.ship.hex[0] &&
          trail.cells[i][1] === leadMove.ship.hex[1]) {
          trail.headings[i] = leadMove.facing;
        }
      }
      const leadSteps = leadMove.path.length - 1;
      for (let i = 0; i < leadSteps; i++) {
        const last = trail.cells[trail.cells.length - 1];
        const vector = FACING_VECTORS[leadMove.facing];
        trail.cells.push([last[0] + vector[0], last[1] + vector[1]]);
        trail.headings.push(leadMove.facing);
      }
      for (let k = 1; k < group.length; k++) {
        const follower = group[k];
        const old = oldHex.get(follower.ship.id);
        let index = -1;
        for (let i = trail.cells.length - 1; i >= 0; i--) {
          if (trail.cells[i][0] === old[0] && trail.cells[i][1] === old[1]) {
            index = i;
            break;
          }
        }
        if (index < 0) {
          follower.path = [[...old]];
          follower.target = [...old];
          continue;
        }
        const steps = Math.min(leadSteps, trail.cells.length - 1 - index);
        if (steps <= 0) {
          follower.path = [[...old]];
          follower.target = [...old];
          continue;
        }
        follower.path = trail.cells
          .slice(index + 1, index + 1 + steps)
          .map((hex) => [...hex]);
        follower.target = [...follower.path[follower.path.length - 1]];
        follower.facing = trail.headings[index + steps];
      }
    }

    if (state.phase.startsWith('move')) {
      const occupied = new Map();
      for (const ship of state.ships) {
        if (ship.hp > 0) {
          addOccupant(occupied, ship.hex, ship);
        }
      }
      for (const move of moves) {
        const ship = move.ship;
        if (ship.hp <= 0) {
          continue;
        }
        ship.facing = move.facing;
        const origin = [...ship.hex];
        const path = move.path && move.path.length > 1 ? move.path : [origin, move.target];
        let current = origin;
        let moved = 0;
        let blockedHex = null;
        let blockedBy = [];
        for (let step = 1; step < path.length; step++) {
          const next = path[step];
          if (isIsland(state.terrain || {}, next)) {
            removeOccupant(occupied, current, ship);
            applyShipDamage(state, ship, ship.hp);
            state.eventLog.push({
              at: new Date().toISOString(),
              message: `${ship.name} 撞击岛屿，直接沉没`,
            });
            break;
          }
          blockedBy = occupied.get(next.join(',')) || [];
          if (!canEnterStack(next, ship, occupied)) {
            blockedHex = next;
            break;
          }
          removeOccupant(occupied, current, ship);
          current = next;
          addOccupant(occupied, current, ship);
          moved++;
        }
        if (blockedHex) {
          if (blockedBy.length > 0 && randomInt(1, 11) <= 2) {
            const blocker = blockedBy[0];
            const hullSum = ship.maxHp + blocker.maxHp;
            const rollA = randomInt(1, 11);
            const rollB = randomInt(1, 11);
            const dmgA = collisionDamage(hullSum, rollA);
            const dmgB = collisionDamage(hullSum, rollB);
            state.eventLog.push({
              at: new Date().toISOString(),
              message: `${ship.name} 与 ${blocker.name} 发生冲撞！（${rollA}→${dmgA}，${rollB}→${dmgB}）`,
            });
            applyShipDamage(state, ship, dmgA);
            applyShipDamage(state, blocker, dmgB);
            if (blocker.hp <= 0) {
              removeOccupant(occupied, blockedHex, blocker);
            }
          } else {
            state.eventLog.push({
              at: new Date().toISOString(),
              message: `${ship.name} 前方受阻，仅推进 ${moved} 格`,
            });
          }
        }
        ship.hex = current;
        ship.lastPath = path.slice(0, moved + 1);
        if (ship.hp <= 0) {
          removeOccupant(occupied, current, ship);
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
      state.timerStartAt = 0;
      state.timerEndAt = 0;
      return;
    }
    const phaseIndex = PHASE_INDEX[state.phase];
    const perShip = Number(state.phaseSeconds[phaseIndex]) || 5;
    const side = state.players.indexOf(state.activePlayer);
    const count = state.ships.filter((ship) => ship.side === side && ship.hp > 0).length;
    const total = Math.max(1, perShip * count + (Number(state.phaseExtra) || 5));
    state.timerRemaining = total;
    state.timerTotal = total;
    state.timerStartAt = Date.now();
    state.timerEndAt = state.timerStartAt + total * 1000;
    const battleId = state.id;
    timers.set(battleId, {
      remaining: total,
      total,
      handle: setInterval(() => {
        const entry = timers.get(battleId);
        if (!entry) {
          return;
        }
        entry.remaining = Math.max(0, Math.round((state.timerEndAt - Date.now()) / 1000));
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
