// Use Electron's own rasterizer so the mark in the window and the Windows icon match.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const directory = path.join(__dirname, '..', 'renderer', 'icons');
const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await win.loadURL(pathToFileURL(path.join(directory, 'planet.svg')).href);
  const frames = [];
  for (const size of sizes) {
    const data = await win.webContents.executeJavaScript(`(async () => {
      const img = new Image();
      img.src = location.href;
      await img.decode();
      const canvas = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
      canvas.width = canvas.height = ${size};
      canvas.getContext('2d').drawImage(img, 0, 0, ${size}, ${size});
      return canvas.toDataURL('image/png').split(',')[1];
    })()`);
    const png = Buffer.from(data, 'base64');
    frames.push(png);
    if ([16, 32, 48, 128].includes(size)) fs.writeFileSync(path.join(directory, 'icon-' + size + '.png'), png);
  }
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, i) => {
    const entry = 6 + i * 16;
    header[entry] = header[entry + 1] = size % 256;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frames[i].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += frames[i].length;
  });
  fs.writeFileSync(path.join(directory, 'app.ico'), Buffer.concat([header, ...frames]));
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
