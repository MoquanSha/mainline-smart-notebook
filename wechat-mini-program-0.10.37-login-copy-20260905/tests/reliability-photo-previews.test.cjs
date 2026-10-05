const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { scopedClient } = require('./helpers/scoped-client.cjs')
const { cloudRuntime } = require('./helpers/cloud-runtime.cjs')
const { createAttachmentPreviews } = require('../miniprogram/utils/attachment-previews')
const owner = (id = 'A') => ({ account: { user: { id: 'u' }, workspaceId: id } })
const photo = (id = 'p') => ({ id, fileID: 'cloud://env/' + id })
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const answer = (references) => ({ files: references.map((ref) => ({ ...ref, url: 'https://photos.test/' + ref.attachmentId, expiresAt: new Date(Date.now() + 600000).toISOString() })) })
function client() {
  const r = scopedClient(async () => { throw new Error('No real network') })
  r.cache.adoptScope(owner()); return r
}

test('visible photo requests coalesce by identity and batch at most 50 without idle polling', async () => {
  const r = client(), calls = [], loader = createAttachmentPreviews({ cache: r.cache, request: async (payload) => { calls.push(payload); return answer(payload.references) } })
  const photos = Array.from({ length: 53 }, (_, i) => photo('p-' + i))
  const [a, b] = await Promise.all([loader.resolve('t', photos), loader.resolve('t', photos)])
  assert.equal(a.length, 53); assert.equal(b.length, 53)
  assert.deepEqual(calls.map((c) => c.references.length), [50, 3])
  assert.ok(a.every((item) => item.url && !item.error))
  await Promise.resolve()
  assert.equal(calls.length, 2)
})

test('preview cache survives recreation, expires, and can be explicitly bypassed after image failure', async () => {
  const r = client(), calls = []; let clock = Date.now()
  const request = async (payload) => { calls.push(payload); return answer(payload.references) }
  await createAttachmentPreviews({ cache: r.cache, request }).resolve('t', [photo()])
  const reopened = createAttachmentPreviews({ cache: r.cache, request, now: () => clock })
  await reopened.resolve('t', [photo()]); assert.equal(calls.length, 1)
  await reopened.resolve('t', [photo()], { force: true }); assert.equal(calls.length, 2)
  clock += 660000
  await reopened.resolve('t', [photo()]); assert.equal(calls.length, 3)
})

test('scope switching rejects late URLs and cannot save them in the next workspace cache', async () => {
  const r = client(), pending = deferred()
  const loader = createAttachmentPreviews({ cache: r.cache, request: () => pending.promise })
  const promise = loader.resolve('t', [photo()]); await Promise.resolve()
  r.cache.adoptScope(owner('B'))
  pending.resolve(answer([{ todoId: 't', attachmentId: 'p', fileID: photo().fileID }]))
  await assert.rejects(promise, { code: 'STALE_SCOPE' })
  assert.ok(![...r.storage.keys()].some((key) => key.includes('%22B%22') && key.includes('attachmentPreviews')))
})

test('unavailable files and request errors retain an explicit photo entry instead of disappearing', async () => {
  for (const fail of [false, true]) {
    const r = client()
    const loader = createAttachmentPreviews({ cache: r.cache, request: async () => { if (fail) throw new Error('网络中断'); return { files: [] } } })
    const rows = await loader.resolve('t', [photo()])
    assert.equal(rows.length, 1); assert.equal(rows[0].id, 'p'); assert.equal(rows[0].url, '')
    assert.ok(rows[0].error)
  }
})

test('repeated view refreshes briefly reuse a failure, while explicit retry can run immediately', async () => {
  const r = client(); let calls = 0
  const loader = createAttachmentPreviews({ cache: r.cache, request: async () => { calls++; throw new Error('暂时断网') } })
  await loader.resolve('t', [photo()]); await loader.resolve('t', [photo()])
  assert.equal(calls, 1)
  await loader.resolve('t', [photo()], { force: true })
  assert.equal(calls, 2)
})

test('pending local files need no cloud request and foreign scoped local files are not shown', async () => {
  const r = client(); let calls = 0
  const loader = createAttachmentPreviews({ cache: r.cache, request: async () => { calls++; throw new Error('No network') } })
  const local = { id: 'p', localFilePath: 'wxfile://saved.jpg', scope: { userId: 'u', workspaceId: 'A' } }
  assert.equal((await loader.resolve('t', [local]))[0].url, local.localFilePath)
  r.cache.adoptScope(owner('B'))
  assert.equal((await loader.resolve('t', [local]))[0].url, '')
  assert.equal(calls, 0)
})

test('actual API loads two historical photos through scoped cloud lookup once, with no queued mutation', async () => {
  const photos = [photo('a'), photo('b')], urls = []
  const cloud = cloudRuntime([{ id: 't', ownerOpenId: 'A', entryKind: 'today_todo', date: '2026-08-06', comments: [{ id: 'c', attachments: photos }] }], {
    getTempFileURL: async ({ fileList }) => { urls.push(fileList); return { fileList: fileList.map(({ fileID }) => ({ fileID, tempFileURL: 'https://files.test/' + encodeURIComponent(fileID) })) } }
  })
  let requests = 0
  const r = scopedClient(async ({ data }) => {
    if (data.action === 'bootstrap') return { result: { ok: true, data: owner() } }
    assert.equal(data.action, 'attachment.previews'); assert.deepEqual(data.scope, { userId: 'u', workspaceId: 'A' }); requests++
    return { result: { ok: true, data: await cloud.api.attachmentPreviews('A', data.payload.references) } }
  })
  r.cache.adoptScope(owner()); await r.api.bootstrap()
  const result = await r.api.loadAttachmentPreviews('t', photos)
  assert.equal(result.length, 2); assert.ok(result.every((p) => p.url))
  await r.api.loadAttachmentPreviews('t', photos)
  assert.equal(requests, 1); assert.equal(urls.length, 1); assert.equal(cloud.metrics.reads, 1)
  assert.equal(cloud.metrics.writes, 0); assert.equal(r.cache.read(r.cache.KEYS.queue).length, 0)
})

test('historical photos with current-environment fileIDs do not require an embedded preview URL', async () => {
  const photos = [
    { id: 'todo-image-1', fileID: 'cloud://YOUR_CLOUDBASE_ENV_ID/todo-image-1' },
    { id: 'todo-image-2', fileID: 'cloud://YOUR_CLOUDBASE_ENV_ID/todo-image-2' }
  ]
  const cloud = cloudRuntime([{ id: 'target', ownerOpenId: 'A', entryKind: 'today_todo', date: '2026-08-06', comments: [{ id: 'comment', attachments: photos }] }], {
    getTempFileURL: async ({ fileList }) => ({
      fileList: fileList.map(({ fileID }) => ({ fileID, tempFileURL: `https://files.test/${encodeURIComponent(fileID)}` }))
    })
  })
  const r = scopedClient(async ({ data }) => {
    if (data.action === 'bootstrap') return { result: { ok: true, data: owner() } }
    assert.equal(data.action, 'attachment.previews')
    return { result: { ok: true, data: await cloud.api.attachmentPreviews('A', data.payload.references) } }
  })
  r.cache.adoptScope(owner())
  await r.api.bootstrap()
  const result = await r.api.loadAttachmentPreviews('target', photos)
  assert.equal(result.length, 2)
  assert.ok(result.every((item) => /^https:\/\//.test(item.url) && !item.error))
  assert.equal(r.cache.read(r.cache.KEYS.queue).length, 0)
})

function component(api, r) {
  let definition
  const previewCalls = []
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/components/photo-gallery/index.js'), 'utf8'), {
    Component(value) { definition = value }, require: (id) => id.endsWith('/api') ? api : r.cache,
    wx: { previewImage(value) { previewCalls.push(value) } }
  })
  const c = { ...definition.methods, data: structuredClone(definition.data),
    properties: { scope: r.cache.scopeToken(), todoId: 't', attachments: [photo()], compact: false },
    setData(value) { Object.assign(this.data, structuredClone(value)) } }
  return { c, definition, previewCalls }
}
const event = { currentTarget: { dataset: { id: 'p' } } }

test('gallery renews a failed URL once, then requires an explicit retry', async () => {
  const r = client(), calls = [], api = { loadAttachmentPreviews: async (id, photos, options) => {
    calls.push(options); return photos.map((p) => ({ ...p, url: 'https://photo.test/' + calls.length, error: '' }))
  } }
  const { c, definition } = component(api, r)
  definition.lifetimes.attached.call(c); await Promise.resolve()
  await c.imageError(event); assert.equal(calls.length, 2); assert.equal(calls[1].force, true)
  await c.imageError(event); assert.equal(calls.length, 2); assert.match(c.data.photos[0].error, /重试/)
  await c.retry(event); assert.equal(calls.length, 3)
})

test('gallery close/hide and workspace changes ignore old URL responses', async () => {
  const r = client(), pending = deferred()
  const { c, definition } = component({ loadAttachmentPreviews: () => pending.promise }, r)
  definition.lifetimes.attached.call(c)
  definition.pageLifetimes.hide.call(c)
  pending.resolve([{ ...photo(), url: 'https://private-A.test', error: '' }]); await Promise.resolve(); await Promise.resolve()
  assert.ok(!c.data.photos.some((p) => p.url))
  r.cache.adoptScope(owner('B'))
  definition.pageLifetimes.show.call(c); await Promise.resolve()
  assert.deepEqual(c.data.photos, [])
})

test('new-scope gallery never reuses the prior account image while waiting for its response', async () => {
  const r = client(), pending = deferred()
  const { c, definition } = component({ loadAttachmentPreviews: () => pending.promise }, r)
  c.active = true; c.renewed = new Set(); c.signature = 'old'
  c.data.photos = [{ ...photo(), url: 'https://A-private.test' }]
  r.cache.adoptScope(owner('B')); c.properties.scope = r.cache.scopeToken()
  const waiting = c.refresh()
  assert.equal(c.data.photos[0].url, '')
  definition.lifetimes.detached.call(c)
  pending.resolve([{ ...photo(), url: 'https://B-private.test' }]); await waiting
  assert.equal(c.data.photos[0].url, '')
})

test('an old preview click cannot open a same-ID photo after a workspace switch', async () => {
  const r = client(), pending = deferred(); let calls = 0
  const { c, definition, previewCalls } = component({ loadAttachmentPreviews: () => {
    calls++
    return calls === 1 ? pending.promise : Promise.resolve([{ ...photo(), url: 'https://B-private.test' }])
  } }, r)
  c.active = true; c.renewed = new Set()
  const preview = c.preview(event)
  r.cache.adoptScope(owner('B')); c.properties.scope = r.cache.scopeToken()
  await c.refresh()
  pending.resolve([{ ...photo(), url: 'https://A-private.test' }]); await preview
  assert.equal(previewCalls.length, 0)
  definition.lifetimes.detached.call(c)
})

