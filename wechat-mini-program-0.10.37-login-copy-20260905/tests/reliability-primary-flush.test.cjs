const test = require('node:test')
const assert = require('node:assert/strict')
const { scopedClient } = require('./helpers/scoped-client.cjs')
const owner = workspaceId => ({ account: { user: { id: 'user' }, workspaceId } })
const tick = () => new Promise(resolve => setImmediate(resolve))
async function fixture(t) {
  const requests = []
  const r = scopedClient(() => { throw new Error('Cloud forbidden') }, new Map(), {
    request(options) { requests.push(options) }
  }, { cloudSyncEnabled: false, manualSyncOnly: true })
  r.cache.adoptScope(owner('A')); r.cache.writeConnection({ serverBaseUrl: 'http://synthetic-home', token: 'synthetic' })
  const enqueue = id => r.cache.enqueue('diary.appendInput', { inputId: id, date: '2026-09-20', content: id }, { id })
  const reply = options => options.success({ statusCode: 200, data: { ok: true, data: {
    results: options.data.operations.map(op => ({ requestId: op.requestId, ok: true, data: {
      acceptedInputId: op.payload.inputId, day: { date: op.payload.date, version: 1,
        manualInputs: [{ id: op.payload.inputId, content: op.payload.content }] }
    } }))
  } } })
  t.after(() => r.api.__test.cancelDirtyFlushTimer())
  return { ...r, requests, enqueue, reply }
}

test('manual and automatic primary flush share one in-flight upload and preserve later input', async t => {
  const r = await fixture(t)
  r.enqueue('first')
  const manual = r.api.flushQueue(); await tick()
  const automatic = r.api.flushDirtyQueueNow(); await tick()
  const requestCount = r.requests.length
  r.enqueue('second')
  for (const request of [...r.requests]) r.reply(request)
  await Promise.all([manual, automatic])
  assert.equal(requestCount, 1, 'same scoped batch was sent twice before the first receipt')
  assert.deepEqual(r.cache.read(r.cache.KEYS.queue).map(row => row.id), ['second'])
  const next = r.api.flushQueue(); await tick(); r.reply(r.requests.at(-1)); await next
  assert.equal(r.requests.length, 2); assert.equal(r.cache.read(r.cache.KEYS.queue).length, 0)
})

test('switching account does not reuse another account dirty-flush promise or erase its pending data', async t => {
  const r = await fixture(t)
  r.enqueue('account-A'); const a = r.api.flushDirtyQueueNow(); await tick()
  const aRejected = assert.rejects(a, error => error.code === 'STALE_SCOPE')
  r.cache.adoptScope(owner('B')); r.cache.writeConnection({ serverBaseUrl: 'http://synthetic-home', token: 'synthetic-B' })
  r.enqueue('account-B'); const b = r.api.flushDirtyQueueNow()
  const result = b.then(value => ({ value }), error => ({ error }))
  r.reply(r.requests[0]); await aRejected; await tick()
  if (r.requests[1]) r.reply(r.requests[1])
  const completed = await result
  assert.equal(completed.error, undefined)
  assert.equal(r.requests.length, 2)
  assert.equal(r.requests[1].data.scope.workspaceId, 'B')
  assert.equal(r.cache.read(r.cache.KEYS.queue).length, 0)
  r.cache.adoptScope(owner('A'))
  assert.deepEqual(r.cache.read(r.cache.KEYS.queue).map(row => row.id), ['account-A'])
})

test('a lost upload reply releases the shared flush and keeps the same operation available for retry', async t => {
  const r = await fixture(t); r.enqueue('retry')
  const first = r.api.flushQueue(), second = r.api.flushQueue(); await tick()
  r.requests[0].fail({ errMsg: 'lost reply' })
  const outcomes = await Promise.all([first, second])
  assert.equal(r.requests.length, 1); assert.ok(outcomes.every(value => value.remaining === 1))
  const pending = r.cache.read(r.cache.KEYS.queue)[0]
  assert.equal(pending.id, 'retry'); assert.equal(pending.attempts, 1)
  const retry = r.api.flushQueue(); await tick(); r.reply(r.requests[1]); await retry
  assert.equal(r.requests[1].data.operations[0].requestId, r.requests[0].data.operations[0].requestId)
  assert.equal(r.cache.read(r.cache.KEYS.queue).length, 0)
})

test('cloud primary uploads also coalesce manual and automatic requests without repeated sync.push', async t => {
  const { loadClient } = require('./helpers/client.cjs')
  let release, calls = 0
  const wait = new Promise(resolve => { release = resolve })
  const r = loadClient(async ({ data }) => {
    calls++; await wait
    return { result: { ok: true, data: { results: data.payload.operations.map(op => ({
      requestId: op.requestId, ok: true, data: { id: op.payload.id, version: 2 }
    })) } } }
  })
  t.after(() => r.api.__test.cancelDirtyFlushTimer())
  await r.api.call('capture.setFavorite', { id: 'cloud-original', favorite: true })
  const manual = r.api.flushQueue(); await tick()
  const automatic = r.api.flushDirtyQueueNow(); await tick()
  release(); await Promise.all([manual, automatic])
  assert.equal(calls, 1); assert.equal(r.queue().length, 0)
})
