const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

test('home routes the assistant entry to the service-account binding page', () => {
  const source = read('miniprogram/pages/home/index.js')
  assert.match(source, /navigateTo\(\{\s*url:\s*['"]\/pages\/account\/index\?section=wechat['"]/)
  assert.doesNotMatch(source, /openCustomerServiceChat/)
  assert.doesNotMatch(source, /identity\.createKfEntry/)
})

test('account page marks the unfinished service-account entry as beta without opening binding', () => {
  const markup = read('miniprogram/pages/account/index.wxml')
  assert.doesNotMatch(markup, /<official-account\b/)
  assert.match(markup, /主线笔记助手/)
  assert.match(markup, /内测中/)
  assert.match(markup, /暂未开放/)
  assert.match(markup, /不会进入尚未完成的绑定流程/)
})

test('official-account webhook is publicly routed without platform auth', () => {
  const routes = JSON.parse(read('deploy-route.json')).routes
  const route = routes.find((item) => item.path === '/wechat-webhook')
  assert.ok(route)
  assert.equal(route.upstreamResourceName, 'wechatWebhook')
  assert.equal(route.enable, true)
  assert.equal(route.enableAuth, false)
})

test('mini app exposes staged sync feedback and recoverable 15-day trash', () => {
  const home = read('miniprogram/pages/home/index.js')
  const archive = read('miniprogram/pages/archive/index.wxml')
  const api = read('cloudfunctions/notebookApi/index.js')
  const desktopSync = read('cloudfunctions/desktopSync/index.js')

  assert.match(home, /已保存到云端/)
  assert.match(home, /电脑下次上线自动补齐/)
  assert.match(home, /desktopAppliedAt/)
  assert.match(archive, /垃圾箱/)
  assert.match(archive, /15 天/)
  assert.match(archive, /bindtap="restoreTrash"/)
  assert.match(api, /TRASH_RETENTION_DAYS = 15/)
  assert.match(api, /action === 'trash\.restore'/)
  assert.match(desktopSync, /action === 'sync\.ack'/)
})

test('home shows the active workspace and uses notebook terminology', () => {
  const home = read('miniprogram/pages/home/index.js')
  const markup = read('miniprogram/pages/home/index.wxml')
  const appConfig = read('miniprogram/app.json')

  assert.match(home, /\.find\(\(workspace\) => workspace\.active\)/)
  assert.match(markup, /activeWorkspace \? activeWorkspace\.name/)
  assert.match(home, /笔记 ·/)
  assert.match(markup, /保存笔记/)
  assert.doesNotMatch(markup, /记录评论|条评论/)
  assert.match(appConfig, /"navigationBarTitleText": "主线笔记"/)
})

test('mini app consistently names the journal 灵光一现', () => {
  const appConfig = read('miniprogram/app.json')
  const captureMarkup = read('miniprogram/pages/capture/index.wxml')
  const captureConfig = read('miniprogram/pages/capture/index.json')
  const organizer = read('cloudfunctions/notebookApi/index.js')
  const officialReply = read('cloudfunctions/wechatWebhook/index.js')
  const customerReply = read('cloudfunctions/wechatKfWebhook/index.js')

  assert.match(appConfig, /"text": "灵光一现"/)
  assert.match(captureMarkup, /<view class="title">灵光一现<\/view>/)
  assert.match(captureConfig, /"navigationBarTitleText": "灵光一现"/)
  assert.match(organizer, /灵光一现整理器/)
  assert.match(officialReply, /小程序“灵光一现”/)
  assert.match(customerReply, /整理进灵光一现/)
})
