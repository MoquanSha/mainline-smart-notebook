# CloudBase 安全规则

- 在云函数“权限控制”中应用 `cloud-function.rules.json`。小程序只能调用 `notebookApi`；`desktopSync` 只通过 HTTPS 入口和设备令牌访问。
- 除 `sync_state` 外，每一个数据库集合应用 `database-deny-client.rules.json`，禁止小程序直接读写数据库。
- `sync_signals` 应用 `database-sync-signals.rules.json`：小程序只能读取当前工作区的实时同步信号，不能从客户端写入。`sync_state` 与其他业务集合继续使用 `database-deny-client.rules.json`。
- 所有业务读写均由云函数再次校验 `ownerOpenId`。首位成功进入小程序的微信 OpenID 会被登记为内测版唯一所有者。
- 云存储应用 `storage-owner.rules.json`，评论图片只能由创建它的微信身份读取或写入；数据库中只保存 `fileID` 和附件元数据。
