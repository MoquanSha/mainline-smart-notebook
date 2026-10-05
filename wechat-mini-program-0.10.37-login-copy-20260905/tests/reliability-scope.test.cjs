const test = require('node:test')
const assert = require('node:assert/strict')
const { scopedClient } = require('./helpers/scoped-client.cjs')
const ok = (data) => ({ result: { ok: true, data } })
const account = (space) => ({ account: { user: { id: 'user-1' }, workspaceId: space }, syncWorkspaceId: space })

test('switching workspace suspends its pending journal and isolates cached rows', async (t) => {
  let active = 'A'
  const uploads = []
  const c = scopedClient(async ({ data }) => {
    if (data.action === 'workspace.switch') active = data.payload.workspaceId
    if (data.action === 'sync.push') {
      uploads.push({ workspace: active, scope: data.scope })
      return ok({ results: data.payload.operations.map((op) => ({ requestId: op.requestId, ok: true })) })
    }
    return ok(account(active))
  })
  t.after(() => c.api.__test.cancelDirtyFlushTimer())
  await c.api.bootstrap()
  c.cache.write(c.cache.KEYS.journal, { entries: [{ id: 'in-A' }] })
  await c.api.call('journal.create', { content: 'A original' })
  await c.api.call('workspace.switch', { workspaceId: 'B' })
  await c.api.flushDirtyQueueNow()
  assert.deepEqual(uploads, [])
  assert.deepEqual(c.cache.read(c.cache.KEYS.journal, {}), {})
  assert.deepEqual(c.cache.read(c.cache.KEYS.queue, []), [])
  await c.api.call('workspace.switch', { workspaceId: 'A' })
  assert.equal(c.cache.read(c.cache.KEYS.queue, []).length, 1)
  await c.api.flushDirtyQueueNow()
  assert.equal(uploads.length, 1)
  assert.equal(uploads[0].workspace, 'A')
  assert.deepEqual(uploads[0].scope, { userId: 'user-1', workspaceId: 'A' })
})

test('a delayed cloud response from A is rejected after switching to B', async (t) => {
  let active = 'A', release
  const c = scopedClient(async ({ data }) => {
    if (data.action === 'journal.overview') return new Promise((resolve) => { release = () => resolve(ok({ entries: [{ id: 'A' }] })) })
    if (data.action === 'workspace.switch') active = data.payload.workspaceId
    return ok(account(active))
  })
  t.after(() => c.api.__test.cancelDirtyFlushTimer())
  await c.api.bootstrap()
  const pending = c.api.call('journal.overview', {}, { forceRemote: true })
  while (!release) await new Promise((resolve) => setImmediate(resolve))
  await c.api.call('workspace.switch', { workspaceId: 'B' })
  release()
  await assert.rejects(pending, { code: 'STALE_SCOPE' })
})

test('legacy unscoped queue is retained for recovery and never uploaded under a new identity', async (t) => {
  let uploads = 0
  const storage = new Map([['mainline.cloud.v2.queue', [{
    id: 'legacy', action: 'journal.create', payload: { content: 'unknown owner' }
  }]]])
  const c = scopedClient(async ({ data }) => {
    if (data.action === 'sync.push') uploads += 1
    return ok(account('A'))
  }, storage)
  t.after(() => c.api.__test.cancelDirtyFlushTimer())
  await c.api.bootstrap()
  await c.api.flushDirtyQueueNow()
  assert.equal(uploads, 0)
  assert.equal(c.cache.read(c.cache.KEYS.queue, []).length, 0)
  assert.equal(c.cache.quarantinedLegacy().queue[0].id, 'legacy')
})
