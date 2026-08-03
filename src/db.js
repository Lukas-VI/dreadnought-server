import { mkdirSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  credits INTEGER NOT NULL DEFAULT 1000,
  role TEXT NOT NULL DEFAULT 'user',
  banned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'waiting',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS room_players (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  player_id TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (room_id, player_id)
);

CREATE TABLE IF NOT EXISTS battles (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  players_json TEXT NOT NULL,
  turn INTEGER NOT NULL DEFAULT 0,
  phase TEXT NOT NULL DEFAULT 'setup',
  status TEXT NOT NULL DEFAULT 'active',
  started_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rolls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  count INTEGER NOT NULL,
  sides INTEGER NOT NULL,
  values_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gacha_pulls (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  pool TEXT NOT NULL,
  count INTEGER NOT NULL,
  cost INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
`;

export function createDatabase(dbPath = process.env.DATABASE_PATH || 'data/dreadnought.db') {
  mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  const userColumns = db.prepare('PRAGMA table_info(users)').all();
  if (!userColumns.some((column) => column.name === 'email')) {
    db.exec('ALTER TABLE users ADD COLUMN email TEXT');
    db.prepare(
      "UPDATE users SET email = lower(username) || '@local.test' WHERE email IS NULL OR email = ''",
    ).run();
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)');
  }
  if (!userColumns.some((column) => column.name === 'role')) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
  }
  if (!userColumns.some((column) => column.name === 'banned')) {
    db.exec('ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0');
  }
  const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all();
  if (!sessionColumns.some((column) => column.name === 'last_seen_at')) {
    db.exec('ALTER TABLE sessions ADD COLUMN last_seen_at TEXT');
  }
  const battleColumns = db.prepare('PRAGMA table_info(battles)').all();
  if (!battleColumns.some((column) => column.name === 'state_json')) {
    db.exec('ALTER TABLE battles ADD COLUMN state_json TEXT');
  }
  const roomColumns = db.prepare('PRAGMA table_info(rooms)').all();
  if (!roomColumns.some((column) => column.name === 'map_json')) {
    db.exec('ALTER TABLE rooms ADD COLUMN map_json TEXT');
  }
  if (!roomColumns.some((column) => column.name === 'ship_data_json')) {
    db.exec('ALTER TABLE rooms ADD COLUMN ship_data_json TEXT');
  }
  return db;
}
