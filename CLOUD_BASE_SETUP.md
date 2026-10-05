# CloudBase 与微信小程序配置

这部分只给需要手机同步的开发者使用。普通用户直接下载 GitHub Releases 中的 Windows 安装包即可。

## 1. 准备自己的环境

准备自己的微信小程序 AppID 和 CloudBase 环境，不要填写维护者的配置。修改下面三个文件中的占位符：

```text
wechat-mini-program-0.10.37-login-copy-20260905/project.config.json
wechat-mini-program-0.10.37-login-copy-20260905/miniprogram/config/env.js
wechat-mini-program-0.10.37-login-copy-20260905/cloudbaserc.json
```

需要替换：

```text
YOUR_WECHAT_APPID
YOUR_CLOUDBASE_ENV_ID
YOUR_CLOUDBASE_DOMAIN
```

## 2. 安装 CloudBase CLI

如果使用 Windows，可以先双击仓库根目录的 `安装小程序云函数依赖.cmd`，这样后面的部署不会因为云函数缺少 `@cloudbase/node-sdk` 或 `wx-server-sdk` 而失败。

```powershell
npm install -g @cloudbase/cli
tcb login
tcb env list
```

确认列表中能看到自己的环境后，再继续部署。

## 3. 部署云函数

在 `wechat-mini-program-0.10.37-login-copy-20260905` 目录执行：

```powershell
Set-Location .\wechat-mini-program-0.10.37-login-copy-20260905
tcb fn deploy --all --env-id YOUR_CLOUDBASE_ENV_ID --yes
tcb fn list --env-id YOUR_CLOUDBASE_ENV_ID
```

HTTP 函数还需要按自己的环境配置网关路径。云函数部署成功不代表数据库安全规则和小程序 AppID 已经配置完成，首次运行前仍要在 CloudBase 控制台检查数据库、存储和登录关联。

## 4. 导入微信开发者工具

用微信开发者工具导入小程序目录，确认项目 AppID 是自己的值，绑定自己的 CloudBase 环境，然后编译和预览。电脑端的同步地址也必须指向自己的 `desktopSync` HTTP 地址。

## 5. 验收

至少检查一条待办、一条灵光一现、一条今日小记和一张图片的新增、拉取、删除与重新打开。测试结束后确认数据只出现在自己的 CloudBase 环境中。
