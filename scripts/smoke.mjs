const base = process.env.BASE_URL || 'http://127.0.0.1:3000';

async function request(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status} ${text}`);
  }
  return payload;
}

const suffix = Date.now().toString(36);
const a = await request('/api/auth/register', {
  method: 'POST',
  body: { username: `smoke_a_${suffix}`, password: 'secret1' },
});
const b = await request('/api/auth/register', {
  method: 'POST',
  body: { username: `smoke_b_${suffix}`, password: 'secret2' },
});
const room = await request('/api/lobby/create', {
  method: 'POST',
  token: a.token,
});
const joined = await request('/api/lobby/join', {
  method: 'POST',
  token: b.token,
  body: { roomId: room.id },
});
const battle = await request('/api/battle/start', {
  method: 'POST',
  token: a.token,
  body: { roomId: room.id },
});
const roll = await request('/api/battle/roll', {
  method: 'POST',
  token: a.token,
  body: { count: 3, sides: 100, reason: 'smoke' },
});
const rolls = await request('/api/battle/rolls', { token: a.token });

console.log(
  JSON.stringify(
    {
      room: joined,
      battle,
      roll,
      rollLogLength: rolls.rolls.length,
    },
    null,
    2,
  ),
);
