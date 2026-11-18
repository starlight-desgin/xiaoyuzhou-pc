const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createBackend } = require('../lib/backend.cjs');

function service(saved, overrides = {}) {
  const values = structuredClone(saved);
  const store = { get: (key, fallback) => values[key] ?? fallback, set: (key, value) => { values[key] = value; } };
  return createBackend({ store, publish() {}, ...overrides });
}

test('desktop settings preserve existing folders and an explicitly cleared audio directory', async () => {
  const custom = 'F:\\收听笔记';
  const client = service({ extensionLocal: { xyzSettings: { audioDownloadPath: '', summaryDownloadPath: custom } } });
  const settings = await client.request({ type: 'get-settings' });
  assert.equal(settings.audioDownloadPath, '');
  assert.equal(settings.summaryDownloadPath, custom);
  assert.equal(path.basename(settings.transcriptDownloadPath), '小宇宙转写稿');
  assert.ok(settings.summaryModels.length > 0);
});

test('desktop helper diagnostics report the bundled executable and failure reason', async () => {
  const nativeHostPath = 'C:\\App\\resources\\native\\xyz-helper.exe';
  const ready = service({}, { nativeHostPath, nativeRequest: async message => {
    assert.equal(message.action, 'ping');
    return { version: 'test', qwenConfigured: false };
  } });
  const status = await ready.request({ type: 'get-native-host-status' });
  assert.equal(status.hostPath, nativeHostPath);
  assert.equal(status.available, true);
  assert.equal(status.version, 'test');
  const missing = service({}, { nativeHostPath, nativeRequest: async () => { throw Error('助手缺失'); } });
  const failure = await missing.request({ type: 'get-native-host-status' });
  assert.equal(failure.available, false);
  assert.equal(failure.error, '助手缺失');
});
