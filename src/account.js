import { createHash, randomBytes } from 'node:crypto';

import { httpError } from './httpError.js';

function hashPassword(password) {
  // Placeholder until persistent storage adds a proper KDF.
  return createHash('sha256').update(password).digest('hex');
}

export function createAccountService() {
  const users = new Map();
  const sessions = new Map();

  function issueSession(user) {
    const token = randomBytes(24).toString('hex');
    sessions.set(token, user.id);
    return {
      token,
      user: { id: user.id, username: user.username },
    };
  }

  return {
    register({ username, password }) {
      if (typeof username !== 'string' || username.length < 3) {
        throw httpError(400, 'invalid_username');
      }
      if (typeof password !== 'string' || password.length < 6) {
        throw httpError(400, 'weak_password');
      }
      if (users.has(username)) {
        throw httpError(409, 'username_taken');
      }
      const user = {
        id: `u_${randomBytes(6).toString('hex')}`,
        username,
        passwordHash: hashPassword(password),
        createdAt: new Date().toISOString(),
      };
      users.set(username, user);
      return issueSession(user);
    },

    login({ username, password }) {
      const user = users.get(username);
      if (!user || user.passwordHash !== hashPassword(password)) {
        throw httpError(401, 'bad_credentials');
      }
      return issueSession(user);
    },

    resolveToken(token) {
      if (!token) {
        throw httpError(401, 'missing_token');
      }
      const userId = sessions.get(token);
      if (!userId) {
        throw httpError(401, 'invalid_token');
      }
      return userId;
    },
  };
}
