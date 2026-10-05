const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'app.js'), 'utf8')

function loadApp({ pending = false } = {}) {
  let definition
  let syncCalls = 0
  let incrementalCalls = 0
  const api = {
    hasPendingQueue: () => pending,
    syncNow: async () => {
      syncCalls += 1
      return { ok: true }
    },
    flushDirtyQueueNow: async () => {
      incrementalCalls += 1
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
    clearTimeout,
    setTimeout
  }
  vm.runInNewContext(SOURCE, context, { filename: 'miniprogram/app.js' })
  return { app: definition, syncCalls: () => syncCalls, incrementalCalls: () => incrementalCalls }
}

test('退出小程序且没有本地修改时不调用云端', async () => {
  const runtime = loadApp({ pending: false })
  runtime.app.onHide.call(runtime.app)
  await Promise.resolve()
  assert.equal(runtime.syncCalls(), 0)
  assert.equal(runtime.incrementalCalls(), 0)
})

test('退出小程序且存在待同步修改时只触发一次补传', async () => {
  const runtime = loadApp({ pending: true })
  runtime.app.onHide.call(runtime.app)
  await Promise.resolve()
  assert.equal(runtime.syncCalls(), 0)
  assert.equal(runtime.incrementalCalls(), 1)
})
