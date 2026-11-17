const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

// Keep the extension's API and settings contracts while replacing browser-only APIs.
function createBackend({ store, fetch, publish, nativeRequest, download, officialLogin, cookies, clearOfficialLogin, showWindow, rendererDir }) {
  const local = store.get('extensionLocal', {});
  // Desktop files use actual OS directories instead of a browser download folder.
  if (!local.xyzSettings) local.xyzSettings = {};
  for (const [key, folder] of [['audioDownloadPath', '小宇宙音频'], ['transcriptDownloadPath', '小宇宙转写稿'], ['summaryDownloadPath', '小宇宙转写稿']]) {
    if (!local.xyzSettings[key]) local.xyzSettings[key] = path.join(require('node:os').homedir(), 'Downloads', folder);
  }
  const session = { ...store.get('extensionSession', {}) };
  delete session.desktopWindowId;
  let messageListener;
  const storage = (areaName, values) => ({
    async get(keys) {
      if (keys == null) return { ...values };
      if (typeof keys === 'string') return { [keys]: values[keys] };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map(k => [k, values[k]]));
      return Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, values[k] ?? v]));
    },
    async set(next) {
      const changes = {};
      for (const [key, value] of Object.entries(next)) {
        changes[key] = { oldValue: values[key], newValue: value };
        values[key] = value;
      }
      store.set(areaName === 'local' ? 'extensionLocal' : 'extensionSession', values);
      publish({ changes, areaName });
    },
    async remove(keys) {
      const changes = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (key in values) { changes[key] = { oldValue: values[key] }; delete values[key]; }
      }
      store.set(areaName === 'local' ? 'extensionLocal' : 'extensionSession', values);
      publish({ changes, areaName });
    }
  });
  const noopEvent = { addListener() {} };
  const runtime = {
    id: 'jgcegnegoifbcokpipkogolkmodkcceb',
    lastError: null,
    getURL: file => `xyz://app/${file}`,
    onInstalled: noopEvent,
    onStartup: noopEvent,
    onMessage: { addListener(listener) { messageListener = listener; } },
    sendNativeMessage(_host, message, callback) {
      nativeRequest(message).then(data => callback({ ok: true, data })).catch(error => callback({ ok: false, error: error.message }));
    }
  };
  const chrome = {
    runtime, action: { onClicked: noopEvent },
    storage: { local: storage('local', local), session: storage('session', session) },
    windows: {
      async get() { throw new Error('窗口未打开'); },
      async create(options) { if (options.url.startsWith('xyz:')) showWindow(); else await officialLogin(options.url); return { id: 1 }; },
      async update() { showWindow(); },
      onBoundsChanged: noopEvent, onRemoved: noopEvent
    },
    cookies: { getAll: cookies, clearOfficialLogin },
    downloads: { download }
  };
  const context = vm.createContext({
    chrome, console, navigator: { userAgent: 'Xiaoyuzhou Desktop Windows' },
    crypto: webcrypto, fetch, URL, URLSearchParams, setTimeout, clearTimeout, AbortController,
    structuredClone, TextEncoder, TextDecoder
  });
  const source = fs.readFileSync(path.join(rendererDir, 'background.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'background.js' });
  return {
    request(message) {
      return new Promise((resolve, reject) => {
        messageListener(message, {}, response => {
          if (response?.ok) resolve(response.data);
          else reject(new Error(response?.error || '请求失败'));
        });
      });
    }
  };
}
module.exports = { createBackend };
