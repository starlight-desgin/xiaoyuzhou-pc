const test = require('node:test');
const assert = require('node:assert/strict');
const { UpdateChecker } = require('../lib/updates.cjs');
function setup() {
  const data = {};
  const state = { uid: 'user1', episodes: [{ eid: 'old', pubDate: '2026-11-15T00:00:00Z' }], sent: [], fail: false };
  const checker = new UpdateChecker({
    store: { get: (k, d) => data[k] ?? d, set: (k, v) => { data[k] = structuredClone(v); } },
    request: async m => {
      if (m.type === 'get-auth') return state.uid ? { accessToken: 'fake', user: { uid: state.uid } } : null;
      if (m.payload.endpoint === '/subscription') return { data: [{ type: 'PODCAST', pid: 'p1', title: '播客' }] };
      if (state.fail) throw new Error('network');
      return { data: state.episodes };
    },
    notify: async episodes => { state.sent.push(...episodes); },
    now: () => 12345
  });
  return { checker, state, data };
}
test('first poll establishes baseline without old episode notifications', async () => {
  const { checker, state } = setup(); await checker.check(); assert.equal(state.sent.length, 0);
  assert.equal(checker.status.lastChecked, 12345);
});
test('new episodes notify once, including after checker recreation', async () => {
  const { checker, state } = setup(); await checker.check();
  state.episodes.unshift({ eid: 'new', title: '新单集', pubDate: '2026-11-17T00:00:00Z' });
  await checker.check(); await checker.check();
  assert.deepEqual(state.sent.map(e => e.eid), ['new']);
});
test('episodes with an embedded podcast keep their own id and title', async () => {
  const { checker, state } = setup();
  await checker.check();
  state.episodes.unshift({ eid: 'new', title: '新一集', podcast: { pid: 'p1', title: '播客' }, pubDate: '2026-11-17T00:00:00Z' });
  await checker.check();
  assert.equal(state.sent[0].eid, 'new');
  assert.equal(state.sent[0].podcast.pid, 'p1');
});
test('repair an empty v1 baseline without announcing old publications', async () => {
  const { checker, state, data } = setup();
  data.notificationFeeds = { user1: { p1: { seen: [], latest: 0 } } };
  await checker.check();
  assert.equal(state.sent.length, 0);
  assert.deepEqual(data.notificationFeeds.user1.p1.seen, ['old']);
});
test('a genuinely empty subscription still notifies for its first episode', async () => {
  const { checker, state } = setup();
  state.episodes = []; await checker.check();
  state.episodes.push({ eid: 'first', pubDate: '2026-11-17T00:00:00Z' });
  await checker.check();
  assert.deepEqual(state.sent.map(item => item.eid), ['first']);
});
test('failed podcast request cannot lose a new episode', async () => {
  const { checker, state } = setup(); await checker.check(); state.fail = true;
  await checker.check(); state.fail = false;
  state.episodes.unshift({ eid: 'new', pubDate: '2026-11-17T00:00:00Z' });
  await checker.check(); assert.equal(state.sent.length, 1);
});
test('account changes establish independent baselines', async () => {
  const { checker, state } = setup(); await checker.check();
  state.uid = 'user2'; state.episodes = [{ eid: 'other', pubDate: '2026-11-17T00:00:00Z' }];
  await checker.check(); assert.equal(state.sent.length, 0);
});
test('logged out checker reports required login without API calls', async () => {
  const { checker, state } = setup(); state.uid = null; await checker.check();
  assert.match(checker.status.error, /登录/); assert.equal(state.sent.length, 0);
});
test('older newly appearing episodes do not trigger stale notifications', async () => {
  const { checker, state } = setup(); await checker.check();
  state.episodes.push({ eid: 'ancient', pubDate: '2020-01-01T00:00:00Z' });
  await checker.check(); assert.equal(state.sent.length, 0);
});
test('notification failure preserves baseline for retry', async () => {
  const { checker, state } = setup(); await checker.check();
  state.episodes.unshift({ eid: 'new', pubDate: '2026-11-17T00:00:00Z' });
  const notify = checker.notify; checker.notify = async () => { throw new Error('notification failed'); };
  await checker.check(); checker.notify = notify; await checker.check();
  assert.deepEqual(state.sent.map(e => e.eid), ['new']);
});
