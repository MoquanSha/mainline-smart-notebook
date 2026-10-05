const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')

test('旧版桌面入口仍能进入当前页面', () => {
  const appConfig = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8'))
  const appSource = fs.readFileSync(path.join(root, 'miniprogram/app.js'), 'utf8')
  const timelineSource = fs.readFileSync(path.join(root, 'miniprogram/pages/timeline/index.js'), 'utf8')
  const recordsSource = fs.readFileSync(path.join(root, 'miniprogram/pages/records/index.js'), 'utf8')
  assert.ok(appConfig.pages.includes('pages/timeline/index'))
  assert.ok(appConfig.pages.includes('pages/records/index'))
  assert.match(timelineSource, /\/pages\/home\/index/)
  assert.match(recordsSource, /\/pages\/archive\/index/)
  assert.match(appSource, /onPageNotFound/)
  assert.match(appSource, /LEGACY_PAGE_REDIRECTS/)
})

test('当前客户端使用 CloudBase 省额度手动同步模式', () => {
  const envSource = fs.readFileSync(path.join(root, 'miniprogram/config/env.js'), 'utf8')
  const homeSource = fs.readFileSync(path.join(root, 'miniprogram/pages/home/index.js'), 'utf8')
  const taskSource = fs.readFileSync(path.join(root, 'miniprogram/pages/tasks/index.js'), 'utf8')
  // This is a sync-policy check, so it must not become stale after a normal
  // client-version bump.
  assert.match(envSource, /clientVersion:\s*'\d+\.\d+\.\d+'/)
  assert.match(envSource, /cloudSyncEnabled:\s*true/)
  assert.match(envSource, /syncMode:\s*'cloud-manual'/)
  assert.match(homeSource, /cache\.read\(cache\.KEYS\.todayTodos, null\)/)
  assert.match(homeSource, /this\.apply\(\{ todos: \[\], history: \[\] \}, true\)/)
  assert.match(homeSource, /app\.syncPromise && typeof app\.syncPromise\.then === 'function'/)
  assert.match(taskSource, /this\.applyTasks\(cache\.read\(cache\.KEYS\.tasks, \[\]\)\)/)
})

test('预约栏紧邻今天已完成栏并位于其上方', () => {
  const homeMarkup = fs.readFileSync(path.join(root, 'miniprogram/pages/home/index.wxml'), 'utf8')
  const todoListIndex = homeMarkup.indexOf('wx:for="{{todos}}"')
  const scheduledIndex = homeMarkup.indexOf('class="scheduled-section"')
  const completedIndex = homeMarkup.indexOf('class="completed-section"')
  assert.ok(todoListIndex >= 0)
  assert.ok(todoListIndex < scheduledIndex)
  assert.ok(scheduledIndex < completedIndex)
})
