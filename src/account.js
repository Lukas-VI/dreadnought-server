import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import { httpError } from './httpError.js';

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) {
    return false;
  }
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, 32);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    credits: user.credits,
    createdAt: user.created_at,
  };
}

export function createAccountService({ db }) {
  const insertUser = db.prepare(
    'INSERT INTO users (id, username, password_hash, credits, created_at) VALUES (?, ?, ?, 1000, ?)',
  );
  const selectUserByUsername = db.prepare('SELECT * FROM users WHERE username = ?');
  const selectUserById = db.prepare('SELECT * FROM users WHERE id = ?');
  const insertSession = db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)');
  const selectSession = db.prepare('SELECT * FROM sessions WHERE token = ?');
  const deleteSession = db.prepare('DELETE FROM sessions WHERE token = ?');

  function resolveToken(token) {
    if (!token) {
      throw httpError(401, 'missing_token');
    }
    const session = selectSession.get(token);
    if (!session) {
      throw httpError(401, 'invalid_token');
    }
    const user = selectUserById.get(session.user_id);
    if (!user) {
      throw httpError(401, 'invalid_token');
    }
    return user;
  }

  function issueSession(user) {
    const token = randomBytes(24).toString('hex');
    insertSession.run(token, user.id, new Date().toISOString());
    return { token, user: publicUser(user) };
  }

  return {
    register({ username, password }) {
      if (typeof username !== 'string' || username.length < 3) {
        throw httpError(400, 'invalid_username');
      }
      if (typeof password !== 'string' || password.length < 6) {
        throw httpError(400, 'weak_password');
      }
      const user = {
        id: `u_${randomBytes(6).toString('hex')}`,
        username,
        passwordHash: hashPassword(password),
        credits: 1000,
        createdAt: new Date().toISOString(),
      };
      try {
        insertUser.run(user.id, user.username, user.passwordHash, user.createdAt);
      } catch (err) {
        if (String(err.code || '').includes('UNIQUE')) {
          throw httpError(409, 'username_taken');
        }
        throw err;
      }
      return issueSession(user);
    },

    login({ username, password }) {
      const user = selectUserByUsername.get(username);
      if (!user || !verifyPassword(password, user.password_hash)) {
        throw httpError(401, 'bad_credentials');
      }
      return issueSession(user);
    },

    logout(token) {
      if (!token) {
        throw httpError(401, 'missing_token');
      }
      deleteSession.run(token);
      return { ok: true };
    },

    resolveToken,

    getUser(token) {
      return publicUser(resolveToken(token));
    },

    getUserById(userId) {
      const user = selectUserById.get(userId);
      if (!user) {
        throw httpError(404, 'user_not_found');
      }
      return publicUser(user);
    },
  };
}
