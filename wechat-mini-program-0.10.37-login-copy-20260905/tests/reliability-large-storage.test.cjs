const test = require('node:test')
const assert = require('node:assert/strict')
const storage = require('../miniprogram/utils/large-storage')
const { scopedClient } = require('./helpers/scoped-client.cjs')

function runtime({ files = true } = {}) {
  const values = new Map(), disk = new Map(), directories = new Set()
  const faults = { part: 0, index: false, afterCommit: false, reads: false }
  let writes = 0
  global.wx = {
    env: files ? { USER_DATA_PATH: '/private-test-root' } : {},
    getStorageSync(key) { if (faults.reads) throw new Error('storage offline'); return structuredClone(values.get(key)) },
    setStorageSync(key, value) {
      assert.ok(Buffer.byteLength(JSON.stringify(value)) < 1024 * 1024, 'native key capacity is enforced')
      if (faults.index && (key.startsWith('scope-') || key.endsWith('.historyTransfer'))) throw new Error('storage full')
      values.set(key, structuredClone(value))
      if (faults.afterCommit && key.startsWith('scope-')) throw new Error('response lost after native write')
    },
    removeStorageSync(key) { values.delete(key) }
  }
  if (files) wx.getFileSystemManager = () => ({
    accessSync(path) { if (!disk.has(path) && !directories.has(path)) throw new Error('not found') },
    mkdirSync(path) { directories.add(path) },
    writeFileSync(path, content, encoding) {
      assert.equal(encoding, 'utf8'); assert.ok(path.startsWith('/private-test-root/mainline-cache-v1/'))
      writes++
      if (faults.part && writes === faults.part) { disk.set(path, 'partial'); throw new Error('disk full') }
      disk.set(path, Buffer.from(content, 'utf8').toString('utf8'))
    },
    readFileSync(path) { if (!disk.has(path)) throw new Error('missing'); return disk.get(path) },
    unlinkSync(path) { disk.delete(path) }
  })
  storage.__test.clearMemory()
  return { values, disk, faults, writes: () => writes }
}
const large = (label) => ({ cursor: { collection: 3, after: label }, original: ('中文🙂' + label).repeat(150000) })

test('multi-megabyte Unicode values reopen through small indexes without native key overflow', () => {
  const r = runtime(), value = large('A')
  storage.write('scope-A', value)
  const index = r.values.get('scope-A')
  assert.equal(index.backend, 'files')
  assert.ok(index.parts.length > 10)
  assert.equal(r.values.size, 1)
  storage.__test.clearMemory()
  assert.deepEqual(storage.read('scope-A'), value)
  storage.write('scope-A', large('B'))
  assert.equal(r.disk.size, r.values.get('scope-A').parts.length, 'old parts are collected only after replacement commits')
  storage.__test.clearMemory()
  assert.deepEqual(storage.read('scope-A'), large('B'))
})

test('a failed data part or failed index preserves the previous value and cursor across restart', () => {
  for (const failure of ['part', 'index']) {
    const r = runtime()
    storage.write('scope-A', large('old'))
    const previousIndex = structuredClone(r.values.get('scope-A'))
    const previousFiles = new Map(r.disk)
    if (failure === 'part') r.faults.part = r.writes() + 3
    else r.faults.index = true
    assert.throws(() => storage.write('scope-A', large('new')), { code: 'LOCAL_STORAGE_WRITE_FAILED' })
    assert.deepEqual(r.values.get('scope-A'), previousIndex)
    assert.deepEqual(r.disk, previousFiles)
    storage.__test.clearMemory()
    assert.deepEqual(storage.read('scope-A'), large('old'))
  }
})

test('unchanged large caches do not rewrite files, and an ambiguous commit is verified before acknowledgement', () => {
  const r = runtime(), value = large('same')
  storage.write('scope-A', value)
  const writes = r.writes()
  storage.write('scope-A', structuredClone(value))
  assert.equal(r.writes(), writes, 'repeated projected caches produce no file writes')
  r.faults.afterCommit = true
  const next = large('new')
  assert.deepEqual(storage.write('scope-A', next), next)
  storage.__test.clearMemory()
  assert.deepEqual(storage.read('scope-A'), next)
  assert.equal(r.disk.size, r.values.get('scope-A').parts.length)
})

test('corrupt or missing parts raise an explicit recovery error and cannot be overwritten as an empty cache', () => {
  const r = runtime()
  storage.write('scope-A', large('original'))
  const index = structuredClone(r.values.get('scope-A'))
  r.disk.set('/private-test-root/mainline-cache-v1/' + index.parts[0].name, 'damaged')
  storage.__test.clearMemory()
  assert.throws(() => storage.read('scope-A', []), { code: 'LOCAL_STORAGE_CORRUPT' })
  assert.throws(() => storage.write('scope-A', []), { code: 'LOCAL_STORAGE_CORRUPT' })
  assert.deepEqual(r.values.get('scope-A'), index)
  assert.equal(r.disk.size, index.parts.length, 'files are retained for recovery')
})

test('an index from another scope or a path traversal cannot read private files', () => {
  const r = runtime()
  storage.write('scope-A', large('private-A'))
  const index = structuredClone(r.values.get('scope-A'))
  r.values.set('scope-B', index)
  assert.throws(() => storage.read('scope-B'), { code: 'LOCAL_STORAGE_CORRUPT' })
  index.parts[0].name = '../outside'
  r.values.set('scope-A', index)
  assert.throws(() => storage.read('scope-A'), { code: 'LOCAL_STORAGE_CORRUPT' })
})

test('without file APIs chunked storage still respects the per-key limit and cleans replaced chunks', () => {
  const r = runtime({ files: false }), value = large('fallback')
  storage.write('scope-A', value)
  assert.equal(r.values.get('scope-A').backend, 'storage')
  storage.__test.clearMemory()
  assert.deepEqual(storage.read('scope-A'), value)
  storage.write('scope-A', { compact: true })
  assert.equal(r.values.size, 1)
  assert.deepEqual(storage.read('scope-A'), { compact: true })
})

test('platform read failures are not mistaken for an empty queue', () => {
  const r = runtime()
  r.faults.reads = true
  assert.throws(() => storage.read('scope-A', []), { code: 'LOCAL_STORAGE_READ_FAILED' })
})

test('a failed history checkpoint reopens at the same page and preserves complete originals', async (t) => {
  const r = runtime(), platform = { ...wx }
  const account = { account: { user: { id: 'u' }, workspaceId: 'w' } }
  const old = { id: 'day-old', date: '2026-01-01', version: 1, manualInputs: [{ id: 'old-input', content: '历史原文🙂'.repeat(15000) }] }
  const incoming = { id: 'day-new', date: '2026-01-02', version: 1, manualInputs: [{ id: 'new-input', content: '新收到的原文🙂'.repeat(15000) }] }
  const cursor = { version: 2, workspaceId: 'w', collection: 3, after: 'day-old', changeAfter: 0 }
  const requested = []
  const handler = async ({ data }) => {
    let value = account
    if (data.action === 'sync.snapshot') value = { streamProtocol: 2, historyProtocol: 2, sequence: 0, revision: 'r', date: '2026-09-24' }
    if (data.action === 'sync.historyPage') {
      requested.push(data.payload.cursor)
      value = { records: [{ collection: 'day_records', document: incoming }], hasMore: false, nextCursor: { ...cursor, collection: 4 } }
    }
    if (data.action === 'sync.changes') value = { records: [], hasMore: false, nextCursor: { through: 0 } }
    return { result: { ok: true, data: value } }
  }
  let c = scopedClient(handler, r.values, platform)
  t.after(() => c.api.__test.cancelDirtyFlushTimer())
  await c.api.bootstrap()
  const checkpoint = { protocol: 2, phase: 'history', sequence: 0, cursor, records: { day_records: [old] } }
  c.cache.write(c.cache.KEYS.historyTransfer, checkpoint)
  r.faults.index = true
  const first = await c.api.syncNow({ skipQueueFlush: true })
  assert.equal(first.remoteFresh, false)
  assert.equal(first.history.error.code, 'LOCAL_STORAGE_WRITE_FAILED')
  assert.deepEqual(c.cache.read(c.cache.KEYS.historyTransfer), checkpoint)
  r.faults.index = false
  c = scopedClient(handler, r.values, platform)
  await c.api.bootstrap()
  assert.deepEqual(c.cache.read(c.cache.KEYS.historyTransfer), checkpoint)
  const next = await c.api.syncNow({ skipQueueFlush: true })
  assert.equal(next.remoteFresh, true)
  assert.deepEqual(requested, [cursor, cursor], 'failed page was not acknowledged or skipped')
  const persisted = c.cache.read(c.cache.KEYS.diaryDays)
  assert.equal(persisted.find((row) => row.id === old.id).manualInputs[0].content, old.manualInputs[0].content)
  assert.equal(persisted.find((row) => row.id === incoming.id).manualInputs[0].content, incoming.manualInputs[0].content)
})

test('large legacy recovery and new scoped queues survive restart without crossing accounts', () => {
  const r = runtime()
  const legacyQueue = [{ id: 'old-op', action: 'journal.create', payload: { content: '历史输入'.repeat(40000) } }]
  storage.write('mainline.cloud.v2.queue', legacyQueue)
  const platform = { ...wx }
  let c = scopedClient(async () => ({}), r.values, platform)
  c.cache.adoptScope({ account: { user: { id: 'u' }, workspaceId: 'a' } })
  assert.deepEqual(c.cache.quarantinedLegacy().queue, legacyQueue)
  assert.deepEqual(c.cache.read(c.cache.KEYS.queue), [])
  c.cache.enqueue('journal.create', { content: 'A 的待传原文'.repeat(30000) }, { id: 'a-op' })
  c.cache.adoptScope({ account: { user: { id: 'u' }, workspaceId: 'b' } })
  assert.deepEqual(c.cache.read(c.cache.KEYS.queue), [])
  c = scopedClient(async () => ({}), r.values, platform)
  assert.deepEqual(c.cache.quarantinedLegacy().queue, legacyQueue)
  c.cache.adoptScope({ account: { user: { id: 'u' }, workspaceId: 'a' } })
  assert.equal(c.cache.read(c.cache.KEYS.queue)[0].id, 'a-op')
  assert.equal(c.cache.read(c.cache.KEYS.queue)[0].payload.content.length, 'A 的待传原文'.repeat(30000).length)
})

test('a temporary active-account read failure cannot redirect a private write into unbound storage', () => {
  const r = runtime()
  const c = scopedClient(async () => ({}), r.values, { ...wx })
  c.cache.adoptScope({ account: { user: { id: 'u' }, workspaceId: 'a' } })
  const before = structuredClone([...r.values])
  const read = wx.getStorageSync
  wx.getStorageSync = (key) => {
    if (key === 'mainline.cloud.v3.activeScope') throw new Error('scope storage unavailable')
    return read(key)
  }
  assert.throws(() => c.cache.enqueue('journal.create', { content: '私人原文' }), { code: 'LOCAL_STORAGE_READ_FAILED' })
  assert.deepEqual([...r.values], before)
})
