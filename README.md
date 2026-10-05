# 主线笔记

如果你想直接使用，可以让 Codex 或 Claude Code 帮你下载、安装并完成配置。

这是主线笔记的公开源码仓库，包含 Windows 桌面端、微信小程序同步代码和 CloudBase 云函数。

## 只想使用

如果仓库发布了 Windows 安装包，前往 GitHub 的 **Releases** 下载即可，普通用户不需要安装 Node.js。当前首个公开版本先提供源码启动方式，安装包会单独放进 Releases，避免把个人数据和构建产物混进源码。

## 从源码启动桌面端

先安装 Node.js 22 或更高版本，然后在仓库根目录双击：

```text
一键启动源码版.cmd
```

脚本会自动检查 Node.js，第一次启动时安装依赖，然后构建并打开桌面端。也可以在 PowerShell 中运行：

```powershell
.\一键启动源码版.cmd
```

## 使用手机同步

手机同步需要使用者自己的微信小程序 AppID、CloudBase 环境和云函数。请先阅读小程序目录和 CloudBase 部署文档中的配置说明，不要直接连接仓库维护者的生产环境。

完整部署步骤见 [CLOUD_BASE_SETUP.md](./CLOUD_BASE_SETUP.md)。

当前仓库的 Windows 构建和手机同步属于 Preview 状态。使用前请查看 Releases 和 Issues 中的已知问题。

## 命令行入口

```powershell
# 进入桌面端源码目录
Set-Location .\personal-task-workbench-4320-wechat-login-test

# 安装依赖，首次运行或 package-lock.json 更新后执行
npm ci

# 启动网页开发服务
npm run dev

# 构建桌面网页资源
npm run build

# 运行自动化测试
npm test

# 检查前端代码
npm run lint

# 构建并启动 Electron 桌面开发版
npm run desktop:dev

# 构建 Windows 安装包，产物写入 release 目录
npm run desktop:package
```

微信小程序源码位于 `wechat-mini-program-0.10.37-login-copy-20260905`。它需要在微信开发者工具中导入，并配置使用者自己的 AppID 和 CloudBase 环境；当前仓库不提供共享生产环境的自动登录配置。

如果只想先把云函数依赖装好，可以在仓库根目录双击 `安装小程序云函数依赖.cmd`。它会遍历小程序目录下的每个云函数并执行 `npm install`，不会上传代码，也不会连接维护者的环境。
