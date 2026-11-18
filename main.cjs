const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage, protocol, net,
  session, shell, dialog, safeStorage, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { Store } = require('./lib/store.cjs');
const { createBackend } = require('./lib/backend.cjs');
const { UpdateChecker } = require('./lib/updates.cjs');
const { ListeningHistory, ownerOf } = require('./lib/listening-history.cjs');

const APP_ID = 'Xiaoyuzhou.Desktop.Client';
const DEMO = process.argv.includes('--demo');
const RENDERER = path.join(__dirname, 'renderer');
const APP_URL = 'xyz://app/app.html';
const DATA = DEMO ? path.join(app.getPath('temp'), 'xiaoyuzhou-desktop-demo' + (process.env.XYZ_TEST_RUN || '').replace(/[^a-zA-Z0-9_-]/g, ''))
  : path.join(app.getPath('appData'), 'XiaoyuzhouDesktop');
app.setPath('userData', DATA);
app.setAppUserModelId(APP_ID);
app.setName('小宇宙桌面版');
protocol.registerSchemesAsPrivileged([{ scheme: 'xyz', privileges: { standard: true, secure: true,
  supportFetchAPI: true, stream: true } }]);

let win, tray, store, backend, checker, listeningHistory, loginWindow, pollTimer, quitting = false;
let playback = { paused: true, title: '', currentTime: 0, duration: 0 };
let quitTimer;
let quitConfirmed = false;
const notices = new Set();
const jobs = new Set();
const iconPath = app.isPackaged ? path.join(process.resourcesPath, 'icons', 'planet-' + app.getVersion() + '.ico')
  : path.join(RENDERER, 'icons', 'app.ico');
const nativeHostPath = app.isPackaged ? path.join(process.resourcesPath, 'native', 'xyz-helper.exe')
  : path.join(__dirname, '.build', 'native', 'xyz-helper.exe');
const desktopDefaults = { notifications: true, closeToTray: true, minimizeToTray: true };
const prefs = () => ({ ...desktopDefaults, ...store.get('desktopSettings', {}) });
const log = event => {
  fs.mkdirSync(DATA, { recursive: true });
  fs.appendFileSync(path.join(DATA, 'desktop.log'), `${new Date().toISOString()} ${event}\n`);
};
function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}
function sendCommand(command) { showWindow(); win.webContents.send('xyz:command', command); }
function issueNotice({ title, body, command }) {
  return new Promise((resolve, reject) => {
    if (!Notification.isSupported()) return reject(new Error('当前 Windows 环境不支持系统通知'));
    const notification = new Notification({ title, body, icon: iconPath, silent: false });
    notices.add(notification);
    const timeout = setTimeout(() => { notices.delete(notification); reject(new Error('Windows 暂未确认通知，请检查专注助手或系统通知设置')); }, 8000);
    notification.once('show', () => { clearTimeout(timeout); log('notification-shown'); resolve(); });
    notification.once('failed', (_event, error) => { clearTimeout(timeout); notices.delete(notification); log('notification-failed'); reject(new Error(String(error || '系统通知发送失败'))); });
    notification.once('close', () => notices.delete(notification));
    notification.once('click', () => { showWindow(); if (command) win.webContents.send('xyz:command', command); });
    notification.show();
  });
}
function status() {
  return { settings: prefs(), updates: checker?.status || {},
    version: app.getVersion(), notificationSupported: Notification.isSupported(), demo: DEMO };
}
function currentOwner() {
  return DEMO ? 'demo-user' : ownerOf(store.get('extensionSession', {}).xyzAuthSession);
}
function accountView(auth) {
  return auth ? { user: auth.user || null } : null;
}
function publishStorage({ changes, areaName }) {
  if (areaName !== 'session' || !changes.xyzAuthSession) return;
  const change = changes.xyzAuthSession;
  const oldValue = accountView(change.oldValue);
  const newValue = accountView(change.newValue);
  if (Boolean(oldValue) === Boolean(newValue) && ownerOf(oldValue) === ownerOf(newValue)) return;
  listeningHistory.flush();
  playback = { paused: true, title: '', currentTime: 0, duration: 0 };
  trayMenu();
  if (win && !win.isDestroyed()) win.webContents.send('xyz:storage', { areaName, changes: { xyzAuthSession: { oldValue, newValue } } });
  if (newValue && checker) setTimeout(() => checker.check().then(publishStatus), 1500);
}
function publishStatus() { if (win && !win.isDestroyed()) win.webContents.send('xyz:status-updated', status()); }
function trayMenu() {
  if (!tray) return;
  tray.setToolTip(playback.title ? `小宇宙 · ${playback.paused ? '已暂停' : '正在播放'}\n${playback.title}`.slice(0, 120) : '小宇宙桌面版');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开小宇宙', click: showWindow },
    { label: playback.title || '还没有开始播放', enabled: false },
    { label: playback.paused ? '播放' : '暂停', enabled: Boolean(playback.title), click: () => win.webContents.send('xyz:command', { type: 'toggle-play' }) },
    { label: '后退 15 秒', enabled: Boolean(playback.title), click: () => win.webContents.send('xyz:command', { type: 'skip', seconds: -15 }) },
    { label: '前进 30 秒', enabled: Boolean(playback.title), click: () => win.webContents.send('xyz:command', { type: 'skip', seconds: 30 }) },
    { type: 'separator' },
    { label: '检查订阅更新', click: async () => { await checker.check(); publishStatus(); } },
    { label: '新单集通知', type: 'checkbox', checked: prefs().notifications,
      click: item => { store.set('desktopSettings', { ...prefs(), notifications: item.checked }); trayMenu(); publishStatus(); } },
    { type: 'separator' },
    { label: '退出小宇宙', click: () => app.quit() }
  ]));
}
function validSender(event) {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== APP_URL) {
    throw new Error('来源不受信任');
  }
}
function httpsExternal(value) {
  try { const url = new URL(value); return url.protocol === 'https:' ? url.toString() : null; } catch { return null; }
}
function openOfficialLogin(url) {
  if (new URL(url).hostname !== 'accounts.xiaoyuzhoufm.com') throw new Error('登录地址无效');
  if (loginWindow && !loginWindow.isDestroyed()) { loginWindow.show(); loginWindow.focus(); return; }
  const login = new BrowserWindow({ title: '小宇宙官方登录', width: 520, height: 800, autoHideMenuBar: true,
    icon: iconPath, webPreferences: { partition: 'persist:official-login', nodeIntegration: false,
      contextIsolation: true, sandbox: true } });
  loginWindow = login;
  let timer;
  const completeLogin = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (login.isDestroyed()) return;
      try {
        const auth = await backend.request({ type: 'sync-official-login' });
        if (auth && !login.isDestroyed()) { login.close(); showWindow(); }
      } catch { /* The cookie pair is incomplete until the official sign-in finishes. */ }
    }, 400);
  };
  const jar = login.webContents.session.cookies;
  const onCookie = (_event, cookie, _cause, removed) => {
    if (!removed && /(^|\.)xiaoyuzhoufm\.com$/i.test(cookie.domain) &&
        ['x-jike-access-token', 'x-jike-refresh-token'].includes(cookie.name)) completeLogin();
  };
  jar.on('changed', onCookie);
  login.webContents.on('did-finish-load', completeLogin);
  login.once('closed', () => {
    clearTimeout(timer); jar.removeListener('changed', onCookie); loginWindow = null;
  });
  const allowed = destination => {
    try { const u = new URL(destination); return u.protocol === 'https:' &&
      (u.hostname === 'xiaoyuzhoufm.com' || u.hostname.endsWith('.xiaoyuzhoufm.com') ||
       ['open.weixin.qq.com', 'wx.qq.com', 'open.wechat.com'].includes(u.hostname)); } catch { return false; }
  };
  login.webContents.on('will-navigate', (event, destination) => { if (!allowed(destination)) event.preventDefault(); });
  login.webContents.setWindowOpenHandler(({ url: destination }) => {
    if (allowed(destination)) login.loadURL(destination).catch(() => {});
    return { action: 'deny' };
  });
  login.loadURL(url).catch(() => {});
}

async function nativeRequest(message) {
  if (message.action === 'choose_directory') {
    const result = await dialog.showOpenDialog(win, { title: message.prompt || '请选择保存目录', properties: ['openDirectory', 'createDirectory'] });
    return { path: result.canceled ? '' : result.filePaths[0] };
  }
  if (message.action === 'import_markdown_file') {
    const result = await dialog.showOpenDialog(win, { title: message.prompt, properties: ['openFile'], filters: [{ name: 'Markdown 转写稿', extensions: ['md', 'markdown'] }] });
    if (result.canceled) return { path: '', canceled: true };
    const source = result.filePaths[0];
    const directory = message.transcriptDirectory.replace(/^~(?=[\\/])/, app.getPath('home'));
    fs.mkdirSync(directory, { recursive: true });
    const target = uniquePath(path.join(directory, path.basename(source)));
    fs.copyFileSync(source, target);
    return { path: target, markdown: target };
  }
  return new Promise((resolve, reject) => {
    const child = spawn(nativeHostPath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, XYZ_DESKTOP_DATA: DATA } });
    jobs.add(child);
    const chunks = [];
    let received = 0;
    const timeout = setTimeout(() => { child.kill(); reject(new Error('本地任务超时，请重试')); }, 45 * 60 * 1000);
    child.stdout.on('data', chunk => {
      received += chunk.length;
      if (received > 64 * 1024 * 1024) { child.kill(); reject(new Error('本地任务响应过大')); }
      else chunks.push(chunk);
    });
    child.stderr.on('data', () => {});
    child.on('error', error => { clearTimeout(timeout); jobs.delete(child); reject(new Error(`本地助手启动失败：${error.message}`)); });
    child.on('close', () => {
      clearTimeout(timeout); jobs.delete(child);
      try {
        const bytes = Buffer.concat(chunks);
        if (bytes.length < 4 || bytes.readUInt32LE(0) !== bytes.length - 4) throw new Error('本地助手响应不完整');
        const response = JSON.parse(bytes.subarray(4).toString('utf8'));
        if (!response.ok) throw new Error(response.error || '本地助手执行失败');
        resolve(response.data);
      } catch (error) { reject(error); }
    });
    child.stdin.on('error', () => {});
    const bytes = Buffer.from(JSON.stringify(message), 'utf8');
    const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length);
    child.stdin.end(Buffer.concat([header, bytes]));
  });
}
function uniquePath(filename) {
  const extension = path.extname(filename);
  const base = filename.slice(0, -extension.length);
  let target = filename, counter = 1;
  while (fs.existsSync(target)) target = `${base} (${counter++})${extension}`;
  return target;
}
async function download(options) {
  const filename = String(options.filename || '小宇宙音频.m4a');
  if (path.isAbsolute(filename) || filename.split(/[\\/]/).includes('..')) throw new Error('下载文件名无效');
  const target = uniquePath(path.join(app.getPath('downloads'), filename));
  let chosen = target;
  if (options.saveAs) {
    const result = await dialog.showSaveDialog(win, { defaultPath: target });
    if (result.canceled) return { canceled: true };
    chosen = result.filePath;
  }
  return nativeRequest({ action: 'download_audio', directory: path.dirname(chosen), filename: path.basename(chosen), url: options.url });
}
function registerShortcuts() {
  const locations = [path.join(app.getPath('desktop'), '小宇宙桌面版.lnk'),
    path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', '小宇宙桌面版.lnk')];
  for (const location of locations) {
    fs.mkdirSync(path.dirname(location), { recursive: true });
    const saved = shell.writeShortcutLink(location, fs.existsSync(location) ? 'update' : 'create', {
      target: process.execPath, cwd: path.dirname(process.execPath), icon: iconPath, iconIndex: 0,
      appUserModelId: APP_ID, description: '小宇宙 · 后台播放与新单集通知', args: ''
    });
    if (!saved) log('shortcut-registration-failed');
  }
}
function createWindow() {
  const bounds = store.get('windowBounds', { width: 1160, height: 824 });
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(Math.max(600, bounds.width || 1160), area.width);
  const height = Math.min(Math.max(560, bounds.height || 824), area.height);
  win = new BrowserWindow({ title: '小宇宙桌面版', width, height, minWidth: 600, minHeight: 560,
    icon: iconPath, backgroundColor: '#ffffff', autoHideMenuBar: true, show: false,
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#ffffff', symbolColor: '#1b1b1d', height: 54 },
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false,
      contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.webContents.setWindowOpenHandler(({ url }) => { const external = httpsExternal(url); if (external) shell.openExternal(external); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => { if (url !== APP_URL) { event.preventDefault(); const external = httpsExternal(url); if (external) shell.openExternal(external); } });
  win.webContents.on('render-process-gone', (_event, details) => log(`renderer-stopped-${details.reason}`));
  win.once('ready-to-show', () => { win.show(); log('window-ready'); });
  win.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    if (prefs().closeToTray) { win.hide(); log('hidden-to-tray'); }
    else app.quit(); // Keep the window alive until the renderer checkpoints playback.
  });
  win.on('minimize', () => { if (prefs().minimizeToTray && tray) { win.hide(); log('minimized-to-tray'); } });
  let boundsTimer;
  const saveBounds = () => { clearTimeout(boundsTimer); boundsTimer = setTimeout(() => {
    if (!win.isDestroyed() && !win.isMinimized() && !win.isMaximized()) store.set('windowBounds', win.getBounds());
  }, 500); };
  win.on('resize', saveBounds);
  win.on('closed', () => { clearTimeout(boundsTimer); win = null; if (!quitting) app.quit(); });
  win.loadURL(APP_URL).catch(error => { dialog.showErrorBox('小宇宙启动失败', error.message); app.quit(); });
}

// Explicit demo mode uses isolated storage, two public program covers and a silent seekable test track.
let sampleAudio;
function demoAudio() {
  if (sampleAudio) return sampleAudio;
  const frames = 180 * 8000;
  const bytes = Buffer.alloc(frames + 44, 128);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(frames + 36, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(8000, 28); bytes.writeUInt16LE(1, 32);
  bytes.writeUInt16LE(8, 34); bytes.write('data', 36); bytes.writeUInt32LE(frames, 40);
  sampleAudio = bytes;
  return bytes;
}
function demoRequest(message) {
  const programs = [
    { title: '半拿铁·周刊', cover: 'https://image.xyzcdn.net/Fq57UENum3-waqGe1V5pv2gwhCQz.jpg',
      episode: 'No.54 图库巨头的破产，以及缅怀刘欢' },
    { title: '半拿铁 | 商业沉浮录', cover: 'https://image.xyzcdn.net/FlZXHELEin8JN9xIrT3IMsQQo1M0.png',
      episode: 'No.226 文曲星的三十年往事' }
  ];
  const episodes = programs.map((p, i) => ({
    type: 'EPISODE', eid: 'demo-e' + i, title: p.episode, duration: 180,
    podcast: { type: 'PODCAST', pid: 'demo-p' + i, title: p.title, image: { picUrl: p.cover } },
    media: { source: { url: 'xyz://app/test-tone.wav?episode=' + i } }, pubDate: '2026-11-17T00:00:00Z',
    shownotes: '<p>00:00 开场</p><p>01:00 中段</p><p>02:00 尾段</p>'
  }));
  if (message.type === 'get-auth' || message.type === 'restore-auth') return Promise.resolve({ accessToken: 'local-demo', user: { uid: 'demo-user', nickname: '播放器验证' } });
  if (message.type === 'api') {
    const { endpoint, body } = message.payload;
    if (endpoint === '/search') {
      const items = body.type === 'PODCAST' ? episodes.map(episode => episode.podcast) : episodes;
      return Promise.resolve({ data: items.filter(item => [item.title, item.podcast?.title].some(title => title?.includes(body.keyword))) });
    }
    if (endpoint === '/subscription') return Promise.resolve({ data: episodes.map(e => e.podcast) });
    if (endpoint === '/episode_detail') return Promise.resolve({ data: episodes.find(e => e.eid === body.eid) });
    if (endpoint === '/episode_list') return Promise.resolve({ data: episodes.filter(e => e.podcast.pid === body.pid) });
    if (endpoint === '/podcast_detail') return Promise.resolve({ data: episodes.find(e => e.podcast.pid === body.pid)?.podcast });
    return Promise.resolve({ data: episodes });
  }
  return backend.request(message);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, argv) => {
    if (app.isPackaged && !DEMO && argv.includes('--register-shortcuts')) registerShortcuts();
    showWindow();
  });
  app.on('before-quit', event => {
    if (!quitConfirmed && playback.title && win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      event.preventDefault();
      if (!quitTimer) {
        quitTimer = setTimeout(() => { quitConfirmed = true; app.quit(); }, 500);
        win.webContents.send('xyz:command', { type: 'checkpoint' });
      }
      return;
    }
    quitting = true;
    clearTimeout(quitTimer); clearInterval(pollTimer); listeningHistory?.flush();
    for (const child of jobs) child.kill();
  });
  app.on('window-all-closed', () => { if (quitting) app.quit(); });
  app.whenReady().then(async () => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 加密存储不可用，无法安全保存登录信息');
    store = new Store(path.join(DATA, 'settings.encrypted'), safeStorage);
    listeningHistory = new ListeningHistory(new Store(path.join(DATA, 'listening.encrypted'), safeStorage));
    listeningHistory.importPrevious(currentOwner(), store.get('lastPlayback', null));
    const importFile = path.join(__dirname, '.build', 'import-settings.json');
    if (!DEMO && !store.get('settingsImported', false) && fs.existsSync(importFile)) {
      const imported = JSON.parse(fs.readFileSync(importFile, 'utf8'));
      if (!store.get('extensionLocal')) store.set('extensionLocal', imported);
      store.set('settingsImported', true);
      log('extension-settings-imported');
    }
    protocol.handle('xyz', request => {
      const url = new URL(request.url);
      if (url.host !== 'app') return new Response('Forbidden', { status: 403 });
      if (DEMO && url.pathname === '/test-tone.wav') {
        const bytes = demoAudio();
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get('range') || '');
        const start = range ? Number(range[1]) : 0;
        const end = range && range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
        if (start > end || start >= bytes.length) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${bytes.length}` } });
        return new Response(bytes.subarray(start, end + 1), { status: range ? 206 : 200, headers: {
          'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1),
          ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {})
        } });
      }
      const filename = path.resolve(RENDERER, '.' + decodeURIComponent(url.pathname));
      if (!filename.startsWith(RENDERER + path.sep) || !fs.existsSync(filename)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(filename).toString());
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    backend = createBackend({ store, nativeHostPath,
      fetch: (url, options) => net.fetch(url, options), nativeRequest, download, officialLogin: openOfficialLogin,
      cookies: options => session.fromPartition('persist:official-login').cookies.get(options),
      clearOfficialLogin: async () => {
        if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
        await session.fromPartition('persist:official-login').clearStorageData({ storages: ['cookies', 'localstorage'] });
      },
      showWindow, publish: publishStorage
    });
    const request = DEMO ? demoRequest : message => backend.request(message);
    checker = new UpdateChecker({ request, store, notify: async episodes => {
      if (!prefs().notifications) return;
      if (episodes.length === 1) {
        const episode = episodes[0];
        await issueNotice({ title: `${episode.podcast?.title || '订阅节目'} 更新了`, body: episode.title || '有新单集可以收听', command: { type: 'open-episode', eid: episode.eid } });
      } else {
        await issueNotice({ title: `订阅更新 · ${episodes.length} 个新单集`, body: episodes.slice(0, 3).map(e => `${e.podcast?.title || '播客'}：${e.title}`).join('\n'), command: { type: 'subscriptions' } });
      }
    } });
    const types = new Set(['open-app', 'get-auth', 'restore-auth', 'logout', 'get-settings', 'get-summary-history', 'update-settings',
      'open-official-login', 'sync-official-login', 'api', 'download-audio', 'transcribe-audio', 'find-existing-transcript',
      'get-native-host-status', 'save-asr-credentials', 'save-summary-credentials', 'save-summary-model-credential',
      'get-summary-model-credential-status', 'test-summary-model', 'import-summary-transcript', 'summarize-transcript', 'choose-native-directory']);
    ipcMain.handle('xyz:request', async (event, message) => {
      validSender(event);
      try {
        if (!message || !types.has(message.type)) throw new Error('未知操作');
        const data = await request(message);
        return { ok: true, data: ['get-auth', 'restore-auth', 'sync-official-login'].includes(message.type) ? accountView(data) : data };
      } catch (error) { return { ok: false, error: error.message }; }
    });
    ipcMain.handle('xyz:status', event => { validSender(event); return status(); });
    ipcMain.handle('xyz:history', (event, eid) => {
      validSender(event);
      const owner = currentOwner();
      return typeof eid === 'string' ? listeningHistory.find(owner, eid) : listeningHistory.list(owner);
    });
    ipcMain.handle('xyz:settings', (event, next) => {
      validSender(event);
      const clean = { ...prefs() };
      for (const key of Object.keys(desktopDefaults)) if (typeof next?.[key] === 'boolean') clean[key] = next[key];
      store.set('desktopSettings', clean); trayMenu(); publishStatus(); return clean;
    });
    ipcMain.handle('xyz:check-updates', async event => { validSender(event); const result = await checker.check(); publishStatus(); return result; });
    ipcMain.handle('xyz:test-notification', async event => {
      validSender(event);
      try { await issueNotice({ title: '小宇宙通知已就绪', body: '订阅节目有新单集时，会在这里提醒你', command: { type: 'subscriptions' } }); return { ok: true }; }
      catch (error) { return { ok: false, error: error.message }; }
    });
    ipcMain.on('xyz:hide', event => { validSender(event); win.hide(); log('hidden-to-tray'); });
    ipcMain.on('xyz:quit', event => { validSender(event); app.quit(); });
    ipcMain.on('xyz:checkpoint', event => { validSender(event); if (quitTimer) { quitConfirmed = true; app.quit(); } });
    ipcMain.on('xyz:playback', (event, value) => {
      validSender(event);
      const owner = currentOwner();
      if (!owner || value.owner !== owner) return;
      const changed = playback.paused !== Boolean(value.paused) || playback.title !== String(value.title || '');
      playback = { paused: Boolean(value.paused), title: String(value.title || '').slice(0, 300),
        currentTime: Number(value.currentTime) || 0, duration: Number(value.duration) || 0 };
      if (changed) { trayMenu(); log(playback.paused ? 'playback-paused' : 'playback-playing'); }
      if (value.record) listeningHistory.record(owner, value, changed || value.force);
    });
    if (process.argv.includes('--register-shortcuts') && app.isPackaged) registerShortcuts();
    Menu.setApplicationMenu(null);
    createWindow();
    tray = new Tray(nativeImage.createFromPath(iconPath));
    tray.on('click', showWindow); tray.on('double-click', showWindow); trayMenu();
    setTimeout(() => checker.check().then(publishStatus), 8000);
    pollTimer = setInterval(() => checker.check().then(publishStatus), 5 * 60 * 1000);
    log(DEMO ? 'started-demo' : 'started');
  }).catch(error => { dialog.showErrorBox('小宇宙启动失败', error.message); app.quit(); });
}
