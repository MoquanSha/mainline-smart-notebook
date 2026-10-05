const test = require('node:test')
const assert = require('node:assert/strict')
const { loadClient } = require('./helpers/client.cjs')

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}
function reply(operations, failed = '') {
  return { result: { ok: true, data: { results: operations.map((op) => (
    op.payload.id === failed
      ? { requestId: op.requestId, ok: false, error: { code: 'SERVER_ERROR', message: 'try again' } }
      : { requestId: op.requestId, ok: true, data: { id: op.payload.id, version: 2 } }
  )) } } }
}
function cleanup(t, api) { t.after(() => api.__test.cancelDirtyFlushTimer?.()) }

test('a receipt never removes a new journal operation queued while uploading', async (t) => {
  const entered = deferred(), release = deferred()
  const client = loadClient(async ({ data }) => {
    entered.resolve()
    await release.promise
    return reply(data.payload.operations)
  })
  cleanup(t, client.api)
  await client.api.call('capture.setFavorite', { id: 'A', favorite: true })
  const flush = client.api.flushDirtyQueueNow()
  await entered.promise
  await client.api.call('capture.setFavorite', { id: 'B', favorite: true })
  release.resolve()
  await flush
  assert.deepEqual(client.queue().map((op) => op.payload.id), ['B'])
})

test('a failed obsolete coalesced operation cannot replace a newer user choice', async (t) => {
  const entered = deferred(), release = deferred()
  const client = loadClient(async ({ data }) => {
    entered.resolve()
    await release.promise
    return reply(data.payload.operations, 'A')
  })
  cleanup(t, client.api)
  await client.api.call('capture.setFavorite', { id: 'A', favorite: true })
  const oldId = client.queue()[0].id
  const flush = client.api.flushDirtyQueueNow()
  await entered.promise
  await client.api.call('capture.setFavorite', { id: 'A', favorite: false })
  release.resolve()
  await flush
  assert.equal(client.queue().length, 1)
  assert.notEqual(client.queue()[0].id, oldId)
  assert.equal(client.queue()[0].payload.favorite, false)
})

test('partial batch acknowledgement keeps only B when A and C succeeded', async (t) => {
  const client = loadClient(async ({ data }) => reply(data.payload.operations, 'B'))
  cleanup(t, client.api)
  for (const id of ['A', 'B', 'C']) await client.api.call('capture.setFavorite', { id, favorite: true })
  await client.api.flushDirtyQueueNow()
  assert.deepEqual(client.queue().map((op) => op.payload.id), ['B'])
  assert.equal(client.queue()[0].attempts, 1)
  assert.equal(client.queue()[0].lastErrorCode, 'SERVER_ERROR')
})

test('permission failure remains recoverable locally without automatic resubmission', async (t) => {
  let calls = 0
  const client = loadClient(async ({ data }) => {
    calls += 1
    return { result: { ok: true, data: { results: data.payload.operations.map((op) => ({
      requestId: op.requestId, ok: false, error: { code: 'FORBIDDEN', message: 'membership revoked' }
    })) } } }
  })
  cleanup(t, client.api)
  await client.api.call('capture.setFavorite', { id: 'A', favorite: true })
  await client.api.flushDirtyQueueNow()
  await client.api.flushDirtyQueueNow()
  assert.equal(calls, 1)
  assert.equal(client.queue().length, 1)
  assert.equal(client.queue()[0].status, 'blocked')
  assert.equal(client.queue()[0].lastErrorCode, 'FORBIDDEN')
})

test('receipt and validation failures are blocked instead of retrying forever', async (t) => {
  for (const code of ['REQUEST_ID_CONFLICT', 'LEGACY_RECEIPT', 'RECEIPT_CAPACITY', 'SELECTION_REQUIRED']) {
    let calls = 0
    const client = loadClient(async ({ data }) => {
      calls += 1
      return { result: { ok: true, data: { results: data.payload.operations.map((op) => ({
        requestId: op.requestId, ok: false, error: { code, message: code }
      })) } } }
    })
    cleanup(t, client.api)
    await client.api.call('capture.setFavorite', { id: `blocked-${code}`, favorite: true })
    await client.api.flushDirtyQueueNow()
    await client.api.flushDirtyQueueNow()
    assert.equal(calls, 1, `${code} must not be retried automatically`)
    assert.equal(client.queue()[0].status, 'blocked')
    assert.equal(client.queue()[0].lastErrorCode, code)
  }
})
