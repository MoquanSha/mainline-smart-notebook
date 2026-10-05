const test = require('node:test')
const assert = require('node:assert/strict')
const { scopedClient } = require('./helpers/scoped-client.cjs')
const owner = { account: { user: { id: 'user-1' }, workspaceId: 'A' } }
const ok = (data = {}) => ({ result: { ok: true, data } })
async function client(handler) {
  const calls = []
  const current = scopedClient(async ({ data }) => {
    if (data.action === 'bootstrap') return ok(owner)
    calls.push(data)
    return handler(data, calls)
  })
  current.cache.adoptScope(owner)
  await current.api.bootstrap()
  return { ...current, calls }
}
const conflict = (op) => ({ requestId: op.requestId, action: op.action, ok: false,
  error: { code: 'CONFLICT', message: '另一端已修改', latest: { id: 'task-1', title: '电脑的新正文', version: 4 } } })

test('a new mutation cannot enter the queue before account and workspace identity are verified', async () => {
  const c = scopedClient(async () => ({ result: { ok: true, data: {} } }))
  await assert.rejects(c.api.call('capture.setFavorite', { id: 'unbound-note', favorite: true }, { queueOnFailure: true }), { code: 'SCOPE_REQUIRED' })
  assert.deepEqual(c.cache.read(c.cache.KEYS.queue, []), [])
})

test('a body conflict keeps the original base and input; no batch overwrite or repeated automatic request', async () => {
  const c = await client((data) => ok({ results: data.payload.operations.map(conflict) }))
  await c.api.call('task.update', { id: 'task-1', patch: { title: '手机的正文' }, baseVersion: 1 }, { queueOnFailure: true })
  const result = await c.api.flushQueue({ rebase: true, context: { tasks: { tasks: [{ id: 'task-1', version: 4 }] } } })
  assert.equal(c.calls.length, 1)
  assert.equal(c.calls[0].payload.operations[0].payload.baseVersion, 1)
  assert.deepEqual(c.calls[0].payload.operations[0].scope, c.cache.currentScope())
  assert.equal(result.remaining, 1)
  const [pending] = c.cache.read(c.cache.KEYS.queue)
  assert.equal(pending.status, 'blocked')
  assert.equal(pending.payload.baseVersion, 1)
  assert.equal(pending.payload.patch.title, '手机的正文')
  assert.equal(pending.lastErrorCode, 'CONFLICT')
  await c.api.flushQueue()
  assert.equal(c.calls.length, 1)
})

test('a batch carries the immutable operation scope and quarantines foreign or unbound queue entries', async () => {
  const c = await client((data) => ok({ results: data.payload.operations.map((op) => ({ requestId: op.requestId, ok: true, data: {} })) }))
  const valid = c.cache.enqueue('task.update', { id: 'task-1', patch: { title: 'own' }, baseVersion: 1 }, { id: 'own' })
  c.cache.write(c.cache.KEYS.queue, [valid,
    { ...valid, id: 'foreign', scope: { userId: 'user-1', workspaceId: 'B' } },
    { ...valid, id: 'legacy', scope: undefined }])
  await c.api.flushQueue()
  const operations = c.calls.flatMap((call) => call.payload.operations)
  assert.equal(operations.length, 1)
  assert.deepEqual(operations[0].scope, { userId: 'user-1', workspaceId: 'A' })
  assert.deepEqual(c.cache.read(c.cache.KEYS.queue).map((row) => [row.id, row.status]), [['foreign', 'blocked'], ['legacy', 'blocked']])
})

test('additive supplements retain the same record and operation IDs through a conflict retry', async () => {
  const c = await client((data, calls) => ok({ results: data.payload.operations.map((op) => calls.length === 1 ? conflict(op) :
    { requestId: op.requestId, ok: true, data: { id: 'entry-1', version: 5 } }) }))
  await c.api.call('journal.append', { entryId: 'entry-1', content: '  原文\n', baseVersion: 1 }, { queueOnFailure: true })
  const [queued] = c.cache.read(c.cache.KEYS.queue)
  assert.ok(queued.payload.supplementId)
  await c.api.flushQueue()
  assert.equal(c.calls.length, 2)
  const operations = c.calls.map((data) => data.payload.operations[0])
  assert.equal(operations[0].requestId, operations[1].requestId)
  assert.equal(operations[0].payload.supplementId, operations[1].payload.supplementId)
  assert.equal(operations[1].payload.content, '  原文\n')
  assert.deepEqual(operations[1].scope, c.cache.currentScope())
  assert.equal(c.cache.read(c.cache.KEYS.queue).length, 0)
})
