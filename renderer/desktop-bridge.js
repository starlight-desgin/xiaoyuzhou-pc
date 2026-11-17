globalThis.chrome = {
  runtime: {
    lastError: null,
    sendMessage(message, callback) {
      window.xyzDesktop.request(message).then(callback).catch(error => callback({ ok: false, error: error.message }));
    }
  },
  storage: {
    onChanged: { addListener(listener) {
      window.xyzDesktop.onStorage(({ changes, areaName }) => listener(changes, areaName));
    } }
  }
};
