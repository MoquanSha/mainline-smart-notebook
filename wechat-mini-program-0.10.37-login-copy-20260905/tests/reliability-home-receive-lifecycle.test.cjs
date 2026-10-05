const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname, '../miniprogram/app.js'), 'utf8')
function runtime(sync = async () => ({ remoteFresh: true }), options = {}) {
  let app, scope = 'A', target = 'computer-A', nextTimer = 0
  const timers = new Map(), watchers = [], calls = []
  const api = { hasPendingQueue: () => false, flushDirtyQueueNow: async () => {},
    syncNow: async value => { calls.push({ scope, target }); return sync(value) },
    watchHomeChanges(change, status, params) {
      const watcher = { change, status, params, closed: false, close() { this.closed = true } }
      watchers.push(watcher)
      if (options.startupDenied) status(false, { message: '凭据失效', retryable: false })
      return watcher
    }
  }
  vm.runInNewContext(source, {
    App(value) { app = value }, require: id => id === './utils/api' ? api : id === './utils/cache' ? {
      KEYS: { bootstrap: 'bootstrap' }, scopeToken: () => scope, attachmentConnectionId: () => target,
      read: () => ({ account: { user: { id: 'user' }, workspaceId: scope } })
    } : { cloudSyncEnabled: true },
    wx: {}, setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id },
    clearTimeout(id) { timers.delete(id) }, Date, Set, String, Number, Promise, Math
  })
  app.appVisible = true
  return { app, watchers, calls, timers, scope(value) { scope = value }, target(value) { target = value },
    async tick(delay) {
      for (const [id, value] of [...timers]) if (value.delay === delay) { timers.delete(id); value.fn() }
      await app.syncPromise?.catch(() => {}); await Promise.resolve()
    }
  }
}

test('foreground home notifications replace the cloud watch, deduplicate startup and coalesce changes', async () => {
  const r = runtime()
  const cloudWatcher = { closed: false, close() { this.closed = true } }
  r.app.syncWatcher = cloudWatcher
  r.app.startHomeRealtimeSync({ revision: 'r0' }); r.app.startHomeRealtimeSync({ revision: 'r1' })
  assert.equal(cloudWatcher.closed, true); assert.equal(r.watchers.length, 1)
  assert.equal(r.watchers[0].params.socket, true)
  r.watchers[0].status(true)
  r.watchers[0].change({ revision: 'r1' }); r.watchers[0].change({ revision: 'r2' })
  await r.tick(200)
  assert.equal(r.calls.length, 1); assert.equal(r.app.globalData.realtimeConnected, true)
  r.app.onHide(); assert.equal(r.watchers[0].closed, true)
  r.watchers[0].change({ revision: 'late' }); r.watchers[0].status(true)
  await r.tick(200)
  assert.equal(r.calls.length, 1); assert.equal(r.app.globalData.realtimeConnected, false)
})

test('switching account or computer makes old callbacks inert before and after replacing the watcher', async () => {
  for (const mode of ['scope', 'target']) {
    const r = runtime(); r.app.startHomeRealtimeSync()
    r[mode]('B')
    r.watchers[0].change({}); r.watchers[0].status(true)
    await r.tick(200); assert.equal(r.calls.length, 0)
    r.app.startHomeRealtimeSync()
    assert.equal(r.watchers[0].closed, true)
    r.watchers[0].change({}); r.watchers[0].status(true)
    await r.tick(200); assert.equal(r.calls.length, 0)
    r.watchers[1].change({}); await r.tick(200)
    assert.equal(r.calls.length, 1)
  }
})

test('changes during an in-flight receive result in a follow-up and survive header timing', async () => {
  let release, count = 0
  const r = runtime(() => ++count === 1 ? new Promise(resolve => { release = resolve }) : ({ remoteFresh: true }))
  r.app.startHomeRealtimeSync({ revision: 'r0' })
  const first = r.app.requestSync()
  r.watchers[0].change({ revision: 'r1' })
  release({ remoteFresh: true }); await first; await r.tick(200)
  assert.equal(r.calls.length, 2)
})

test('immediate permission failure closes the late watcher and does not schedule receiving', async () => {
  const r = runtime(undefined, { startupDenied: true }); r.app.startHomeRealtimeSync()
  assert.equal(r.watchers[0].closed, true); assert.equal(r.app.homeWatcher, null)
  r.watchers[0].change({}); await r.tick(200)
  assert.equal(r.calls.length, 0); assert.equal(r.timers.size, 0)
  assert.equal(r.app.globalData.receiveError, '凭据失效')
})

test('stopping the home watcher rejects its late status without resetting an unrelated healthy cloud watch', () => {
  const r = runtime(); r.app.startHomeRealtimeSync(); const old = r.watchers[0]
  r.app.stopHomeRealtimeSync(); r.app.globalData.realtimeConnected = true
  old.status(false, { message: 'late error' }); old.change({})
  assert.equal(r.app.globalData.realtimeConnected, true)
  assert.equal(r.timers.size, 0)
  r.app.stopHomeRealtimeSync()
  assert.equal(r.app.globalData.realtimeConnected, true)
})
