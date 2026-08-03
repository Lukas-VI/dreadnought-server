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
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(`${method} ${path} -> ${response.status} ${text}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

const adminEmail = process.env.ADMIN_EMAIL;
const adminPassword = process.env.ADMIN_PASSWORD;
if (!adminEmail || !adminPassword) {
  throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD required');
}

const suffix = Date.now().toString(36);
const admin = await request('/api/auth/login', {
  method: 'POST',
  body: { email: adminEmail, password: adminPassword },
});
if (admin.user.role !== 'admin') {
  throw new Error('admin role missing');
}

const normal = await request('/api/auth/register', {
  method: 'POST',
  body: {
    email: `admin_test_${suffix}@test.local`,
    username: `admin_test_${suffix}`,
    password: 'secret1',
  },
});

let forbidden = false;
try {
  await request('/api/admin/overview', { token: normal.token });
} catch (err) {
  forbidden = err.status === 403 && err.payload.error === 'admin_required';
}
if (!forbidden) {
  throw new Error('non-admin access not rejected');
}

const overview = await request('/api/admin/overview', { token: admin.token });
if (typeof overview.stats.users !== 'number') {
  throw new Error('admin overview missing stats');
}

const users = await request('/api/admin/users?search=admin_test', { token: admin.token });
const target = users.users.find((user) => user.id === normal.user.id);
if (!target) {
  throw new Error('admin user list missing registered user');
}

await request(`/api/admin/users/${normal.user.id}/credits`, {
  method: 'POST',
  token: admin.token,
  body: { credits: 1234 },
});
const afterCredits = await request('/api/admin/users?search=admin_test', { token: admin.token });
if (afterCredits.users[0].credits !== 1234) {
  throw new Error('credit update failed');
}

await request(`/api/admin/users/${normal.user.id}/ban`, {
  method: 'POST',
  token: admin.token,
});
let bannedRejected = false;
try {
  await request('/api/me', { token: normal.token });
} catch (err) {
  bannedRejected = err.payload.error === 'account_banned';
}
if (!bannedRejected) {
  throw new Error('banned user still authenticated');
}

await request(`/api/admin/users/${normal.user.id}/unban`, {
  method: 'POST',
  token: admin.token,
});
const me = await request('/api/me', { token: normal.token });
if (me.id !== normal.user.id) {
  throw new Error('unban failed');
}

const room = await request('/api/lobby/create', {
  method: 'POST',
  token: normal.token,
});
const rooms = await request('/api/admin/rooms', { token: admin.token });
if (!rooms.rooms.some((entry) => entry.id === room.id)) {
  throw new Error('admin room list missing room');
}
await request(`/api/admin/rooms/${room.id}/close`, {
  method: 'POST',
  token: admin.token,
});

const sessions = await request('/api/admin/sessions', { token: admin.token });
const normalSession = sessions.sessions.find((entry) => entry.user_id === normal.user.id);
if (!normalSession) {
  throw new Error('admin session list missing session');
}
await request('/api/admin/sessions/revoke', {
  method: 'POST',
  token: admin.token,
  body: { token: normal.token },
});
let revoked = false;
try {
  await request('/api/me', { token: normal.token });
} catch (err) {
  revoked = err.payload.error === 'invalid_token';
}
if (!revoked) {
  throw new Error('session revoke failed');
}

console.log(JSON.stringify({
  adminLogin: 'ok',
  roleGuard: 'ok',
  overview: 'ok',
  credits: 'ok',
  banUnban: 'ok',
  rooms: 'ok',
  sessions: 'ok',
}, null, 2));
