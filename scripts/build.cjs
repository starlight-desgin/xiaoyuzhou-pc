const fs = require('node:fs');
const path = require('node:path');
function copyTree(source, destination) {
  if (fs.statSync(source).isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source)) copyTree(path.join(source, entry), path.join(destination, entry));
  } else fs.copyFileSync(source, destination);
}
(async () => {
  const root = path.resolve(__dirname, '..');
  const { version } = require('../package.json');
  const dist = path.join(root, 'dist', '小宇宙桌面版-' + version);
  fs.mkdirSync(path.join(root, '.build'), { recursive: true });
  const staging = fs.mkdtempSync(path.join(root, '.build', 'app-'));
  const runtime = path.join(root, 'node_modules', 'electron', 'dist');
  if (!fs.existsSync(path.join(runtime, 'electron.exe'))) throw new Error('Electron 运行时缺失，请执行 node node_modules/electron/install.js');
  if (!fs.existsSync(path.join(root, '.build', 'native', 'xyz-helper.exe'))) throw new Error('本地助手缺失，请执行 npm run build:native');
  fs.mkdirSync(dist, { recursive: true });
  copyTree(runtime, dist);
  const exe = path.join(dist, '小宇宙.exe');
  if (fs.existsSync(exe)) fs.unlinkSync(exe);
  fs.renameSync(path.join(dist, 'electron.exe'), exe);
  for (const filename of ['main.cjs', 'preload.cjs', 'package.json', 'LICENSE.upstream', 'lib', 'renderer']) {
    copyTree(path.join(root, filename), path.join(staging, filename));
  }
  const { createPackage } = await import('@electron/asar');
  await createPackage(staging, path.join(dist, 'resources', 'app.asar'));
  fs.mkdirSync(path.join(dist, 'resources', 'native'), { recursive: true });
  fs.copyFileSync(path.join(root, '.build', 'native', 'xyz-helper.exe'), path.join(dist, 'resources', 'native', 'xyz-helper.exe'));
  fs.copyFileSync(path.join(root, 'LICENSE.upstream'), path.join(dist, 'LICENSE.upstream'));
  const { rcedit } = await import('rcedit');
  await rcedit(exe, {
    icon: path.join(root, 'renderer', 'icons', 'app.ico'),
    'file-version': version, 'product-version': version,
    'version-string': { ProductName: '小宇宙桌面版', FileDescription: '小宇宙桌面客户端',
      OriginalFilename: '小宇宙.exe', CompanyName: 'Local Desktop', LegalCopyright: 'Based on QWE38qwe/xiaoyuzhou-desktop (MIT)' }
  });
  fs.writeFileSync(path.join(dist, '使用说明.txt'),
    '小宇宙桌面版\r\n\r\n双击“小宇宙.exe”即可使用，无需 Chrome。\r\n' +
    '关闭窗口或最小化会收进右下角系统托盘，音频会继续播放。\r\n' +
    '单击托盘图标恢复窗口；右击可播放、暂停、快进、检查更新或退出。\r\n' +
    '右上角铃铛可管理新单集通知与系统托盘。\r\n' +
    '登录后在客户端运行期间每 5 分钟检查订阅新单集；首次只建立记录，不提醒旧节目。\r\n' +
    'Windows 专注助手或关闭系统通知可能使通知不显示。\r\n' +
    '在官方窗口登录一次，客户端会自动记住账号。收听页能按单集续播，可拖动波形或底部进度条。\r\n' +
    '账号及设置保存在当前 Windows 用户的 AppData\\Roaming\\XiaoyuzhouDesktop，使用 Windows 加密。\r\n' +
    '可从桌面快捷方式打开客户端。\r\n', 'utf8');
  console.log(exe);
})().catch(error => { console.error(error); process.exitCode = 1; });
