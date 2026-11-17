const test = require('node:test');
const assert = require('node:assert/strict');
const { ListeningHistory, compactEpisode } = require('../lib/listening-history.cjs');

function memoryStore() {
  const data = {};
  return { get: (key, fallback) => structuredClone(data[key] ?? fallback),
    set: (key, value) => { data[key] = structuredClone(value); } };
}
function snapshot(eid, currentTime, ended = false) {
  return { episode: { eid, title: eid, imageUrl: 'episode-image',
    podcast: { pid: 'p', image: { picUrl: 'original-program-image' } }, audioUrl: 'stream' },
    currentTime, duration: 120, ended, rate: 1.5 };
}
test('records are per account, preserve original covers and reopen at the last chosen position', () => {
  const store = memoryStore();
  const history = new ListeningHistory(store);
  history.record('one', snapshot('a', 90));
  history.record('one', snapshot('b', 40));
  history.record('one', snapshot('a', 15), true);
  history.record('two', snapshot('a', 70), true);
  const reopened = new ListeningHistory(store);
  assert.deepEqual(reopened.list('one').map(row => row.episode.eid), ['a', 'b']);
  assert.equal(reopened.find('one', 'a').episode.imageUrl, 'original-program-image');
  assert.equal(reopened.find('one', 'a').currentTime, 15);
  assert.equal(reopened.find('two', 'a').currentTime, 70);
  assert.equal(reopened.find('one', 'a').rate, 1.5);
  assert.deepEqual(reopened.list(''), []);
});
test('completed episodes can be replayed and become unfinished again', () => {
  const h = new ListeningHistory(memoryStore());
  h.record('one', snapshot('a', 121, true), true);
  assert.equal(h.find('one', 'a').completed, true);
  assert.equal(h.find('one', 'a').currentTime, 120);
  h.record('one', snapshot('a', 2));
  assert.equal(h.find('one', 'a').completed, false);
});
test('legacy checkpoint migrates once, and an existing newer listen wins', () => {
  const store = memoryStore();
  const h = new ListeningHistory(store);
  const legacy = snapshot('v1', 44);
  h.importPrevious('', legacy);
  h.importPrevious('one', legacy);
  h.record('one', snapshot('v1', 88), true);
  const reconnect = new ListeningHistory(store);
  reconnect.importPrevious('one', legacy); reconnect.importPrevious('two', legacy);
  assert.equal(reconnect.find('one', 'v1').currentTime, 88);
  assert.deepEqual(reconnect.list('two'), []);
  assert.equal(compactEpisode({ type: 'PODCAST', pid: 'p' }), null);
});
