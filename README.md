# Dreadnought Server

Node.js backend for Dreadnought Departure PvP. A single process hosts the
account, lobby, and battle services so deployment and development stay simple.

## Layout

- `src/server.js` - HTTP entry point and service wiring
- `src/account.js` - authentication, player data, and future gacha ledger
- `src/lobby.js` - room creation, joining, and readiness
- `src/battle.js` - authoritative battle state, roll audit, and sync

## Development

```bash
npm start
```

Health check:

```bash
curl http://localhost:3000/health
```

## Deployment

The VM at `192.168.31.135` runs the server with PM2 under the name
`dreadnought-server`.
