const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname, '../miniprogram/utils/home-transport.js'), 'utf8')

function runtime(options = {}) {
  let scope = 'A', next = 0
  const connection = { serverBaseUrl: 'https://home.example.test', token: 'synthetic-secret' }
  const tasks = [], timers = new Map(), changes = [], statuses = []
  const context = {
    module: { exports: {} }, require: id => id === './cache' ? {
      scopeToken: () => scope, readConnection: () => connection
    } : {},
    wx: { connectSocket(params) {
      const callbacks = {}
      const task = { params, callbacks, closes: 0,
        onOpen(fn) { callbacks.open = fn }, onMessage(fn) { callbacks.message = fn },
        onError(fn) { callbacks.error = fn }, onClose(fn) { callbacks.close = fn },
        close() { this.closes++; callbacks.close?.({ code: 1000 }) }
      }
      tasks.push(task)
      if (options.failStart) params.fail({ errMsg: 'cannot connect' })
      return task
    } },
    setTimeout(fn, delay) { const id = ++next; timers.set(id, { fn, delay }); return id },
    clearTimeout(id) { timers.delete(id) }, Date, JSON, Math, String, Number, Error
  }
  vm.runInNewContext(source, context)
  const watcher = context.module.exports.watchSocket(e => changes.push(e), (ok, error) => statuses.push({ ok, error }), { revision: 'r0' })
  const emit = (index, data) => tasks[index].callbacks.message({ data: JSON.stringify(data) })
  return { tasks, timers, changes, statuses, watcher, connection, emit,
    switchScope(value) { scope = value },
    tick() { const [id, timer] = [...timers][0]; timers.delete(id); timer.fn(); return timer.delay }
  }
}

test('socket uses header auth, deduplicates revisions, and has no healthy-idle polling', () => {
  const r = runtime()
  assert.equal(r.tasks[0].params.url, 'wss://home.example.test/api/home/socket')
  assert.equal(r.tasks[0].params.header.Authorization, 'Bearer synthetic-secret')
  r.tasks[0].callbacks.open({})
  r.emit(0, { type: 'connected', revision: 'r0' })
  assert.equal(r.changes.length, 0)
  r.emit(0, { type: 'changed', revision: 'r1' }); r.emit(0, { type: 'changed', revision: 'r1' })
  assert.equal(r.changes.length, 1)
  assert.equal(r.statuses.at(-1).ok, true)
  assert.equal(r.timers.size, 0)
  r.watcher.close()
  r.emit(0, { type: 'changed', revision: 'r2' })
  assert.equal(r.changes.length, 1); assert.equal(r.tasks[0].closes, 1)
})

test('a change between snapshot and connection, or during reconnection, triggers catch-up', () => {
  const r = runtime()
  r.emit(0, { type: 'connected', revision: 'r1' })
  assert.equal(r.changes.length, 1)
  r.tasks[0].callbacks.close({ code: 1006 })
  assert.equal(r.tick(), 2000)
  r.emit(1, { type: 'connected', revision: 'r2' })
  assert.equal(r.changes.length, 2)
  r.watcher.close()
})

test('one failed attempt creates one capped backoff even with both error and close callbacks', () => {
  const r = runtime(), delays = []
  for (let i = 0; i < 8; i++) {
    r.tasks[i].callbacks.error({ errMsg: 'network lost' })
    r.tasks[i].callbacks.close({ code: 1006 })
    assert.equal(r.timers.size, 1)
    delays.push(r.tick())
  }
  assert.deepEqual(delays, [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000])
  r.watcher.close(); assert.equal(r.timers.size, 0)
})

test('authentication denial stops reconnection and never accepts a late notification', () => {
  for (const mode of ['message', 'close']) {
    const r = runtime()
    if (mode === 'message') r.emit(0, { type: 'error', code: 'UNAUTHORIZED', message: '连接凭据已失效' })
    else r.tasks[0].callbacks.close({ code: 1008 })
    r.emit(0, { type: 'changed', revision: 'r9' })
    assert.equal(r.changes.length, 0); assert.equal(r.timers.size, 0)
    assert.equal(r.statuses.at(-1).error.retryable, false)
  }
})

test('old scope or replaced connection closes its socket without touching the new UI', () => {
  for (const mode of ['scope', 'connection']) {
    const r = runtime()
    if (mode === 'scope') r.switchScope('B')
    else r.connection.token = 'another-token'
    r.emit(0, { type: 'changed', revision: 'r9' })
    assert.equal(r.changes.length, 0); assert.equal(r.statuses.length, 0)
    assert.equal(r.tasks[0].closes, 1); assert.equal(r.timers.size, 0)
  }
})

test('synchronous startup failure closes the late task and keeps one retry', () => {
  const r = runtime({ failStart: true })
  assert.equal(r.tasks[0].closes, 1)
  assert.equal(r.timers.size, 1)
  r.watcher.close(); assert.equal(r.timers.size, 0)
})

test('invalid notification cannot falsely report a healthy receiver', () => {
  const r = runtime()
  r.emit(0, { type: 'connected' })
  assert.equal(r.changes.length, 0)
  assert.equal(r.statuses.at(-1).ok, false)
  assert.equal(r.timers.size, 1)
  r.watcher.close()
})

test('a policy-denial close after a generic error cancels the already scheduled retry', () => {
  const r = runtime()
  r.tasks[0].callbacks.error({ errMsg: 'connection interrupted' })
  assert.equal(r.timers.size, 1)
  r.tasks[0].callbacks.close({ code: 1008 })
  assert.equal(r.timers.size, 0)
  assert.equal(r.statuses.at(-1).error.retryable, false)
})
