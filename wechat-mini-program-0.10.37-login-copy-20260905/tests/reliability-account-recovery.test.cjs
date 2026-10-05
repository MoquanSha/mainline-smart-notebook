const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { scopedClient } = require('./helpers/scoped-client.cjs')
const scope = { userId: 'user', workspaceId: 'A' }
const A = { serverBaseUrl: 'https://A.invalid', token: 'A'.repeat(32) }
const B = { serverBaseUrl: 'https://B.invalid', token: 'B'.repeat(32) }

function fixture(t, syncResult = {}) {
  const requests = [], modals = [], toasts = [], syncs = []
  const r = scopedClient(async () => { throw new Error('cloud forbidden') }, new Map(), {
    request(options) { requests.push(options); options.success({ statusCode: 200, data: { ok: true, data: { scopeProtocol: 1, principal: scope } } }) },
    showModal(options) { modals.push(options) }, showToast(options) { toasts.push(options) }
  }, { cloudSyncEnabled: false })
  r.cache.adoptScope({ account: { user: { id: scope.userId }, workspaceId: scope.workspaceId } })
  r.cache.writeConnection(A)
  const original = r.cache.enqueue('capture.hide', { id: 'note' }, { id: 'old' })
  r.cache.writeConnection(B)
  global.getApp = () => ({ requestSync: async reason => { syncs.push(reason); return typeof syncResult === 'function' ? syncResult() : syncResult } })
  let page
  const source = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/account/index.js'), 'utf8')
  new Function('Page', 'require', source)(value => { page = value }, id => {
    if (id === '../../utils/api') return r.api
    if (id === '../../utils/cache') return r.cache
    if (id === '../../config/env') return { cloudSyncEnabled: false }
    return require(path.join(__dirname, '../miniprogram/pages/account', id))
  })
  page.data = structuredClone(page.data)
  page.setData = function (value, callback) { Object.assign(this.data, value); callback?.() }
  page.onShow()
  t.after(() => r.api.__test.cancelDirtyFlushTimer())
  return { ...r, page, original, requests, modals, toasts, syncs }
}

test('account recovery reviews the old queue, verifies identity and waits for a separate upload action', async t => {
  const r = fixture(t)
  assert.equal(r.page.data.homeRecoveryCount, 1)
  const recovery = r.page.recoverHomeTarget()
  assert.match(r.modals[0].content, /1 条/); assert.match(r.modals[0].content, /https:\/\/B.invalid/)
  assert.equal(r.requests.length, 0)
  r.modals[0].success({ confirm: true }); await recovery
  assert.equal(r.requests.length, 1); assert.equal(r.requests[0].method, 'GET')
  assert.equal(r.syncs.length, 0); assert.equal(r.page.data.homeRecoveryCount, 0)
  assert.match(r.page.data.homeRecoveryMessage, /已确认 1 条.*立即同步/)
  assert.equal(r.cache.read(r.cache.KEYS.queue).length, 1)
})

test('cancelling target review makes no request and does not change the queue', async t => {
  const r = fixture(t)
  const before = structuredClone(r.cache.read(r.cache.KEYS.queue))
  const recovery = r.page.recoverHomeTarget()
  r.modals[0].success({ confirm: false }); await recovery
  assert.deepEqual(r.cache.read(r.cache.KEYS.queue), before)
  assert.equal(r.requests.length, 0); assert.equal(r.page.data.homeRecovering, false)
})

test('late confirmation from another account or a closed page cannot begin recovery', async t => {
  for (const change of ['account', 'page']) {
    const r = fixture(t)
    const recovery = r.page.recoverHomeTarget()
    if (change === 'account') { r.cache.adoptScope({ account: { user: { id: 'other' }, workspaceId: 'B' } }); r.page.onShow() }
    else r.page.onHide()
    const pageBefore = structuredClone(r.page.data)
    r.modals[0].success({ confirm: true }); await recovery
    assert.deepEqual(r.page.data, pageBefore); assert.equal(r.requests.length, 0)
  }
})

test('changed target between modal and confirmation stays visible with the original operation intact', async t => {
  const r = fixture(t)
  const recovery = r.page.recoverHomeTarget()
  r.cache.writeConnection({ serverBaseUrl: 'https://C.invalid', token: 'C'.repeat(32) })
  r.modals[0].success({ confirm: true }); await recovery
  assert.equal(r.requests.length, 0)
  assert.equal(r.cache.read(r.cache.KEYS.queue)[0].homeTarget, r.original.homeTarget)
  assert.match(r.page.data.homeRecoveryMessage, /连接已更换/)
})

test('manual connection check uses the shared receiver and never claims that an upload-only result completed sync', async t => {
  const r = fixture(t, { remoteFresh: false, receiveError: { code: 'NETWORK', message: '接收连接断开' } })
  const mirror = r.api.flushMirrorQueue
  r.api.flushMirrorQueue = async () => { r.syncs.push('mirror'); return mirror() }
  await r.page.testHomeConnection()
  assert.deepEqual(r.syncs, ['account-connect', 'mirror'])
  assert.match(r.page.data.homeStatus, /同步未完成.*接收连接断开/)
  assert.ok(r.toasts.every(item => !/已连接并同步|已全部同步/.test(item.title)))
  assert.equal(r.page.data.homeTesting, false)
})

test('an old account connection result cannot change the new account page or show success', async t => {
  let finish
  const r = fixture(t, () => new Promise(resolve => { finish = resolve }))
  const request = r.page.testHomeConnection()
  while (!finish) await Promise.resolve()
  r.cache.adoptScope({ account: { user: { id: 'other' }, workspaceId: 'B' } })
  r.page.onShow()
  const before = structuredClone(r.page.data)
  finish({ remoteFresh: true }); await request
  assert.deepEqual(r.page.data, before); assert.equal(r.toasts.length, 0)
  assert.equal(r.cache.readConnection().serverBaseUrl, '')
})

test('local storage failure while approving a target preserves the old queue and displays failure', async t => {
  const r = fixture(t)
  const recovery = r.page.recoverHomeTarget()
  const before = structuredClone(r.cache.read(r.cache.KEYS.queue))
  const write = wx.setStorageSync
  wx.setStorageSync = (key, value) => {
    if (String(key).endsWith('.queue')) throw new Error('disk full')
    return write(key, value)
  }
  r.modals[0].success({ confirm: true }); await recovery
  assert.deepEqual(r.cache.read(r.cache.KEYS.queue), before)
  assert.match(r.page.data.homeRecoveryMessage, /保存|空间|disk full/)
  assert.equal(r.syncs.length, 0)
})
