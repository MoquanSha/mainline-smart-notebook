const test = require('node:test')
const assert = require('node:assert/strict')
const { scopedClient } = require('./helpers/scoped-client.cjs')
const feedback = require('../miniprogram/utils/sync-feedback')

const owner = (workspaceId = 'A') => ({ account: { user: { id: 'user-1' }, workspaceId } })
const ok = (data = {}) => ({ result: { ok: true, data } })
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function client({ cloud, home, config = {}, storage = new Map() } = {}) {
  const calls = [], homeCalls = []
  const current = scopedClient(async ({ data }) => {
    calls.push(data)
    if (data.action === 'bootstrap') return ok(owner())
    if (data.action === 'todayTodo.list') return ok({ todos: [] })
    return cloud ? cloud(data) : ok({})
  }, storage, {
    request(options) {
      homeCalls.push(options.data)
      Promise.resolve().then(() => home ? home(options.data) : {}).then(
        (data) => options.success({ statusCode: 200, data: { ok: true, data } }),
        (error) => options.fail({ errMsg: error.message }))
    }
  }, { manualSyncOnly: false, ...config })
  current.cache.adoptScope(owner())
  if (config.cloudSyncEnabled !== false) await current.api.bootstrap()
  return { ...current, calls, homeCalls }
}
function enqueue(cache, id, destinations = { cloud: true }) {
  return cache.enqueueMirror('todayTodo.commentAdd',
    { todoId: 'todo-1', commentId: id, content: id, attachments: [], requestId: id },
    destinations, { id })
}

test('mirror IDs can be generated and the 801st entry does not drop unsent input', async () => {
  const { cache } = await client()
  const generated = cache.enqueueMirror('journal.create', { content: '原文' }, { cloud: true })
  assert.ok(generated.requestId)
  assert.deepEqual(generated.scope, cache.currentScope())
  const seed = Array.from({ length: 800 }, (_, index) => ({ ...generated, id: 'seed-' + index }))
  cache.write(cache.KEYS.mirrorQueue, seed)
  enqueue(cache, 'new')
  assert.equal(cache.read(cache.KEYS.mirrorQueue).length, 801)
  assert.equal(cache.read(cache.KEYS.mirrorQueue)[0].id, 'seed-0')
})

test('reusing an operation ID with different input is explicit and keeps the first input', async () => {
  const { cache } = await client()
  const first = enqueue(cache, 'same')
  assert.throws(() => cache.enqueueMirror(first.action, { ...first.payload, content: 'different' }, { cloud: true }, { id: 'same' }),
    { code: 'INPUT_ID_CONFLICT' })
  assert.throws(() => cache.enqueueMirror(first.action, { ...first.payload, content: 'different' }, { home: true }, { id: 'same' }),
    { code: 'INPUT_ID_CONFLICT' })
  cache.enqueue('journal.create', { content: 'first' }, { id: 'primary' })
  assert.throws(() => cache.enqueue('journal.create', { content: 'second' }, { id: 'primary' }),
    { code: 'INPUT_ID_CONFLICT' })
  assert.equal(cache.read(cache.KEYS.mirrorQueue)[0].payload.content, 'same')
})

test('mirror acknowledgement preserves an entry added while the request is in flight', async () => {
  const started = deferred(), reply = deferred()
  const { api, cache } = await client({ cloud: (data) => {
    if (data.action === 'todayTodo.commentAdd') { started.resolve(); return reply.promise }
    return ok()
  } })
  enqueue(cache, 'first')
  const running = api.flushMirrorQueue()
  await started.promise
  enqueue(cache, 'second')
  reply.resolve(ok())
  const result = await running
  assert.equal(result.remaining, 1)
  assert.deepEqual(cache.read(cache.KEYS.mirrorQueue).map((item) => item.requestId), ['second'])
})

test('mirror acknowledgement cannot erase a changed payload with the same ID', async () => {
  const started = deferred(), reply = deferred()
  const { api, cache, homeCalls } = await client({ cloud: () => { started.resolve(); return reply.promise } })
  cache.writeConnection({ serverBaseUrl: 'https://home.test', token: 'token' })
  enqueue(cache, 'first', { cloud: true, home: true })
  const running = api.flushMirrorQueue()
  await started.promise
  cache.write(cache.KEYS.mirrorQueue, cache.read(cache.KEYS.mirrorQueue).map((item) => ({
    ...item, payload: { ...item.payload, content: 'new input' }
  })))
  reply.resolve(ok())
  await running
  assert.equal(cache.read(cache.KEYS.mirrorQueue)[0]?.payload.content, 'new input')
  assert.equal(homeCalls.length, 0)
})

test('disabled manual mode retains mirror work visibly instead of clearing it', async () => {
  const { api, cache, calls } = await client({ config: { manualSyncOnly: true } })
  enqueue(cache, 'kept')
  const before = calls.length
  const result = await api.flushMirrorQueue()
  assert.equal(result.remaining, 1)
  assert.equal(calls.length, before)
  assert.equal(api.hasPendingQueue(), true)
  assert.equal(cache.read(cache.KEYS.mirrorQueue)[0].status, 'blocked')
  assert.match(feedback.fromCache(cache, api.getHybridStatus()).message, /需要处理/)
})

test('cloud-disabled mode retains the cloud destination after acknowledging home', async () => {
  const { api, cache, calls } = await client({ config: { cloudSyncEnabled: false } })
  cache.writeConnection({ serverBaseUrl: 'https://home.test', token: 'test-token' })
  enqueue(cache, 'both', { cloud: true, home: true })
  const result = await api.flushMirrorQueue()
  assert.equal(result.sentHome, 1)
  assert.equal(result.remaining, 1)
  assert.equal(calls.length, 0)
  const item = cache.read(cache.KEYS.mirrorQueue)[0]
  assert.equal(item.pendingCloud, true)
  assert.equal(item.pendingHome, false)
  assert.equal(item.status, 'blocked')
  assert.equal(api.getHybridStatus().pendingCloud, 1)
})

test('unscoped legacy and unknown operations are retained without a network request', async () => {
  const { api, cache, calls } = await client()
  const legacy = enqueue(cache, 'legacy')
  delete legacy.scope
  cache.write(cache.KEYS.mirrorQueue, [legacy, {
    ...legacy, id: 'unknown', requestId: 'unknown', action: 'future.newAction', scope: cache.currentScope()
  }])
  const before = calls.length
  const result = await api.flushMirrorQueue()
  assert.equal(calls.length, before)
  assert.equal(result.remaining, 2)
  assert.ok(cache.read(cache.KEYS.mirrorQueue).every((item) => item.status === 'blocked'))
})

test('cloud permission failure blocks only cloud; home acknowledgement survives retries', async () => {
  const { api, cache, calls, homeCalls } = await client({ cloud: () => ({
    result: { ok: false, error: { code: 'FORBIDDEN', message: '没有权限' } }
  }) })
  cache.writeConnection({ serverBaseUrl: 'https://home.test', token: 'test-token' })
  enqueue(cache, 'both', { cloud: true, home: true })
  await api.flushMirrorQueue()
  const afterFirst = calls.length, homes = homeCalls.length
  await api.flushMirrorQueue()
  assert.equal(calls.length, afterFirst)
  assert.equal(homeCalls.length, homes)
  const [item] = cache.read(cache.KEYS.mirrorQueue)
  assert.equal(item.pendingCloud, true)
  assert.equal(item.pendingHome, false)
  assert.equal(item.cloudStatus, 'blocked')
  assert.match(feedback.fromCache(cache, api.getHybridStatus()).message, /没有权限/)
})

test('old-space response is rejected and does not replace the new-space queue', async () => {
  const started = deferred(), reply = deferred()
  const { api, cache } = await client({ cloud: (data) => {
    if (data.scope.workspaceId === 'A') { started.resolve(); return reply.promise }
    return ok()
  } })
  enqueue(cache, 'A-input')
  const running = api.flushMirrorQueue()
  const oldRejected = assert.rejects(running, { code: 'STALE_SCOPE' })
  await started.promise
  cache.adoptScope(owner('B'))
  enqueue(cache, 'B-input')
  reply.resolve(ok())
  await oldRejected
  assert.deepEqual(cache.read(cache.KEYS.mirrorQueue).map((item) => item.requestId), ['B-input'])
  cache.adoptScope(owner('A'))
  assert.equal(cache.read(cache.KEYS.mirrorQueue)[0].requestId, 'A-input')
})

test('a new-space flush does not join the in-flight old-space flush', async () => {
  const started = deferred(), reply = deferred()
  const { api, cache, calls } = await client({ cloud: (data) => {
    if (data.scope.workspaceId === 'A') { started.resolve(); return reply.promise }
    return ok()
  } })
  enqueue(cache, 'A-input')
  const running = api.flushMirrorQueue()
  const oldRejected = assert.rejects(running, { code: 'STALE_SCOPE' })
  await started.promise
  cache.adoptScope(owner('B'))
  enqueue(cache, 'B-input')
  const next = api.flushMirrorQueue()
  await new Promise((resolve) => setImmediate(resolve))
  const reachedB = calls.some((data) => data.action === 'todayTodo.commentAdd' && data.scope?.workspaceId === 'B')
  reply.resolve(ok())
  await Promise.allSettled([oldRejected, next])
  assert.equal(reachedB, true)
  assert.equal(cache.read(cache.KEYS.mirrorQueue).length, 0)
})

test('each destination is checkpointed before another destination or account can interrupt', async () => {
  const started = deferred(), reply = deferred()
  const { api, cache } = await client({ home: (data) => {
    if (data.action === 'todayTodo.commentAdd') { started.resolve(); return reply.promise }
    return { todos: [] }
  } })
  cache.writeConnection({ serverBaseUrl: 'https://home.test', token: 'test-token' })
  enqueue(cache, 'both', { cloud: true, home: true })
  const running = api.flushMirrorQueue()
  const oldRejected = assert.rejects(running, { code: 'STALE_SCOPE' })
  await started.promise
  assert.equal(cache.read(cache.KEYS.mirrorQueue)[0].pendingCloud, false)
  cache.adoptScope(owner('B'))
  reply.resolve({})
  await oldRejected
  cache.adoptScope(owner('A'))
  assert.equal(cache.read(cache.KEYS.mirrorQueue)[0].pendingCloud, false)
  assert.equal(cache.read(cache.KEYS.mirrorQueue)[0].pendingHome, true)
})

test('delayed home cache warming cannot send old-space data to the new connection', async () => {
  const { api, cache, homeCalls } = await client()
  cache.writeConnection({ serverBaseUrl: 'https://home-A.test', token: 'A' })
  await api.call('todayTodo.list')
  cache.adoptScope(owner('B'))
  cache.writeConnection({ serverBaseUrl: 'https://home-B.test', token: 'B' })
  await new Promise((resolve) => setTimeout(resolve, 130))
  assert.equal(homeCalls.length, 0)
})

test('a rejected old-space cloud request cannot start quota fallback in the new space', async () => {
  const started = deferred(), reply = deferred()
  const { api, cache, homeCalls } = await client({ cloud: () => { started.resolve(); return reply.promise } })
  const running = api.__test.transportRpc('journal.create', { id: 'A-input', content: 'A input' })
  const oldRejected = assert.rejects(running, { code: 'STALE_SCOPE' })
  await started.promise
  cache.adoptScope(owner('B'))
  cache.writeConnection({ serverBaseUrl: 'https://home-B.test', token: 'B' })
  reply.reject(Object.assign(new Error('quota exhausted'), { code: 'InsufficientBalance' }))
  await oldRejected
  assert.equal(homeCalls.length, 0)
  assert.equal(cache.readHybridState().quotaBlocked, false)
})

test('quota recovery cannot update the new-space cache or transport state', async () => {
  const { api, cache } = await client()
  cache.writeHybridState({ quotaBlocked: true, mode: 'home' })
  const started = deferred(), reply = deferred()
  wx.cloud.callFunction = () => { started.resolve(); return reply.promise }
  const running = api.maybeRecoverCloud({ force: true })
  const rejected = assert.rejects(running, { code: 'STALE_SCOPE' })
  await started.promise
  cache.adoptScope(owner('B'))
  cache.writeHybridState({ mode: 'local', quotaBlocked: false })
  reply.resolve(ok(owner('A')))
  await rejected
  assert.equal(cache.readHybridState().mode, 'local')
  assert.equal(cache.read(cache.KEYS.bootstrap, null), null)
})

test('quota recovery rejects a different remote owner before mirroring old-space work', async () => {
  const { api, cache } = await client()
  cache.writeHybridState({ quotaBlocked: true, mode: 'home' })
  enqueue(cache, 'A-input')
  wx.cloud.callFunction = async () => ok(owner('B'))
  const result = await api.maybeRecoverCloud({ force: true })
  assert.equal(result.recovered, false)
  assert.equal(result.code, 'WORKSPACE_MISMATCH')
  assert.equal(cache.read(cache.KEYS.bootstrap).account.workspaceId, 'A')
  assert.equal(cache.read(cache.KEYS.mirrorQueue).length, 1)
})

test('home RPC and batch responses cannot outlive the account that initiated them', async () => {
  for (const method of ['rpc', 'batch']) {
    const { cache, home } = await client()
    cache.writeConnection({ serverBaseUrl: 'https://home-A.test', token: 'A' })
    let request
    wx.request = (options) => { request = options }
    const running = method === 'rpc' ? home.rpc('todayTodo.list') : home.batch([{ action: 'journal.create', payload: { content: 'A' } }])
    const rejected = assert.rejects(running, { code: 'STALE_SCOPE' })
    cache.adoptScope(owner('B'))
    request.success({ statusCode: 200, data: { ok: true, data: {} } })
    await rejected
  }
})

test('home image reading stops before upload if account changes while reading the file', async () => {
  const { cache, home, homeCalls } = await client()
  cache.writeConnection({ serverBaseUrl: 'https://home-A.test', token: 'A' })
  let read
  wx.getFileSystemManager = () => ({ readFile(options) { read = options } })
  const running = home.uploadImage('todo-A', { localFilePath: 'saved-A.jpg' }, 'image/jpeg')
  const rejected = assert.rejects(running, { code: 'STALE_SCOPE' })
  cache.adoptScope(owner('B'))
  read.success({ data: new ArrayBuffer(4) })
  await rejected
  assert.equal(homeCalls.length, 0)
})

test('connection validation does not save an old-account server to the new account', async () => {
  const { api, cache } = await client()
  let request
  wx.request = (options) => { request = options }
  const running = api.testHomeConnection({ serverBaseUrl: 'https://home-A.test', token: 'A' })
  const rejected = assert.rejects(running, { code: 'STALE_SCOPE' })
  cache.adoptScope(owner('B'))
  request.success({ statusCode: 200, data: { ok: true, data: {} } })
  await rejected
  assert.equal(cache.readConnection().serverBaseUrl, '')
})

test('old-account home watch closes without delivering status or data to new pages', async () => {
  const { cache, home } = await client()
  cache.writeConnection({ serverBaseUrl: 'https://home-A.test', token: 'A' })
  let request, aborted = 0, changes = 0, statuses = 0
  wx.request = (options) => { request = options; return { abort() { aborted += 1 } } }
  const handle = home.watch(() => { changes += 1 }, () => { statuses += 1 })
  cache.adoptScope(owner('B'))
  request.success({ statusCode: 200, data: { ok: true, data: { changed: true, revision: 'A' } } })
  assert.equal(changes, 0)
  assert.equal(statuses, 0)
  assert.equal(aborted, 1)
  handle.close()
})

test('same-space concurrent flushes share one request and an empty queue performs no network work', async () => {
  const started = deferred(), reply = deferred()
  const { api, cache, calls, homeCalls } = await client({ cloud: () => { started.resolve(); return reply.promise } })
  enqueue(cache, 'one')
  const first = api.flushMirrorQueue()
  await started.promise
  const second = api.flushMirrorQueue()
  reply.resolve(ok())
  await Promise.all([first, second])
  assert.equal(calls.filter((item) => item.action === 'todayTodo.commentAdd').length, 1)
  const count = calls.length
  await api.flushMirrorQueue()
  assert.equal(calls.length, count)
  assert.equal(homeCalls.length, 0)
})

test('failed destination is retained across restart and acknowledged destination is not repeated', async () => {
  const storage = new Map()
  const initial = await client({ storage, home: (data) => {
    if (data.action === 'todayTodo.commentAdd') throw new Error('offline')
    return { todos: [] }
  } })
  initial.cache.writeConnection({ serverBaseUrl: 'https://home.test', token: 'token' })
  enqueue(initial.cache, 'durable', { cloud: true, home: true })
  await initial.api.flushMirrorQueue()
  const reopened = await client({ storage })
  const result = await reopened.api.flushMirrorQueue()
  assert.equal(result.sentCloud, 0)
  assert.equal(result.sentHome, 1)
  assert.equal(result.remaining, 0)
  assert.equal(reopened.calls.filter((item) => item.action !== 'bootstrap').length, 0)
})

test('A and C acknowledgements leave only B pending after a transient failure', async () => {
  const { api, cache, calls } = await client({ cloud: (data) => data.payload.commentId === 'B'
    ? Promise.reject(Object.assign(new Error('network'), { code: 'NETWORK_ERROR' })) : ok() })
  for (const id of ['A', 'B', 'C']) enqueue(cache, id)
  const result = await api.flushMirrorQueue()
  assert.equal(result.sentCloud, 2)
  assert.deepEqual(calls.filter((item) => item.action === 'todayTodo.commentAdd').map((item) => item.requestId), ['A', 'B', 'C'])
  assert.deepEqual(cache.read(cache.KEYS.mirrorQueue).map((item) => item.requestId), ['B'])
})

test('permission error is retried only explicitly after the cause has been corrected', async () => {
  let deny = true
  const { api, cache, calls } = await client({ cloud: () => deny
    ? { result: { ok: false, error: { code: 'FORBIDDEN', message: '权限已变化' } } } : ok() })
  enqueue(cache, 'blocked')
  await api.flushMirrorQueue()
  const before = calls.length
  deny = false
  await api.flushMirrorQueue()
  assert.equal(calls.length, before)
  await api.flushMirrorQueue({ retryBlocked: true })
  assert.equal(cache.read(cache.KEYS.mirrorQueue).length, 0)
})

test('a failed receipt checkpoint keeps the operation durable and stops further destinations', async () => {
  const { api, cache, homeCalls } = await client()
  cache.writeConnection({ serverBaseUrl: 'https://home.test', token: 'token' })
  enqueue(cache, 'checkpoint', { cloud: true, home: true })
  const write = wx.setStorageSync
  wx.setStorageSync = (key, value) => {
    if (key.endsWith('.mirrorQueue')) throw Object.assign(new Error('disk full'), { code: 'LOCAL_STORAGE_FULL' })
    return write(key, value)
  }
  try {
    await assert.rejects(api.flushMirrorQueue(), (error) => String(error.code).startsWith('LOCAL_STORAGE_'))
    assert.equal(cache.read(cache.KEYS.mirrorQueue)[0].pendingCloud, true)
    assert.equal(homeCalls.length, 0)
  } finally { wx.setStorageSync = write }
})

test('delayed home warming is cancelled when the connection changes within the same account', async () => {
  const { api, cache, homeCalls } = await client()
  cache.writeConnection({ serverBaseUrl: 'https://old-home.test', token: 'old' })
  await api.call('todayTodo.list')
  cache.writeConnection({ serverBaseUrl: 'https://new-home.test', token: 'new' })
  await new Promise((resolve) => setTimeout(resolve, 130))
  assert.equal(homeCalls.length, 0)
  assert.equal(cache.readHybridState().homeReachable, null)
})

test('home watch backs off on transient errors and stops on a permission error', async () => {
  const { cache, home } = await client()
  cache.writeConnection({ serverBaseUrl: 'https://home.test', token: 'token' })
  const timers = [], requests = []
  const oldTimer = global.setTimeout, oldClear = global.clearTimeout
  let aborted = 0
  global.setTimeout = (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer }
  global.clearTimeout = () => {}
  wx.request = (options) => { requests.push(options); return { abort() { aborted += 1 } } }
  let handle
  try {
    handle = home.watch(() => {})
    requests[0].fail({ errMsg: 'offline' })
    assert.equal(timers[0].delay, 2000)
    timers[0].fn()
    requests[1].fail({ errMsg: 'offline' })
    assert.equal(timers[1].delay, 4000)
    timers[1].fn()
    requests[2].success({ statusCode: 403, data: { ok: false, error: { code: 'FORBIDDEN', message: 'denied' } } })
    assert.equal(timers.length, 2)
    assert.equal(aborted, 1)
  } finally {
    handle?.close()
    global.setTimeout = oldTimer
    global.clearTimeout = oldClear
  }
})

test('synchronous denied home watch closes the handle returned after its error callback', async () => {
  const { cache, home } = await client()
  cache.writeConnection({ serverBaseUrl: 'https://home.test', token: 'token' })
  let aborted = 0
  wx.request = (options) => {
    options.success({ statusCode: 403, data: { ok: false, error: { code: 'FORBIDDEN' } } })
    return { abort() { aborted += 1 } }
  }
  const handle = home.watch(() => {})
  assert.equal(aborted, 1)
  handle.close()
})

test('an HTTP authentication failure without JSON detail is terminal for home requests', async () => {
  const { cache, home } = await client()
  cache.writeConnection({ serverBaseUrl: 'https://home.test', token: 'token' })
  wx.request = (options) => options.success({ statusCode: 401, data: '' })
  await assert.rejects(home.rpc('todayTodo.list'), { code: 'UNAUTHORIZED', retryable: false })
})
