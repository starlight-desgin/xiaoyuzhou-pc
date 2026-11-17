const { contextBridge, ipcRenderer } = require('electron');
const subscribe = (channel, listener) => {
  const handler = (_event, value) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};
contextBridge.exposeInMainWorld('xyzDesktop', {
  request: message => ipcRenderer.invoke('xyz:request', message),
  status: () => ipcRenderer.invoke('xyz:status'),
  history: eid => ipcRenderer.invoke('xyz:history', eid),
  settings: settings => ipcRenderer.invoke('xyz:settings', settings),
  checkUpdates: () => ipcRenderer.invoke('xyz:check-updates'),
  testNotification: () => ipcRenderer.invoke('xyz:test-notification'),
  hide: () => ipcRenderer.send('xyz:hide'),
  quit: () => ipcRenderer.send('xyz:quit'),
  checkpoint: () => ipcRenderer.send('xyz:checkpoint'),
  playback: value => ipcRenderer.send('xyz:playback', value),
  onStorage: listener => subscribe('xyz:storage', listener),
  onCommand: listener => subscribe('xyz:command', listener),
  onStatus: listener => subscribe('xyz:status-updated', listener)
});
