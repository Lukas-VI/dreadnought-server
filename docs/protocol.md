# Dreadnought Server Protocol

All HTTP bodies and WebSocket frames are JSON.

## Authentication

Register or login to receive a token:

```json
POST /api/auth/register
{ "username": "admiral", "password": "secret1" }

200/201
{ "token": "<hex>", "user": { "id": "u_...", "username": "admiral", "credits": 1000 } }
```

Send the token as `Authorization: Bearer <token>` on authenticated HTTP requests.
New players start with 1000 credits.

## HTTP endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | Service health |
| POST | `/api/auth/register` | Create account and issue token |
| POST | `/api/auth/login` | Login and issue token |
| POST | `/api/auth/logout` | Invalidate token |
| GET | `/api/me` | Current player profile |
| GET | `/api/lobby/rooms` | List rooms |
| POST | `/api/lobby/create` | Create a room |
| POST | `/api/lobby/join` | Join a room by `roomId` |
| POST | `/api/lobby/leave` | Leave a room by `roomId`; empty rooms are deleted |
| GET | `/api/lobby/rooms/:id` | Get one room |
| POST | `/api/battle/start` | Start battle for a ready room |
| POST | `/api/battle/roll` | Authoritative roll in a battle |
| GET | `/api/battle/rolls` | Recent audited roll log |
| GET | `/api/gacha/pools` | Pull pools and published rates |
| POST | `/api/gacha/pull` | Authenticated pull with idempotency |
| GET | `/api/gacha/history` | Player pull history |

## WebSocket

Endpoint: `ws://<host>:3000/ws`

1. Connect, then authenticate immediately:

```json
{ "type": "auth", "token": "<hex>" }
```

2. Server confirms:

```json
{ "type": "auth.ok", "user": { "id": "u_...", "username": "admiral", "credits": 1000 } }
```

3. Subscribe to a room:

```json
{ "type": "lobby.join", "roomId": "room_..." }
```

The server replies with the current room and broadcasts updates to all
subscribers:

```json
{ "type": "room.state", "room": { "id": "room_...", "players": ["u_..."], "status": "ready" } }
{ "type": "room.updated", "room": { ... } }
```

4. Roll during a battle:

```json
{ "type": "battle.roll", "battleId": "battle_...", "count": 3, "sides": 100, "reason": "gunnery" }
```

The roll is authoritative on the server. Every subscriber in the battle room
receives:

```json
{ "type": "battle.rolled", "battleId": "battle_...", "roll": { "id": 1, "values": [42, 51, 50], "sides": 100 } }
```

Leave a room with `{ "type": "lobby.leave", "roomId": "room_..." }`.

## Battle state machine

Fetch the current authoritative state:

```json
{ "type": "battle.state.get", "battleId": "battle_..." }
```

Submit a command for the current phase:

```json
{ "type": "battle.command", "battleId": "battle_...", "action": "accelerate" }
{ "type": "battle.command", "battleId": "battle_...", "action": "fire", "detail": { "targetShipId": "e_0_..." } }
```

Phases and actions:

- `speed`: `accelerate`, `decelerate`, `wait`
- `move1` / `move2` / `move3`: `turn_left`, `turn_right`, `wait`
- `gunnery`: `fire` with a `targetShipId`, or `wait`

Force the phase forward when the opponent has not submitted yet:

```json
{ "type": "battle.advance", "battleId": "battle_..." }
```

Every state change is broadcast to the room as `battle.state` with the current
turn, phase, ship positions, HP, and pending command summary.

## Gacha

`POST /api/gacha/pull` requires an idempotency key so retries never double
charge:

```json
{ "pool": "naval", "count": 2, "idempotencyKey": "client-generated-key" }
```

Replaying the same key returns the stored result with `"replay": true`.
Published rates are available from `GET /api/gacha/pools`.
