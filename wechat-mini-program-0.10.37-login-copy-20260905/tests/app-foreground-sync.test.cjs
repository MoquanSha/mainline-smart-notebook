const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'app.js'), 'utf8')

function loadApp({ pending = false } = {}) {
  let definition
  const reasons = []
  const incrementalReasons = []
  const api = {
    hasPendingQueue: () => pending,
    syncNow: async (options) => {
      assert.equal(options.includeBootstrap, true)
      return { ok: true }
    },
    flushDirtyQueueNow: async (options) => {
      incrementalReasons.push(options.reason)
      return { ok: true }
    }
  }
  const context = {
    require(request) {
      if (request === './config/env') return { cloudSyncEnabled: false, clientVersion: 'test' }
      if (request === './utils/api') return api
      if (request === './utils/cache') return { KEYS: { bootstrap: 'bootstrap' }, read: () => ({ account: { user: { id: 'user_test' } } }) }
      throw new Error(`Unexpected require: ${request}`)
    },
    App(value) { definition = value },
    wx: { cloud: null, reLaunch() {} },
    Set,
    Date,
    Promise,
    clearTimeout,
    setTimeout
  }
  vm.runInNewContext(SOURCE, context, { filename: 'miniprogram/app.js' })
  const originalRequestSync = definition.requestSync
  definition.requestSync = function wrappedRequestSync(reason) {
    if (!this.syncPromise) reasons.push(reason)
    return originalRequestSync.call(this, reason)
  }
  return { app: definition, reasons, incrementalReasons }
}

test('首次启动同步一次，只有真正从后台回前台才再做一次轻量快照检查', async () => {
  const runtime = loadApp({ pending: false })
  runtime.app.onShow.call(runtime.app)
  await runtime.app.syncPromise
  assert.deepEqual(runtime.reasons, ['app-start'])

  runtime.app.onShow.call(runtime.app)
  await Promise.resolve()
  assert.deepEqual(runtime.reasons, ['app-start'])

  runtime.app.onHide.call(runtime.app)
  await runtime.app.onShow.call(runtime.app)
  assert.deepEqual(runtime.reasons, ['app-start', 'app-foreground'])

  runtime.app.onShow.call(runtime.app)
  await Promise.resolve()
  assert.deepEqual(runtime.reasons, ['app-start', 'app-foreground'])
})

test('退出时有本地队列会先补传，回到前台后再且只再检查一次云端修订号', async () => {
  const runtime = loadApp({ pending: true })
  runtime.app.onShow.call(runtime.app)
  await runtime.app.syncPromise

  runtime.app.onHide.call(runtime.app)
  const foreground = runtime.app.onShow.call(runtime.app)
  await foreground

  assert.deepEqual(runtime.reasons, ['app-start', 'app-foreground'])
  assert.deepEqual(runtime.incrementalReasons, ['app-hide'])
})

test('生命周期实现不使用定时轮询，监听仅限已提交的序号通知', () => {
  assert.doesNotMatch(SOURCE, /setInterval\(/)
  assert.match(SOURCE, /channelId\.startsWith\('sync_head_'\)/)
})

test('尚未创建个人空间时启动不产生后台同步调用', async () => {
  let definition
  let syncCalls = 0
  const context = {
    require(request) {
      if (request === './config/env') return { cloudSyncEnabled: false, clientVersion: 'test' }
      if (request === './utils/api') return { hasPendingQueue: () => false, syncNow: async () => { syncCalls += 1 }, flushDirtyQueueNow: async () => {} }
      if (request === './utils/cache') return { KEYS: { bootstrap: 'bootstrap' }, read: () => ({ onboardingRequired: true, account: null }) }
      throw new Error(`Unexpected require: ${request}`)
    },
    App(value) { definition = value },
    wx: { cloud: null, reLaunch() {} }, Set, Date, Promise, clearTimeout, setTimeout
  }
  vm.runInNewContext(SOURCE, context, { filename: 'miniprogram/app.js' })
  definition.onShow.call(definition)
  await Promise.resolve()
  assert.equal(syncCalls, 0)
})
