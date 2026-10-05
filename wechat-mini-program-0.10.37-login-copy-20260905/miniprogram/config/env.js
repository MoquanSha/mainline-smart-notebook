module.exports = {
  // 部署后写入真实 EnvId；留空时使用开发者工具当前绑定的默认环境。
  envId: 'YOUR_CLOUDBASE_ENV_ID',
  apiFunction: 'notebookApi',
  syncFunction: 'desktopSync',
  clientVersion: '0.10.44',
  // 省额度模式不轮询。启动、回到前台和用户点击“同步刷新”才拉取；
  // 用户真正改动数据时，短暂防抖后合并成一次增量上传。
  cloudSyncEnabled: true,
  syncMode: 'cloud-manual',
  manualSyncOnly: true
}

