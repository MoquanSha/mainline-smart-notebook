const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { scopedClient } = require('./helpers/scoped-client.cjs')
const owner = (id = 'A') => ({ account: { user: { id: 'u' }, workspaceId: id }, storagePrefix: `users/${id}/todo-comments` })
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const image = (id = 'photo-1') => ({ id, filePath: 'wxfile://temp.jpg', size: 12, fileName: '原图.jpg' })
const event = (value, id = 't') => ({ currentTarget: { dataset: { id, version: 1 } }, detail: { value } })
function runtime(storage = new Map(), platform = {}, config = {}) {
  let saves = 0, uploads = 0
  const r = scopedClient(async () => { throw new Error('No real cloud') }, storage, {
    saveFile({ success }) { saves++; success({ savedFilePath: 'wxfile://saved-' + saves + '.jpg' }) }, ...platform
  }, config)
  r.cache.adoptScope(owner())
  r.cache.write(r.cache.KEYS.bootstrap, owner())
  global.wx.cloud.uploadFile = async ({ cloudPath }) => { uploads++; return { fileID: `cloud://${cloudPath}` } }
  return { ...r, platform: global.wx, counts: () => ({ saves, uploads }) }
}
function page(r) {
  const filename = path.join(__dirname, '../miniprogram/pages/home/index.js')
  const realRequire = createRequire(filename)
  let definition
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page(value) { definition = value }, wx: r.platform,
    getApp: () => ({ subscribeSync: () => () => {} }),
    require: (id) => id === '../../utils/api' ? r.api : id === '../../utils/cache' ? r.cache : realRequire(id),
    setTimeout() { return 1 }, clearTimeout() {}
  })
  const p = { ...definition, data: structuredClone(definition.data), setData(value) {
    for (const [key, val] of Object.entries(value)) {
      const parts = key.split('.'); let target = this.data
      for (const part of parts.slice(0, -1)) target = target[part] || (target[part] = {})
      target[parts.at(-1)] = structuredClone(val)
    }
  } }
  p.setData({ todos: [{ id: 't', title: '待办', comments: [] }] })
  p.onShow()
  return p
}

test('failed file persistence rejects rather than presenting a temporary path as saved', async () => {
  const r = runtime(new Map(), { saveFile({ fail }) { fail({ errMsg: 'storage full' }) } })
  await assert.rejects(r.api.uploadImage('t', image(), 'image/jpeg'), /storage full|保存/)
  assert.equal(r.counts().uploads, 0)
})

test('the picker persists scoped files and the complete image draft before returning', async () => {
  const r = runtime()
  r.platform.chooseMedia = async () => ({ tempFiles: [{ tempFilePath: 'wxfile://temp.jpg', size: 12 }] })
  const p = page(r)
  await p.chooseCommentImages(event())
  assert.equal(r.counts().saves, 1)
  const selected = p.data.commentImages.t[0]
  assert.match(selected.filePath, /saved/)
  assert.equal(selected.localFilePath, selected.filePath)
  assert.deepEqual(page(r).data.commentImages.t, p.data.commentImages.t)
  assert.equal(r.counts().uploads, 0, 'choosing a photo does not spend cloud traffic')
  r.cache.adoptScope(owner('B'))
  p.onShow()
  assert.deepEqual(p.data.commentImages, {})
  r.cache.adoptScope(owner('A'))
  p.onShow()
  assert.equal(p.data.commentImages.t[0].id, selected.id)
  p.removePendingImage({ currentTarget: { dataset: { id: 't', imageId: selected.id } } })
  assert.deepEqual(page(r).data.commentImages.t, [])
})

test('a picker result from the previous workspace neither saves nor displays its photos', async () => {
  const r = runtime(), choose = deferred(), p = page(r)
  r.platform.chooseMedia = () => choose.promise
  const running = p.chooseCommentImages(event())
  r.cache.adoptScope(owner('B')); p.onShow()
  choose.resolve({ tempFiles: [{ tempFilePath: 'wxfile://A.jpg', size: 12 }] })
  await running
  assert.equal(r.counts().saves, 0)
  assert.deepEqual(p.data.commentImages, {})
})

test('a late todo mutation receipt cannot rewrite the next workspace', async () => {
  const r = runtime(), p = page(r), reply = deferred()
  p.setData({ todos: [{ id: 't', title: 'A 的待办', status: 'planned', comments: [], version: 1 }] })
  r.api.mutateTodayTodo = () => reply.promise
  const running = p.mutate({ currentTarget: { dataset: { id: 't', action: 'delete', version: 1 } } })
  r.cache.adoptScope(owner('B')); p.onShow()
  reply.resolve({ todos: [{ id: 't', title: 'A 的待办', status: 'planned', comments: [], version: 2 }] })
  await running
  assert.deepEqual(p.data.todos, [])
})

test('a delayed local file save cannot adopt the next workspace or start an upload', async () => {
  let finish
  const r = runtime(new Map(), { saveFile(options) { finish = options.success } })
  const saving = r.api.uploadImage('t', image(), 'image/jpeg')
  r.cache.adoptScope(owner('B'))
  finish({ savedFilePath: 'wxfile://A-saved.jpg' })
  await assert.rejects(saving, { code: 'STALE_SCOPE' })
  assert.equal(r.counts().uploads, 0)
})

test('cloud upload receipt survives a client restart and does not mutate the queued payload', async () => {
  const r = runtime(), descriptor = await r.api.uploadImage('t', image(), 'image/jpeg')
  const payload = { todoId: 't', attachments: [descriptor] }, original = structuredClone(payload)
  const first = await r.api.__test.preparePayloadForCloud('todayTodo.commentAdd', payload)
  assert.equal(r.counts().uploads, 1)
  assert.deepEqual(payload, original)
  const reopened = runtime(r.storage)
  const replay = await reopened.api.__test.preparePayloadForCloud('todayTodo.commentAdd', payload)
  assert.equal(reopened.counts().uploads, 0)
  assert.equal(replay.attachments[0].fileID, first.attachments[0].fileID)
  assert.equal(replay.attachments[0].createdAt, first.attachments[0].createdAt)
})

test('an attachment cannot reuse an upload receipt in a different workspace', async () => {
  const r = runtime(), descriptor = await r.api.uploadImage('t', image(), 'image/jpeg')
  await r.api.__test.preparePayloadForCloud('todayTodo.commentAdd', { todoId: 't', attachments: [descriptor] })
  r.cache.adoptScope(owner('B')); r.cache.write(r.cache.KEYS.bootstrap, owner('B'))
  await assert.rejects(r.api.__test.preparePayloadForCloud('todayTodo.commentAdd', { todoId: 't', attachments: [descriptor] }), { code: 'WORKSPACE_MISMATCH' })
  assert.equal(r.counts().uploads, 1)
})

test('a cloud receipt cannot be reused for changed file metadata under the same image identity', async () => {
  const r = runtime(), descriptor = await r.api.uploadImage('t', image(), 'image/jpeg')
  await r.api.__test.preparePayloadForCloud('todayTodo.commentAdd', { todoId: 't', attachments: [descriptor] })
  await assert.rejects(r.api.__test.preparePayloadForCloud('todayTodo.commentAdd', {
    todoId: 't', attachments: [{ ...descriptor, localFilePath: 'wxfile://another.jpg', size: 99 }]
  }), { code: 'INPUT_ID_CONFLICT' })
  assert.equal(r.counts().uploads, 1)
})

test('comment submission keeps its durable draft until queued, preserves next typing and unrelated arrivals', async () => {
  const r = runtime(), p = page(r), reply = deferred()
  p.onCommentInput(event('第一段'))
  r.api.mutateTodayTodo = () => reply.promise
  const saving = p.addComment(event())
  assert.equal(page(r).data.commentDrafts.t, '第一段')
  p.onCommentInput(event('新写的第二段'))
  p.setData({ todos: [...p.data.todos, { id: 'received', title: '电脑新数据', comments: [] }] })
  reply.reject(new Error('失败'))
  await saving
  assert.ok(p.data.todos.some((todo) => todo.id === 'received'))
  assert.equal(page(r).data.commentDrafts.t, '新写的第二段')
})

test('retry after reopening uses the identical comment operation and attachment IDs', async () => {
  const r = runtime(), calls = [], p = page(r)
  p.onCommentInput(event('  原文\n'))
  r.api.mutateTodayTodo = async (action, payload) => { calls.push(structuredClone(payload)); throw new Error('回执未收到') }
  await p.addComment(event())
  await page(r).addComment(event())
  assert.equal(calls[0].content, '  原文\n')
  assert.deepEqual(calls[1], calls[0])
})

test('full draft storage never starts a comment upload or discards the visible draft', async () => {
  const r = runtime(), p = page(r); let sent = 0
  p.onCommentInput(event('不能丢'))
  const write = r.cache.write
  r.cache.write = (key, value) => { if (key === r.cache.KEYS.homeDraftState) throw new Error('存储空间不足'); return write(key, value) }
  r.api.mutateTodayTodo = async () => { sent++; return { queued: true } }
  await p.addComment(event())
  assert.equal(sent, 0)
  assert.equal(p.data.commentDrafts.t, '不能丢')
  assert.match(p.data.syncMessage, /存储空间不足/)
})

test('parallel photo preparations share one upload and late old-space receipts are rejected', async () => {
  const r = runtime(), descriptor = await r.api.uploadImage('t', image(), 'image/jpeg'), reply = deferred()
  let calls = 0
  r.platform.cloud.uploadFile = () => { calls++; return reply.promise }
  const payload = { todoId: 't', attachments: [descriptor] }
  const first = r.api.__test.preparePayloadForCloud('todayTodo.commentAdd', payload)
  const second = r.api.__test.preparePayloadForCloud('todayTodo.commentAdd', payload)
  r.cache.adoptScope(owner('B'))
  const a = assert.rejects(first, { code: 'STALE_SCOPE' }), b = assert.rejects(second, { code: 'STALE_SCOPE' })
  reply.resolve({ fileID: 'cloud://A/file.jpg' })
  await Promise.all([a, b])
  assert.equal(calls, 1)
  assert.ok(![...r.storage.entries()].some(([key]) => key.includes('%22B%22') && key.includes('attachmentUploads')))
})

test('a confirmed home photo is reused after restart, without modifying the immutable mutation', async () => {
  const r = runtime(), descriptor = await r.api.uploadImage('t', image(), 'image/jpeg')
  r.cache.writeConnection({ serverBaseUrl: 'https://home.test', token: 'a'.repeat(43) })
  let calls = 0
  r.home.uploadImage = async () => { calls++; return { id: 'home-image', relativePath: 'photo.jpg' } }
  const payload = { todoId: 't', attachments: [descriptor] }, before = structuredClone(payload)
  await r.api.__test.preparePayloadForHome('todayTodo.commentAdd', payload)
  assert.deepEqual(payload, before)
  assert.equal(calls, 1)
  const reopened = runtime(r.storage)
  reopened.home.uploadImage = async () => { calls++; return { id: 'other-home-image' } }
  const replay = await reopened.api.__test.preparePayloadForHome('todayTodo.commentAdd', payload)
  assert.equal(replay.attachments[0].id, 'home-image')
  assert.equal(calls, 1)
  reopened.cache.writeConnection({ serverBaseUrl: 'https://home.test', token: 'b'.repeat(43) })
  await reopened.api.__test.preparePayloadForHome('todayTodo.commentAdd', payload)
  assert.equal(calls, 2, 'a changed home credential cannot reuse a prior destination receipt')
})

test('received upload acknowledgement must be durable before a business mutation is prepared', async () => {
  const r = runtime(), descriptor = await r.api.uploadImage('t', image(), 'image/jpeg'), write = r.cache.write
  r.cache.write = (key, value) => {
    if (String(key).includes('attachmentUploads')) throw new Error('回执存储空间不足')
    return write(key, value)
  }
  await assert.rejects(r.api.__test.preparePayloadForCloud('todayTodo.commentAdd', { todoId: 't', attachments: [descriptor] }), /回执存储空间不足/)
  assert.equal(r.counts().uploads, 1)
})

test('selected photos join the durable mutation and survive reopening without uploading from the editor', async () => {
  const r = runtime(), p = page(r)
  r.platform.chooseMedia = async () => ({ tempFiles: [{ tempFilePath: 'wxfile://temp.jpg', size: 12 }] })
  await p.chooseCommentImages(event())
  const selected = p.data.commentImages.t[0]
  p.onCommentInput(event('照片说明'))
  await p.addComment(event())
  const [queued] = r.cache.read(r.cache.KEYS.queue)
  assert.equal(queued.payload.attachments[0].id, selected.id)
  assert.equal(queued.payload.attachments[0].localFilePath, selected.localFilePath)
  assert.equal(r.counts().saves, 1)
  assert.equal(r.counts().uploads, 0)
  assert.deepEqual(page(r).data.commentImages.t, [])
  assert.equal(page(r).data.commentDrafts.t, '')
  assert.match(p.data.syncMessage, /等待上传/)
})

test('batch response loss retains the original photo operation and reuses its upload on restart', async () => {
  const r = runtime(), p = page(r), sent = []
  r.platform.chooseMedia = async () => ({ tempFiles: [{ tempFilePath: 'wxfile://temp.jpg', size: 12 }] })
  await p.chooseCommentImages(event()); p.onCommentInput(event('原图说明')); await p.addComment(event())
  const [original] = r.cache.read(r.cache.KEYS.queue)
  r.platform.cloud.callFunction = async ({ data }) => {
    if (data.action === 'bootstrap') return { result: { ok: true, data: owner() } }
    sent.push(structuredClone(data)); throw new Error('云端已收到，响应丢失')
  }
  await r.api.bootstrap()
  const first = await r.api.__test.flushCloudQueueBatch([original])
  r.api.__test.settleQueueBatch([original], first.remainingItems)
  assert.equal(r.counts().uploads, 1)
  assert.deepEqual(r.cache.read(r.cache.KEYS.queue)[0].payload, original.payload)
  const reopened = runtime(r.storage)
  reopened.platform.cloud.callFunction = async ({ data }) => {
    if (data.action === 'bootstrap') return { result: { ok: true, data: owner() } }
    sent.push(structuredClone(data))
    return { result: { ok: true, data: { results: data.payload.operations.map((op) => ({ requestId: op.requestId, ok: true, data: { todos: [] } })) } } }
  }
  await reopened.api.bootstrap()
  const queue = reopened.cache.read(reopened.cache.KEYS.queue)
  const replay = await reopened.api.__test.flushCloudQueueBatch(queue)
  reopened.api.__test.settleQueueBatch(queue, replay.remainingItems)
  assert.equal(reopened.counts().uploads, 0)
  assert.equal(reopened.cache.read(reopened.cache.KEYS.queue).length, 0)
  assert.deepEqual(sent[1].payload.operations, sent[0].payload.operations)
})

test('file save failure during multi-select retains the photos already saved and tells the user', async () => {
  let saves = 0
  const r = runtime(new Map(), { saveFile({ success, fail }) { if (++saves === 1) success({ savedFilePath: 'wxfile://first.jpg' }); else fail({ errMsg: 'storage full' }) } })
  const messages = []
  r.platform.showToast = (value) => messages.push(value)
  r.platform.chooseMedia = async () => ({ tempFiles: [{ tempFilePath: 'wxfile://first-temp.jpg', size: 12 }, { tempFilePath: 'wxfile://second-temp.jpg', size: 12 }] })
  const p = page(r)
  await p.chooseCommentImages(event())
  assert.equal(page(r).data.commentImages.t.length, 1)
  assert.equal(page(r).data.commentImages.t[0].localFilePath, 'wxfile://first.jpg')
  assert.match(messages[0].title, /storage full/)
  assert.equal(r.counts().uploads, 0)
})

test('success for a prior comment preserves newly added images and text through reopening', async () => {
  const r = runtime(), p = page(r), reply = deferred()
  r.platform.chooseMedia = async () => ({ tempFiles: [{ tempFilePath: 'wxfile://one.jpg', size: 12 }] })
  await p.chooseCommentImages(event()); p.onCommentInput(event('第一条'))
  r.api.mutateTodayTodo = () => reply.promise
  const saving = p.addComment(event())
  await Promise.resolve(); await Promise.resolve()
  p.onCommentInput(event('下一条'))
  await p.chooseCommentImages(event())
  const newId = p.data.commentImages.t[1].id
  reply.resolve({ queued: true }); await saving
  assert.equal(page(r).data.commentDrafts.t, '下一条')
  assert.deepEqual(page(r).data.commentImages.t.map((item) => item.id), [newId])
})

test('an old environment file ID is uploaded to the active environment even when its path matches', async () => {
  const r = runtime(new Map(), {}, { envId: 'new-env' })
  const descriptor = await r.api.uploadImage('t', image(), 'image/jpeg')
  const cloudPath = 'users/A/todo-comments/t/photo-1.jpg'
  let calls = 0
  r.platform.cloud.uploadFile = async () => { calls++; return { fileID: 'cloud://new-env.bucket/' + cloudPath } }
  const payload = { todoId: 't', attachments: [{ ...descriptor, cloudPath, fileID: 'cloud://old-env.bucket/' + cloudPath }] }
  const result = await r.api.__test.preparePayloadForCloud('todayTodo.commentAdd', payload)
  assert.equal(calls, 1)
  assert.match(result.attachments[0].fileID, /^cloud:\/\/new-env\./)
})
