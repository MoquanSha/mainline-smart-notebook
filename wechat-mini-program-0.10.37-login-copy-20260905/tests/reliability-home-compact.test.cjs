const test = require('node:test'), assert = require('node:assert/strict')
const { scopedClient } = require('./helpers/scoped-client.cjs')
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const row = (id, extra = {}) => ({ id, journalDate: date, entryKind: 'journal_entry', content: `原文 ${id}`, rawContent: `原文 ${id}`, version: 1, ...extra })
const overview = (...entries) => ({ entries, favorites: [], history: [], hidden: [] })
const owner = workspaceId => ({ account: { user: { id: 'user' }, workspaceId } })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function client(t, handler) {
  const requests = []
  const r = scopedClient(async () => { throw new Error('unexpected cloud call') }, new Map(), {
    request(options) { requests.push(options); Promise.resolve().then(() => handler(options)).then(data => options.success({ statusCode: 200, data: { ok: true, data } })) }
  }, { cloudSyncEnabled: false, manualSyncOnly: true })
  r.cache.adoptScope(owner('A')); r.cache.writeConnection({ serverBaseUrl: 'https://synthetic.invalid', token: 'synthetic' })
  r.cache.write(r.cache.KEYS.journal, overview(row('a'), row('unrelated')))
  r.cache.write(r.cache.KEYS.confirmedSnapshot, { journal: overview(row('a'), row('unrelated')) })
  t.after(() => r.api.__test.cancelDirtyFlushTimer())
  return { ...r, requests, queue: () => r.cache.read(r.cache.KEYS.queue, []), view: () => r.cache.read(r.cache.KEYS.journal) }
}

test('compact home record is durably merged before removing intent and keeps unrelated history', async t => {
  const r = client(t, () => row('a', { version: 2, favoritedAt: '2026-09-25T01:00:00Z' }))
  await r.api.call('capture.setFavorite', { id: 'a', favorited: true }, { immediateSync: true, requestId: 'favorite' })
  assert.equal(r.requests[0].data.responseMode, 'record-v1'); assert.equal(r.queue().length, 0)
  assert.equal(r.cache.read(r.cache.KEYS.confirmedSnapshot).journal.entries.find(x => x.id === 'a').version, 2)
  assert.ok(r.view().entries.some(x => x.id === 'unrelated')); assert.ok(r.view().favorites.some(x => x.id === 'a'))
})

test('a late compact home record cannot replace a newer body or a newly queued field choice', async t => {
  const started = deferred(), reply = deferred()
  const r = client(t, async () => { started.resolve(); return reply.promise })
  const running = r.api.call('capture.setFavorite', { id: 'a', favorited: true }, { immediateSync: true, requestId: 'old' })
  await started.promise
  r.cache.write(r.cache.KEYS.journal, overview(row('a', { version: 8, content: '等待时收到的新正文', rawContent: '等待时收到的新正文' }), row('unrelated')))
  await r.api.call('capture.setFavorite', { id: 'a', favorited: false }, { requestId: 'new' })
  reply.resolve(row('a', { version: 2, favoritedAt: '2026-09-25T01:00:00Z' })); await running
  assert.equal(r.queue()[0].id, 'new'); assert.equal(r.view().entries.find(x => x.id === 'a').content, '等待时收到的新正文')
  assert.equal(r.view().favorites.length, 0)
})

test('a compact home tombstone becomes durable authority through later local edits', async t => {
  const r = client(t, () => row('a', { version: 4, trashedAt: '2026-09-25T01:00:00Z', deletionId: 'delete-a' }))
  await r.api.call('journal.delete', { entryId: 'a' }, { immediateSync: true, requestId: 'delete' })
  assert.equal(r.queue().length, 0); assert.ok(!r.view().entries.some(x => x.id === 'a'))
  await r.api.call('capture.setFavorite', { id: 'unrelated', favorited: true })
  assert.ok(!r.view().entries.some(x => x.id === 'a'))
  assert.ok(r.cache.read(r.cache.KEYS.confirmedSnapshot).journalTombstones.some(x => x.id === 'a'))
})

test('failure to store a compact acknowledgement retains its operation for replay', async t => {
  const r = client(t, () => row('a', { version: 2, favoritedAt: 'now' }))
  const write = global.wx.setStorageSync
  global.wx.setStorageSync = (key, value) => { if (key.endsWith('.confirmedSnapshot')) throw new Error('storage full'); write(key, value) }
  await assert.rejects(r.api.call('capture.setFavorite', { id: 'a', favorited: true }, { immediateSync: true, requestId: 'pending' }))
  assert.equal(r.queue().length, 1); assert.equal(r.queue()[0].id, 'pending')
})

test('a late compact reply from A cannot enter B cache or clear A intent', async t => {
  const started = deferred(), reply = deferred()
  const r = client(t, async () => { started.resolve(); return reply.promise })
  const running = r.api.call('capture.setFavorite', { id: 'a', favorited: true }, { immediateSync: true, requestId: 'A' })
  await started.promise; r.cache.adoptScope(owner('B')); r.cache.write(r.cache.KEYS.journal, overview(row('B')))
  reply.resolve(row('a', { version: 2, favoritedAt: 'now' })); await assert.rejects(running, { code: 'STALE_SCOPE' })
  assert.deepEqual(r.view().entries.map(x => x.id), ['B']); r.cache.adoptScope(owner('A')); assert.equal(r.queue().length, 1)
})
