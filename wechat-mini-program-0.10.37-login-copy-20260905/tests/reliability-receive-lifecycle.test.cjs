const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname, '../miniprogram/app.js'), 'utf8')

function runtime(sync = async () => ({ remoteFresh: true }), options = {}) {
  let app, scope = 'a', nextTimer = 0
  const timers = new Map(), watchers = [], calls = [], events = []
  const progress = { protocol: 2, phase: 'idle', sequence: 5 }
  const cache = {
    KEYS: { bootstrap: 'bootstrap', historyTransfer: 'history' },
    scopeToken: () => { if (options.scopeStorageFailure) throw new Error('本机存储无法读取'); return scope }, currentScope: () => ({ userId: 'u', workspaceId: scope }),
    read: (key) => key === 'history' ? progress : ({ account: { user: { id: 'u' }, workspaceId: scope } })
  }
  const api = { hasPendingQueue: () => false, flushDirtyQueueNow: async () => {},
    syncNow: async (options) => { calls.push({ scope, options }); return sync(options) } }
  const context = {
    App(value) { app = value }, require: (id) => id === './utils/api' ? api : id === './utils/cache' ? cache : { cloudSyncEnabled: true },
    wx: { cloud: { database: () => ({ collection(name) {
      assert.equal(name, 'sync_signals')
      return { where(query) { return { watch(callbacks) {
        const watcher = { callbacks, query, closed: false, close() { this.closed = true } }
        watchers.push(watcher)
        if (options.failOnWatchStart) callbacks.onError(new Error('startup network failure'))
        return watcher
      } } } }
    } }) } },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id },
    clearTimeout(id) { timers.delete(id) }, Set, Date, Promise, Math, String, Number
  }
  vm.runInNewContext(source, context)
  app.appVisible = true
  app.syncListeners.add((event) => events.push(event))
  async function tick(delay) {
    const ready = [...timers].filter(([, timer]) => timer.delay === delay)
    for (const [id, timer] of ready) { timers.delete(id); timer.fn() }
    if (app.syncPromise) await app.syncPromise.catch(() => {})
    await Promise.resolve()
  }
  return { app, watchers, calls, progress, timers, events, tick, switchScope(next) { scope = next } }
}
const signal = (watcher, sequence) => watcher.callbacks.onChange({ docs: [{ sequence }] })

test('an immediate watch startup failure closes the returned handle and keeps one bounded retry', async () => {
  const r = runtime(undefined, { failOnWatchStart: true })
  r.app.startRealtimeSync('sync_head_a', 'a')
  assert.equal(r.watchers[0].closed, true)
  assert.equal(r.app.syncWatcher, null)
  signal(r.watchers[0], 90)
  await r.tick(200)
  assert.equal(r.calls.length, 0)
  assert.equal([...r.timers.values()].filter((timer) => timer.delay === 2000).length, 1)
  await r.tick(2000)
  assert.equal(r.watchers[1].closed, true)
  assert.equal([...r.timers.values()].filter((timer) => timer.delay === 4000).length, 1)
})

test('a queued foreground receive rechecks visibility after the previous request ends', async () => {
  let release, count = 0
  const r = runtime(() => ++count === 1 ? new Promise((resolve) => { release = resolve }) : ({ remoteFresh: true }))
  const first = r.app.requestSync('manual')
  r.app.onHide()
  const foreground = r.app.onShow()
  r.app.onHide()
  release({ remoteFresh: true })
  await first
  await foreground
  await r.app.foregroundSyncPromise
  assert.equal(r.calls.length, 1)
  assert.equal(r.app.foregroundSyncPending, true, 'next foreground must still catch up')
})

test('foreground sequence watch ignores already received changes and coalesces a burst', async () => {
  const r = runtime()
  r.app.startRealtimeSync('sync_head_a', 'a')
  r.app.startRealtimeSync('sync_head_a', 'a')
  assert.equal(r.watchers.length, 1)
  signal(r.watchers[0], 5)
  await r.tick(200)
  assert.equal(r.calls.length, 0)
  signal(r.watchers[0], 6); signal(r.watchers[0], 7)
  await r.tick(200)
  assert.equal(r.calls.length, 1)
  assert.equal(r.calls[0].options.shouldContinue(), true)
  r.progress.sequence = 7
  signal(r.watchers[0], 7)
  await r.tick(200)
  assert.equal(r.calls.length, 1, 'idle notifications never trigger business reads')
  r.app.onHide()
  assert.equal(r.watchers[0].closed, true)
  signal(r.watchers[0], 8)
  await r.tick(200)
  assert.equal(r.calls.length, 1)
})

test('a cloud change arriving during a receive schedules one follow-up instead of disappearing', async () => {
  let release
  let request = 0
  const r = runtime(async () => ++request === 1 ? new Promise((resolve) => { release = resolve }) : ({ remoteFresh: true }))
  r.app.startRealtimeSync('sync_head_a', 'a')
  const receiving = r.app.requestSync('manual')
  signal(r.watchers[0], 8); signal(r.watchers[0], 9)
  release({ remoteFresh: true })
  await receiving
  await r.tick(200)
  assert.equal(r.calls.length, 2)
  await r.tick(200)
  assert.equal(r.calls.length, 2)
})

test('bounded history pages continue only while foreground and stop when complete or failed', async () => {
  let count = 0
  const r = runtime(async () => ({ history: { pending: ++count < 3 }, remoteFresh: count >= 3 }))
  await r.app.requestSync('manual')
  await r.tick(200); await r.tick(200); await r.tick(200)
  assert.equal(r.calls.length, 3)
  assert.ok(r.app.globalData.lastSyncAt)
  const failed = runtime(async () => ({ history: { pending: true, error: { code: 'NETWORK' } }, remoteFresh: false }))
  await failed.app.requestSync()
  await failed.tick(200)
  assert.equal(failed.calls.length, 1)
  assert.equal(failed.app.globalData.lastSyncAt, '')
  const hidden = runtime(async () => ({ history: { pending: true }, remoteFresh: false }))
  await hidden.app.requestSync()
  hidden.app.onHide()
  await hidden.tick(200)
  assert.equal(hidden.calls.length, 1)
})

test('broken watch backs off and background or permission failure stops reconnect attempts', async () => {
  const r = runtime()
  r.app.startRealtimeSync('sync_head_a', 'a')
  r.watchers[0].callbacks.onError(new Error('network lost'))
  assert.ok(r.watchers[0].closed)
  assert.ok([...r.timers.values()].some((timer) => timer.delay === 2000))
  await r.tick(2000)
  assert.equal(r.watchers.length, 2)
  r.watchers[1].callbacks.onError(new Error('network lost again'))
  assert.ok([...r.timers.values()].some((timer) => timer.delay === 4000))
  r.app.onHide()
  await r.tick(4000)
  assert.equal(r.watchers.length, 2)
  assert.equal(r.calls.length, 0)
  const denied = runtime()
  denied.app.startRealtimeSync('sync_head_a', 'a')
  denied.watchers[0].callbacks.onError(new Error('permission denied'))
  assert.equal(denied.timers.size, 0)
})

test('old workspace watcher and completion cannot update new workspace or reuse its connection', async () => {
  let release
  const r = runtime(() => new Promise((resolve) => { release = resolve }))
  r.app.startRealtimeSync('sync_head_a', 'a')
  const request = r.app.requestSync()
  r.switchScope('b')
  r.app.startRealtimeSync('sync_head_b', 'b')
  assert.equal(r.watchers[0].closed, true)
  signal(r.watchers[0], 99)
  release({ remoteFresh: true, history: { pending: true } })
  await request
  await r.tick(250); await r.tick(200)
  assert.equal(r.events.length, 0)
  assert.equal(r.calls.length, 1)
  assert.equal(r.app.globalData.lastSyncAt, '')
  assert.equal(r.watchers[1].query.workspaceId, 'b')
})

test('failed receiving retries with capped backoff without requiring another record change', async () => {
  let fail = true
  const r = runtime(async () => fail ? { remoteFresh: false, history: { pending: true, error: { code: 'HOME_OFFLINE', retryable: true } } } : { remoteFresh: true })
  await r.app.requestSync()
  for (const delay of [2000, 4000, 8000, 16000, 32000, 60000]) {
    assert.equal([...r.timers.values()].filter(timer => timer.delay === delay).length, 1)
    await r.tick(delay)
  }
  fail = false; await r.tick(60000)
  assert.equal(r.app.receiveRetryCount, 0)
  assert.equal(r.app.receiveRetryTimer, null)
  const before = r.calls.length; await r.tick(60000); assert.equal(r.calls.length, before)
})

test('background and target scope changes cancel receive retries; invalid progress never retries', async () => {
  const r = runtime(async () => { throw Object.assign(new Error('offline'), { code: 'HOME_OFFLINE', retryable: true }) })
  await assert.rejects(r.app.requestSync()); r.app.onHide(); await r.tick(2000)
  assert.equal(r.calls.length, 1)
  r.app.appVisible = true; await assert.rejects(r.app.requestSync()); r.switchScope('b'); await r.tick(2000)
  assert.equal(r.calls.length, 2)
  for (const code of ['WORKSPACE_MISMATCH', 'HISTORY_CURSOR_INVALID', 'LOCAL_STORAGE_FULL', 'UNAUTHORIZED']) {
    const blocked = runtime(async () => ({ remoteFresh: false, history: { pending: true, error: { code, retryable: true } } }))
    await blocked.app.requestSync(); await blocked.tick(2000)
    assert.equal(blocked.calls.length, 1)
    assert.equal(blocked.app.receiveRetryTimer, null)
  }
})

test('storage failure during a delayed retry stops safely without an uncaught callback or new request', async () => {
  const options = {}
  const r = runtime(async () => ({ remoteFresh: false, history: { pending: true, error: { code: 'HOME_OFFLINE', retryable: true } } }), options)
  await r.app.requestSync()
  options.scopeStorageFailure = true
  await r.tick(2000)
  assert.equal(r.calls.length, 1)
  assert.equal(r.app.receiveRetryTimer, null)
  assert.equal(r.app.globalData.receiveError, '本机存储无法读取')
})
