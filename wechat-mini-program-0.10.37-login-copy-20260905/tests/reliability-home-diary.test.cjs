const test = require('node:test'), assert = require('node:assert/strict')
const { scopedClient } = require('./helpers/scoped-client.cjs')
const owner = workspaceId => ({ account: { user: { id: 'user' }, workspaceId } })
const date = '2026-09-20'
const entry = { id: 'journal', entryKind: 'journal_entry', journalDate: date, content: '灵光原文', rawContent: '灵光原文', version: 2 }
function client(t, respond) {
  const requests = []
  const r = scopedClient(async () => { throw new Error('unexpected cloud call') }, new Map(), {
    request(options) {
      requests.push(options)
      Promise.resolve().then(() => respond(options)).then(data => options.success({ statusCode: 200, data: { ok: true, data } }), error => options.fail({ errMsg: error.message }))
    }
  }, { cloudSyncEnabled: false, manualSyncOnly: true })
  r.cache.adoptScope(owner('A')); r.cache.writeConnection({ serverBaseUrl: 'https://synthetic.invalid', token: 'synthetic' })
  t.after(() => r.api.__test.cancelDirtyFlushTimer())
  return { ...r, requests, queue: () => r.cache.read(r.cache.KEYS.queue, []) }
}
const receipt = (operation, data) => ({ requestId: operation.requestId, action: operation.action, ok: true, data })
const day = (ids = ['raw']) => ({ date, version: 2, organizationHost: 'desktop', organizationStatus: 'pending',
  manualInputs: ids.map(id => ({ id, content: id, source: 'wechat' })) })

test('home batch persists diary and journal receipts before settling their durable operations', async t => {
  const r = client(t, req => ({ results: req.data.operations.map(op => receipt(op,
    op.action === 'diary.appendInput' ? { acceptedInputId: 'raw', day: day() } : entry)) }))
  await r.api.call('diary.appendInput', { date, inputId: 'raw', content: 'raw' }, { requestId: 'raw' })
  await r.api.call('journal.create', { id: 'journal', date, content: '灵光原文' }, { requestId: 'journal' })
  const result = await r.api.flushQueue()
  assert.equal(result.sent, 2); assert.equal(r.queue().length, 0)
  const saved = r.cache.read(r.cache.KEYS.diaryDays).find(d => d.date === date)
  assert.equal(saved.manualInputs[0].pending, false); assert.equal(saved.organizationHost, 'desktop')
  assert.ok(r.cache.read(r.cache.KEYS.confirmedSnapshot).diaryDays.some(d => d.date === date))
  const history = r.cache.read(r.cache.KEYS.journal).history.flatMap(group => group.entries)
  assert.equal(history.find(row => row.id === 'journal').version, 2)
})

test('failed receipt persistence retains only that operation while the other record is confirmed', async t => {
  const r = client(t, req => ({ results: req.data.operations.map(op => receipt(op,
    op.action === 'diary.appendInput' ? { acceptedInputId: 'raw', day: day() } : entry)) }))
  await r.api.call('diary.appendInput', { date, inputId: 'raw', content: 'raw' }, { requestId: 'raw' })
  await r.api.call('journal.create', { id: 'journal', date, content: '灵光原文' }, { requestId: 'journal' })
  const write = global.wx.setStorageSync
  let fail = true
  global.wx.setStorageSync = (key, value) => {
    if (fail && key.endsWith('.diaryDays')) { fail = false; throw new Error('storage full') }
    write(key, value)
  }
  const result = await r.api.flushQueue()
  assert.equal(result.sent, 1); assert.deepEqual(r.queue().map(op => op.id), ['raw'])
  assert.equal(r.queue()[0].status, 'blocked', 'a storage failure must not spin in automatic retry')
  // Storage is restored; explicitly re-enable this retained operation.
  r.cache.write(r.cache.KEYS.queue, r.queue().map(op => ({ ...op, status: 'pending' })))
  await r.api.flushQueue()
  assert.equal(r.queue().length, 0)
})

test('a new local diary original added while home replies survives receipt merge and queue settlement', async t => {
  let resolve, entered
  const pending = new Promise(r => { resolve = r }), started = new Promise(r => { entered = r })
  const r = client(t, async req => { entered(); await pending; return { results: req.data.operations.map(op => receipt(op, { acceptedInputId: 'raw', day: day() })) } })
  await r.api.call('diary.appendInput', { date, inputId: 'raw', content: 'raw' }, { requestId: 'raw' })
  const flush = r.api.flushQueue(); await started
  await r.api.call('diary.appendInput', { date, inputId: 'new', content: 'new' }, { requestId: 'new' })
  resolve(); await flush
  assert.deepEqual(r.queue().map(op => op.id), ['new'])
  const saved = r.cache.read(r.cache.KEYS.diaryDays).find(d => d.date === date)
  assert.deepEqual(saved.manualInputs.map(input => [input.id, input.pending]), [['raw', false], ['new', true]])
})

test('home-owned diary organization never starts a competing cloud job', async t => {
  const r = client(t, () => { throw new Error('unexpected home request') })
  global.getApp = () => ({ appVisible: true, notifySyncListeners() {} })
  r.cache.write(r.cache.KEYS.bootstrap, { capabilities: { diaryOrganization: 1 } })
  r.cache.write(r.cache.KEYS.diaryDays, [day()])
  const result = await r.api.organizePendingDiaries({ date, retry: true })
  assert.equal(result.error, undefined)
  assert.deepEqual(r.cache.read(r.cache.KEYS.diaryOrganization, {}), {})
})

test('a late home batch from A cannot alter B or clear A diary queue', async t => {
  let resolve, entered
  const pending = new Promise(r => { resolve = r }), started = new Promise(r => { entered = r })
  const r = client(t, async req => { entered(); await pending; return { results: req.data.operations.map(op => receipt(op, { acceptedInputId: 'raw', day: day() })) } })
  await r.api.call('diary.appendInput', { date, inputId: 'raw', content: 'raw' }, { requestId: 'raw' })
  const flush = r.api.flushQueue(); await started
  r.cache.adoptScope(owner('B')); resolve()
  await assert.rejects(flush, { code: 'STALE_SCOPE' })
  assert.deepEqual(r.cache.read(r.cache.KEYS.diaryDays, []), [])
  r.cache.adoptScope(owner('A')); assert.equal(r.queue().length, 1)
})

test('missing or mismatched diary acknowledgement cannot remove either direct or batched originals', async t => {
  const r = client(t, req => req.data.operations
    ? { results: req.data.operations.map(op => receipt(op, {})) }
    : { acceptedInputId: 'wrong', day: day() })
  await assert.rejects(r.api.call('diary.appendInput', { date, inputId: 'raw', content: 'raw' }, { requestId: 'raw', immediateSync: true }), { code: 'RECEIPT_INCOMPLETE' })
  assert.equal(r.queue()[0].status, 'blocked')
  await r.api.call('diary.appendInput', { date, inputId: 'second', content: 'second' }, { requestId: 'second' })
  const result = await r.api.flushQueue()
  assert.equal(result.sent, 0); assert.equal(r.queue().length, 2)
  assert.ok(r.queue().every(op => op.status === 'blocked'))
})
