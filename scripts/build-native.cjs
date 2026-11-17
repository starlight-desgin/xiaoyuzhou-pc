const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'win32') {
  console.error('请在 Windows 上构建小宇宙本地助手。');
  process.exit(1);
}

const root = path.resolve(__dirname, '..');
const build = path.join(root, '.build');
fs.mkdirSync(build, { recursive: true });

const result = spawnSync('py', [
  '-3.12', '-m', 'PyInstaller', '--noconfirm', '--clean', '--onefile',
  '--name', 'xyz-helper',
  '--paths', path.join(root, 'native'),
  '--add-data', path.join(root, 'native', 'local_asr_worker.py') + ';.',
  '--distpath', path.join(build, 'native'),
  '--workpath', path.join(build, 'pyinstaller'),
  '--specpath', build,
  path.join(root, 'native', 'desktop_host.py')
], { cwd: root, stdio: 'inherit', windowsHide: true });

if (result.error) {
  console.error('无法启动 Python 3.12，请检查 Python Launcher 和 PyInstaller 是否已安装。');
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status || 1);
console.log('本地助手已生成：.build/native/xyz-helper.exe');
