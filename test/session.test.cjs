const test = require('node:test');
const assert = require('node:assert/strict');
const { createBackend } = require('../lib/backend.cjs');

const session = { user: { uid: 'listener' }, deviceId: 'test-device', accessToken: 'old-test', refreshToken: 'refresh-test' };
const api = { type: 'api', payload: { endpoint: '/subscription' } };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
function setup(initial, fetch) {
  const values = { extensionSession: initial ? { xyzAuthSession: initial } : {} };
  const simulatedCookies = [{ name: 'x-jike-access-token', value: 'cookie-test' },
    { name: 'x-jike-refresh-token', value: 'cookie-refresh-test' }];
  let reads = 0;
  const create = () => createBackend({
    publish() {},
    store: { get: (k, fallback) => structuredClone(values[k] ?? fallback),
      set: (k, v) => { values[k] = structuredClone(v); } },
    cookies: async () => { reads++; return simulatedCookies; },
    clearOfficialLogin: async () => { simulatedCookies.length = 0; }, fetch
  });
  return { create, reads: () => reads, values };
}

test('a restart restores the saved account even with a v1 idle expiry', async () => {
  const s = setup({ ...session, expiresAt: 1 }, async () => { throw Error('offline'); });
  assert.equal((await s.create().request({ type: 'restore-auth' })).user.uid, 'listener');
  assert.equal((await s.create().request({ type: 'restore-auth' })).user.uid, 'listener');
  assert.equal(s.reads(), 0);
});
test('existing official sign-in is adopted automatically and explicit logout persists', async () => {
  let profileReads = 0;
  const s = setup(null, async url => {
    assert.equal(new URL(url).pathname, '/v1/profile/get');
    profileReads++;
    return json({ data: { user: { uid: 'listener' } } });
  });
  const app = s.create();
  const [a, b] = await Promise.all([app.request({ type: 'restore-auth' }), app.request({ type: 'restore-auth' })]);
  assert.equal(a.user.uid, b.user.uid);
  assert.equal(profileReads, 1);
  assert.equal((await s.create().request({ type: 'restore-auth' })).user.uid, 'listener');
  await app.request({ type: 'logout' });
  assert.equal(await s.create().request({ type: 'restore-auth' }), null);
  assert.equal(s.reads(), 1);
});
test('concurrent expired requests share one renewal and the replacement survives restart', async () => {
  let refreshed = 0;
  const s = setup(session, async (url, init) => {
    if (new URL(url).pathname === '/app_auth_tokens.refresh') {
      refreshed++;
      await new Promise(resolve => setImmediate(resolve));
      return json({ 'x-jike-access-token': 'new-test', 'x-jike-refresh-token': 'next-test' });
    }
    return init.headers['x-jike-access-token'] === 'new-test' ? json({ data: [] }) : json({}, 401);
  });
  const client = s.create();
  await Promise.all([client.request(api), client.request(api)]);
  const cached = await s.create().request({ type: 'restore-auth' });
  assert.equal(cached.accessToken, 'new-test');
  assert.equal(cached.refreshToken, 'next-test');
  assert.equal(refreshed, 1);
});
test('temporary server and network failures preserve the local session', async () => {
  for (const status of [500, 503, 0]) {
    const s = setup(session, async url => {
      if (new URL(url).pathname !== '/app_auth_tokens.refresh') return json({}, 401);
      if (!status) throw Error('offline');
      return json({}, status);
    });
    await assert.rejects(s.create().request(api));
    assert.equal((await s.create().request({ type: 'restore-auth' })).user.uid, 'listener');
  }
});
test('an officially rejected refresh requires login and cannot revive the old cookie pair', async () => {
  const s = setup(session, async () => json({}, 401));
  await assert.rejects(s.create().request(api), /登录已失效/);
  assert.equal(await s.create().request({ type: 'restore-auth' }), null);
  assert.equal(s.reads(), 0);
});
