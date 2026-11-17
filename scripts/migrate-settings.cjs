// Copy only this extension's local settings. Chrome's live database is never opened or modified.
const fs = require('node:fs');
const path = require('node:path');
const { ClassicLevel } = require('classic-level');
(async () => {
  const root = path.resolve(__dirname, '..');
  const source = path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data', 'Default', 'Local Extension Settings', 'jgcegnegoifbcokpipkogolkmodkcceb');
  const snapshot = fs.mkdtempSync(path.join(root, '.build', 'chrome-settings-'));
  const allowed = new Set(['xyzSettings', 'xyzSummaryHistory', 'xyzSidebarCollapsed']);
  if (!fs.existsSync(source)) return console.log('No extension settings found');
  for (const file of fs.readdirSync(source)) {
    if (file !== 'LOCK') fs.copyFileSync(path.join(source, file), path.join(snapshot, file));
  }
  const db = new ClassicLevel(snapshot, { keyEncoding: 'utf8', valueEncoding: 'utf8', createIfMissing: false });
  const result = {};
  await db.open();
  for await (const [key, value] of db.iterator()) {
    if (allowed.has(key)) { try { result[key] = JSON.parse(value); } catch {} }
  }
  await db.close();
  // This one-time import is put in the app's encrypted store by main.cjs.
  fs.writeFileSync(path.join(root, '.build', 'import-settings.json'), JSON.stringify(result));
  console.log('Settings copied: ' + Object.keys(result).join(', '));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
