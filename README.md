# 小宇宙 PC 版

一个基于 Electron 的非官方小宇宙 Windows 客户端，提供发现、订阅和播客收听。这个仓库是桌面客户端的源码。

## 功能

- 拖动进度条定位，播放历史按账号保存在本机，下次打开可继续未听完的单集。
- 客户端使用对应节目的原始封面，支持搜索、订阅、快进、快退和倍速播放。
- 关闭窗口后收进系统托盘，继续后台播放。客户端运行时定期检查订阅的新单集并显示 Windows 通知。
- 支持音频下载，以及通过本地助手接入转写和 AI 总结服务。

首次在客户端弹出的小宇宙官方窗口完成登录，之后会自动恢复登录状态。历史记录和进度存放在本机，不会自动导入手机上的历史记录。

## 从源码构建

在 Windows 10/11 上准备 Node.js 22.12 或更高版本、Python 3.12（包含 Python Launcher）和 Git。构建 Windows 程序需要在 Windows 上执行。

~~~powershell
git clone https://github.com/starlight-desgin/xiaoyuzhou-pc.git
cd xiaoyuzhou-pc
npm ci
node node_modules/electron/install.js
py -3.12 -m pip install pyinstaller==6.20.0
npm run build:native
npm test
npm run build
~~~

构建结果位于 `dist/小宇宙桌面版-1.1.0/`，保留整个文件夹，运行其中的 `小宇宙.exe`。完成上述依赖和本地助手安装后，也可以运行 `npm start` 进行开发。

托盘、登录、通知和 Windows 加密存储依赖桌面环境。在程序右上角的铃铛菜单中可以检查订阅更新和发送测试通知。AI 转写或总结功能可能需要自行配置服务商的 API Key，具体可用服务以客户端设置为准。

## 本机数据

客户端的账号、设置、通知检查状态及播放记录保存在当前 Windows 用户的 `%APPDATA%\XiaoyuzhouDesktop` 目录。仓库不包含这些数据。首次启动需要在小宇宙官方登录窗口完成登录。

## 致谢

项目基于 [QWE38qwe/xiaoyuzhou-desktop](https://github.com/QWE38qwe/xiaoyuzhou-desktop) 开发。上游版权声明与 MIT 许可证保存在 [LICENSE.upstream](LICENSE.upstream)。
