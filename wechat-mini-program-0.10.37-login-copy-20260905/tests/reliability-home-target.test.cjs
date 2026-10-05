const test = require('node:test')
const assert = require('node:assert/strict')
const { scopedClient } = require('./helpers/scoped-client.cjs')
const scope = { userId: 'user', workspaceId: 'A' }
function fixture(t, config = {}) {
  const requests = []
  const r = scopedClient(async () => { throw new Error('cloud forbidden') }, new Map(), {
    request(options) {
      requests.push(options)
      options.success({ statusCode: 200, data: { ok: true, data: options.method === 'GET'
        ? { scopeProtocol: 1, principal: scope }
        : { results: (options.data.operations || []).map(op => ({ requestId: op.requestId, ok: true })) } } })
    }
  }, { cloudSyncEnabled: false, manualSyncOnly: true, ...config })
  r.cache.adoptScope({ account: { user: { id: scope.userId }, workspaceId: scope.workspaceId } })
  r.cache.writeConnection({ serverBaseUrl: 'https://A.invalid', token: 'A' })
  t.after(() => r.api.__test.cancelDirtyFlushTimer())
  return { ...r, requests }
}

test('queued work stays attached to the old computer after the connection changes', async t => {
  const r = fixture(t)
  const item = r.cache.enqueue('capture.setFavorite', { id: 'note', favorite: true }, { id: 'old' })
  assert.ok(item.homeTarget)
  r.cache.writeConnection({ serverBaseUrl: 'https://B.invalid', token: 'B' })
  await r.api.flushQueue()
  assert.equal(r.requests.length, 0)
  const queued = r.cache.read(r.cache.KEYS.queue)
  assert.equal(queued.length, 1); assert.equal(queued[0].lastErrorCode, 'HOME_TARGET_CHANGED')
  assert.equal(queued[0].status, 'blocked'); assert.equal(queued[0].homeTarget, item.homeTarget)
})

test('every batch entry carries its original scope alongside the current authenticated header', async t => {
  const r = fixture(t)
  await r.home.batch([{ action: 'capture.hide', requestId: 'old', scope: { userId: 'other', workspaceId: 'B' }, payload: { id: 'note' } }])
  assert.deepEqual(r.requests[0].data.operations[0].scope, { userId: 'other', workspaceId: 'B' })
  assert.deepEqual(JSON.parse(decodeURIComponent(r.requests[0].header['X-Mainline-Scope'])), scope)
  assert.deepEqual(r.requests[0].data.scope, scope)
})

test('explicit target recovery only rebinds the reviewed unchanged operations and retains new work', async t => {
  const r = fixture(t)
  r.cache.enqueue('capture.hide', { id: 'old' }, { id: 'old' })
  r.cache.writeConnection({ serverBaseUrl: 'https://B.invalid', token: 'B' })
  const preview = r.api.previewHomeRecovery()
  r.cache.enqueue('capture.hide', { id: 'later' }, { id: 'later' })
  const result = await r.api.confirmHomeRecovery(preview)
  assert.equal(result.rebound, 1)
  const queue = r.cache.read(r.cache.KEYS.queue)
  assert.equal(queue.length, 2)
  assert.equal(queue.find(op => op.id === 'old').homeTarget, r.cache.attachmentConnectionId())
  assert.equal(r.requests.length, 1, 'recovery only verifies identity; it does not silently upload')
  await r.api.flushQueue()
  assert.equal(r.cache.read(r.cache.KEYS.queue).length, 0)
})

test('changing account or connection while confirming recovery cannot redirect reviewed content', async t => {
  const r = fixture(t)
  r.cache.enqueue('capture.hide', { id: 'old' }, { id: 'old' })
  r.cache.writeConnection({ serverBaseUrl: 'https://B.invalid', token: 'B' })
  const preview = r.api.previewHomeRecovery()
  r.cache.writeConnection({ serverBaseUrl: 'https://C.invalid', token: 'C' })
  await assert.rejects(r.api.confirmHomeRecovery(preview), { code: 'HOME_CONNECTION_CHANGED' })
  assert.equal(r.requests.length, 0)
  assert.notEqual(r.cache.read(r.cache.KEYS.queue)[0].homeTarget, r.cache.attachmentConnectionId())
})

test('unscoped legacy entries cannot be approved as current account data', async t => {
  const r = fixture(t)
  r.cache.write(r.cache.KEYS.queue, [{ id: 'legacy', action: 'capture.hide', payload: { id: 'private' } }])
  const preview = r.api.previewHomeRecovery()
  assert.equal(preview.items.length, 0); assert.equal(preview.unscoped, 1)
  await r.api.confirmHomeRecovery(preview)
  assert.equal(r.cache.read(r.cache.KEYS.queue)[0].scope, undefined)
})

test('coalescing cannot discard an old-target intention with the same record key', t => {
  const r = fixture(t)
  r.cache.enqueue('capture.setFavorite', { id: 'note', favorite: true }, { id: 'A', coalesceKey: 'favorite-note' })
  r.cache.writeConnection({ serverBaseUrl: 'https://B.invalid', token: 'B' })
  r.cache.enqueue('capture.setFavorite', { id: 'note', favorite: false }, { id: 'B', coalesceKey: 'favorite-note' })
  assert.deepEqual(r.cache.read(r.cache.KEYS.queue).map(item => item.id), ['A', 'B'])
})

test('mirror old target is blocked while the cloud destination can still be acknowledged', async t => {
  const r = fixture(t, { cloudSyncEnabled: true, manualSyncOnly: false })
  wx.cloud.callFunction = async ({ data }) => ({ result: { ok: true, data: data.action === 'bootstrap'
    ? { account: { user: { id: scope.userId }, workspaceId: scope.workspaceId } }
    : {} } })
  r.cache.enqueueMirror('capture.hide', { id: 'note' }, { home: true, cloud: true }, { id: 'both' })
  r.cache.writeConnection({ serverBaseUrl: 'https://B.invalid', token: 'B' })
  await r.api.flushMirrorQueue()
  const item = r.cache.read(r.cache.KEYS.mirrorQueue)[0]
  assert.equal(item.pendingCloud, false); assert.equal(item.pendingHome, true)
  assert.equal(item.homeFailure.lastErrorCode, 'HOME_TARGET_CHANGED'); assert.equal(r.requests.length, 0)
})

test('late immediate retry cannot send an already queued operation through a replacement connection', async t => {
  const r = fixture(t)
  await r.api.call('capture.hide', { id: 'note' }, { requestId: 'old' })
  r.cache.writeConnection({ serverBaseUrl: 'https://B.invalid', token: 'B' })
  await assert.rejects(r.api.call('capture.hide', { id: 'note' }, { requestId: 'old', immediateSync: true }), { code: 'HOME_TARGET_CHANGED' })
  assert.equal(r.requests.length, 0); assert.equal(r.cache.read(r.cache.KEYS.queue).length, 1)
})

test('review preserves unknown-owner entries, unrelated conflicts and changed content', async t => {
  const r = fixture(t)
  const conflict = r.cache.enqueue('capture.hide', { id: 'conflict' }, { id: 'conflict' })
  const changed = r.cache.enqueue('capture.hide', { id: 'changed' }, { id: 'changed' })
  r.cache.write(r.cache.KEYS.queue, [{ ...conflict, status: 'blocked', lastErrorCode: 'CONFLICT', lastError: '正文冲突' }, changed,
    { id: 'unknown', action: 'capture.hide', payload: { id: 'unknown' } }])
  r.cache.enqueueMirror('capture.hide', { id: 'mirror' }, { cloud: true, home: true }, { id: 'mirror' })
  const mirror = r.cache.read(r.cache.KEYS.mirrorQueue)[0]
  r.cache.write(r.cache.KEYS.mirrorQueue, [{ ...mirror, cloudFailure: { status: 'blocked', lastErrorCode: 'FORBIDDEN', lastError: '无权上传' },
    homeFailure: { status: 'blocked', lastErrorCode: 'HOME_TARGET_CHANGED' } }])
  r.cache.writeConnection({ serverBaseUrl: 'https://B.invalid', token: 'B' })
  const preview = r.api.previewHomeRecovery()
  r.cache.write(r.cache.KEYS.queue, r.cache.read(r.cache.KEYS.queue).map(item => item.id === 'changed' ? { ...item, payload: { id: 'new-content' } } : item))
  const result = await r.api.confirmHomeRecovery(preview)
  assert.equal(result.rebound, 2); assert.equal(result.skipped, 1); assert.equal(result.unscoped, 1)
  const queue = r.cache.read(r.cache.KEYS.queue)
  assert.equal(queue[0].status, 'blocked'); assert.equal(queue[0].lastErrorCode, 'CONFLICT')
  assert.equal(queue[1].homeTarget, changed.homeTarget); assert.equal(queue[1].payload.id, 'new-content')
  assert.equal(queue[2].scope, undefined)
  const after = r.cache.read(r.cache.KEYS.mirrorQueue)[0]
  assert.equal(after.homeFailure, null); assert.equal(after.lastErrorCode, 'FORBIDDEN'); assert.equal(after.status, 'blocked')
})

test('recovery rejects legacy or foreign computer identity without rebinding', async t => {
  const r = fixture(t)
  const old = r.cache.enqueue('capture.hide', { id: 'old' }, { id: 'old' })
  r.cache.writeConnection({ serverBaseUrl: 'https://B.invalid', token: 'B' })
  for (const data of [{}, { scopeProtocol: 1, principal: { userId: 'foreign', workspaceId: 'B' } }]) {
    wx.request = options => options.success({ statusCode: 200, data: { ok: true, data } })
    await assert.rejects(r.api.confirmHomeRecovery(r.api.previewHomeRecovery()), error => ['HOME_IDENTITY_UNVERIFIED', 'WORKSPACE_MISMATCH'].includes(error.code))
    assert.equal(r.cache.read(r.cache.KEYS.queue)[0].homeTarget, old.homeTarget)
  }
})

test('account or destination changing while recovery verification is in flight leaves the old operation unchanged', async t => {
  for (const change of ['account', 'connection', 'connection-away-and-back']) {
    const r = fixture(t)
    const old = r.cache.enqueue('capture.hide', { id: 'old' }, { id: 'old' })
    r.cache.writeConnection({ serverBaseUrl: 'https://B.invalid', token: 'B' })
    let pending
    wx.request = options => { pending = options }
    const request = r.api.confirmHomeRecovery(r.api.previewHomeRecovery())
    if (change === 'account') r.cache.adoptScope({ account: { user: { id: 'user-B' }, workspaceId: 'B' } })
    else {
      r.cache.writeConnection({ serverBaseUrl: 'https://C.invalid', token: 'C' })
      if (change === 'connection-away-and-back') r.cache.writeConnection({ serverBaseUrl: 'https://B.invalid', token: 'B' })
    }
    pending.success({ statusCode: 200, data: { ok: true, data: { scopeProtocol: 1, principal: scope } } })
    await assert.rejects(request, { code: change === 'account' ? 'STALE_SCOPE' : 'HOME_CONNECTION_CHANGED' })
    if (change === 'account') r.cache.adoptScope({ account: { user: { id: scope.userId }, workspaceId: scope.workspaceId } })
    assert.equal(r.cache.read(r.cache.KEYS.queue)[0].homeTarget, old.homeTarget)
  }
})

test('changing connection between upload chunks never sends old prepared operations to the new computer', async t => {
  const r = fixture(t)
  for (let i = 0; i < 51; i++) r.cache.enqueue('capture.hide', { id: `note-${i}` }, { id: `op-${i}` })
  let calls = 0
  wx.request = options => {
    calls++
    r.cache.writeConnection({ serverBaseUrl: 'https://B.invalid', token: 'B' })
    options.success({ statusCode: 200, data: { ok: true, data: { results: options.data.operations.map(op => ({ requestId: op.requestId, ok: true })) } } })
  }
  await r.api.flushQueue()
  assert.equal(calls, 1); assert.equal(r.cache.read(r.cache.KEYS.queue).length, 51)
})

test('unknown target stays blocked with no requests until reviewed even after ordinary retries', async t => {
  const r = fixture(t)
  r.cache.write(r.cache.KEYS.queue, [{ id: 'legacy', scope, action: 'capture.hide', payload: { id: 'legacy' } }])
  await r.api.flushQueue(); await r.api.flushQueue()
  assert.equal(r.requests.length, 0); assert.equal(r.cache.read(r.cache.KEYS.queue)[0].lastErrorCode, 'HOME_TARGET_REQUIRED')
  await r.api.confirmHomeRecovery(r.api.previewHomeRecovery())
  await r.api.flushQueue()
  assert.equal(r.cache.read(r.cache.KEYS.queue).length, 0)
})
