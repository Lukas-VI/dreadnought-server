# Dreadnought Server

Node.js backend for Dreadnought Departure PvP. A single process hosts the
account, lobby, and battle services so deployment and development stay simple.

## Layout

- `src/server.js` - HTTP entry point and service wiring
- `src/db.js` - SQLite schema and connection
- `src/account.js` - registration, login, sessions, and player profile
- `src/lobby.js` - room creation, joining, and readiness
- `src/battle.js` - authoritative battle state and audited dice rolls
- `src/gacha.js` - authenticated pulls with idempotency and rate data
- `src/realtime.js` - WebSocket hub for room and battle broadcasts

## Development

```bash
npm start
```

Health check:

```bash
curl http://localhost:3000/health
```

Smoke test (HTTP + WebSocket + gacha):

```bash
npm run smoke
```

The WebSocket endpoint is `ws://<host>:3000/ws`. Clients authenticate with a
first `auth` message, then subscribe with `lobby.join`. Authoritative rolls are
sent as `battle.roll` and broadcast to every subscriber in the battle room.

## API

- `POST /api/auth/register` and `POST /api/auth/login`
- `GET /api/me`
- `POST /api/lobby/create`, `POST /api/lobby/join`, `GET /api/lobby/rooms`
- `POST /api/battle/start`, `POST /api/battle/roll`
- `GET /api/gacha/pools`, `POST /api/gacha/pull`, `GET /api/gacha/history`

## Deployment

The VM at `192.168.31.135` runs the server with PM2 under the name
`dreadnought-server`.
