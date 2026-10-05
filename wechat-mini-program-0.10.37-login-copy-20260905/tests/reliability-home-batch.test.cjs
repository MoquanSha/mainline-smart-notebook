const test = require('node:test')
const assert = require('node:assert/strict')
const { scopedClient } = require('./helpers/scoped-client.cjs')
const owner = workspaceId => ({ account: { user: { id: 'user' }, workspaceId } })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

function fixture(t, handler) {
  const requests = []
  const r = scopedClient(async () => { throw new Error('unexpected cloud call') }, new Map(), {
    request(options) {
      requests.push(options)
      Promise.resolve().then(() => handler ? handler(options, requests) : ({ results: options.data.operations.map(op => ({ requestId: op.requestId, ok: true })) }))
        .then(data => options.success({ statusCode: 200, data: { ok: true, data } }), error => options.fail({ errMsg: error.message }))
    }
  }, { cloudSyncEnabled: false, manualSyncOnly: true })
  r.cache.adoptScope(owner('A')); r.cache.writeConnection({ serverBaseUrl: 'https://synthetic.invalid', token: 'synthetic' })
  t.after(() => r.api.__test.cancelDirtyFlushTimer())
  return { ...r, requests, enqueue: id => r.cache.enqueue('capture.setFavorite', { id, favorite: true }, { id }), queue: () => r.cache.read(r.cache.KEYS.queue, []) }
}

test('home bulk uses the explicit selection wire action just like a single RPC', async t => {
  const r = fixture(t)
  await r.home.batch([{ action: 'proposal.applyAll', requestId: 'selected', payload: { selections: [{ id: 'a', baseVersion: 1 }] } }])
  assert.equal(r.requests[0].data.operations[0].action, 'proposal.applySelected')
})

test('123 home operations use three bounded requests, keep only failed B and do not remove later D', async t => {
  const started = deferred(), release = deferred()
  const r = fixture(t, async (options, requests) => {
    if (requests.length === 1) { started.resolve(); await release.promise }
    assert.ok(options.data.operations.length <= 50)
    return { results: options.data.operations.map(op => ({ requestId: op.requestId, ok: op.requestId !== 'B', ...(op.requestId === 'B' ? { error: { code: 'SERVER_ERROR', message: 'retry' } } : {}) })) }
  })
  for (let i = 0; i < 123; i++) r.enqueue(i === 51 ? 'B' : String(i))
  const running = r.api.flushDirtyQueueNow(); await started.promise; r.enqueue('later-D'); release.resolve(); await running
  r.api.__test.cancelDirtyFlushTimer()
  assert.deepEqual(r.requests.map(x => x.data.operations.length), [50, 50, 23])
  assert.deepEqual(r.queue().map(op => op.id), ['B', 'later-D'])
})

test('receipt conflicts, legacy receipts, capacity, and revoked authorization stay blocked without automatic retries', async t => {
  const codes = ['REQUEST_ID_CONFLICT', 'LEGACY_RECEIPT', 'RECEIPT_CAPACITY', 'UNAUTHORIZED']
  const r = fixture(t, options => ({ results: options.data.operations.map(op => ({ requestId: op.requestId, ok: false, error: { code: op.requestId, message: '需要核对' } })) }))
  for (const code of codes) r.enqueue(code)
  await r.api.flushDirtyQueueNow(); await r.api.flushDirtyQueueNow()
  assert.equal(r.requests.length, 1); assert.equal(r.queue().length, 4)
  assert.ok(r.queue().every(op => op.status === 'blocked'))
})

test('batch transport preserves the complete partial proposal receipt for the caller', async t => {
  const partial = { applied: 2, failed: 1, results: [{ id: 'a', ok: true }, { id: 'b', ok: false, error: { code: 'CONFLICT', message: 'changed' } }, { id: 'c', ok: true }] }
  const r = fixture(t, options => ({ results: options.data.operations.map(op => ({ requestId: op.requestId, ok: true, data: partial })) }))
  const result = await r.home.batch([{ action: 'proposal.applyAll', payload: { selections: ['a', 'b', 'c'].map(id => ({ id, baseVersion: 1 })) }, requestId: 'bulk' }])
  assert.equal(r.requests.length, 1)
  assert.deepEqual(result.results[0].data, partial)
})

test('switching A to B between home chunks stops further A writes and retains A queue', async t => {
  const started = deferred(), release = deferred()
  const r = fixture(t, async options => { started.resolve(); await release.promise; return { results: options.data.operations.map(op => ({ requestId: op.requestId, ok: true })) } })
  for (let i = 0; i < 70; i++) r.enqueue(String(i))
  const running = r.api.flushDirtyQueueNow(); await started.promise
  r.cache.adoptScope(owner('B')); release.resolve()
  await assert.rejects(running, { code: 'STALE_SCOPE' }); assert.equal(r.requests.length, 1); assert.equal(r.queue().length, 0)
  r.cache.adoptScope(owner('A')); assert.equal(r.queue().length, 70)
})

test('connection loss after the first chunk retains failed and unattempted chunks without sending more requests', async t => {
  const r = fixture(t, (options, requests) => {
    if (requests.length > 1) throw new Error('offline')
    return { results: options.data.operations.map(op => ({ requestId: op.requestId, ok: true })) }
  })
  for (let i = 0; i < 125; i++) r.enqueue(String(i))
  await r.api.flushDirtyQueueNow()
  assert.equal(r.requests.length, 2); assert.equal(r.queue().length, 75)
  assert.deepEqual(r.queue().map(op => op.id), Array.from({ length: 75 }, (_, i) => String(i + 50)))
})
