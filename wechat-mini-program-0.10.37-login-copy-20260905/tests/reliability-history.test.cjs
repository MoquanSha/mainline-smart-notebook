const test = require('node:test')
const assert = require('node:assert/strict')
const { cloudRuntime } = require('./helpers/cloud-runtime.cjs')
const { scopedClient } = require('./helpers/scoped-client.cjs')
const history = require('../miniprogram/utils/sync-history')
const owner = 'space-a'
const date = (i) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10)

test('history page walks every diary and task without a 120/100 row cutoff', async () => {
  const cloud = cloudRuntime()
  for (let i = 0; i < 245; i++) {
    const id = `day_records_${date(i)}`
    cloud.rows.set(`day_records/${id}`, { id, date: date(i), ownerOpenId: owner, summary: `日记 ${i}`, manualInputs: [], version: 1, updatedAt: '2026-09-24T00:00:00Z', deletedAt: '' })
    cloud.rows.set(`tasks/task-${String(i).padStart(4, '0')}`, { id: `task-${String(i).padStart(4, '0')}`, ownerOpenId: owner, title: `任务 ${i}`, version: 1, deletedAt: '' })
  }
  cloud.rows.set('tasks/foreign', { id: 'foreign', ownerOpenId: 'space-b', title: '不可泄露' })
  const received = new Map()
  let cursor, calls = 0, finished = false
  while (!finished && calls < 30) {
    const page = await cloud.api.syncHistoryPage(owner, { cursor, limit: 73 })
    for (const row of page.records) received.set(`${row.collection}/${row.document.id}`, row.document)
    assert.equal(page.quota.businessReadQueries, 1)
    assert.ok(page.quota.returnedDocuments <= 74)
    cursor = page.nextCursor
    finished = !page.hasMore
    calls++
  }
  assert.equal(finished, true)
  assert.equal(received.size, 490)
  assert.equal(received.has('tasks/foreign'), false)
})

test('history cursor survives other rows being deleted and includes explicit tombstones', async () => {
  const cloud = cloudRuntime()
  for (const id of ['a', 'b', 'c', 'd']) cloud.rows.set(`tasks/${id}`, { id, ownerOpenId: owner, title: id, version: 1 })
  const first = await cloud.api.syncHistoryPage(owner, { limit: 2 })
  assert.deepEqual(first.records.map((row) => row.document.id), ['a', 'b'])
  cloud.rows.delete('tasks/a')
  cloud.rows.set('tasks/c', { id: 'c', ownerOpenId: owner, version: 2, deletedAt: '2026-09-24', title: 'c' })
  const next = await cloud.api.syncHistoryPage(owner, { cursor: first.nextCursor, limit: 2 })
  assert.deepEqual(next.records.map((row) => row.document.id), ['c', 'd'])
  assert.equal(next.records[0].document.deletedAt, '2026-09-24')
  await assert.rejects(cloud.api.syncHistoryPage('space-b', { cursor: first.nextCursor }), { code: 'WORKSPACE_MISMATCH' })
})

test('excluded raw Codex rows still advance the page without leaking content', async () => {
  const cloud = cloudRuntime()
  cloud.rows.set('captures/a', { id: 'a', ownerOpenId: owner, entryKind: 'journal_entry', source: 'codex', kind: 'tool_output', content: 'private transcript' })
  cloud.rows.set('captures/b', { id: 'b', ownerOpenId: owner, entryKind: 'journal_entry', source: 'manual', kind: 'note', content: '手写', journalDate: '2026-09-24' })
  const page = await cloud.api.syncHistoryPage(owner, { cursor: { version: 1, workspaceId: owner, collection: 2, after: '' }, limit: 1 })
  assert.deepEqual(page.records, [])
  assert.equal(page.hasMore, true)
  const next = await cloud.api.syncHistoryPage(owner, { cursor: page.nextCursor, limit: 1 })
  assert.equal(next.records[0].document.content, '手写')
})

const ok = (data) => ({ result: { ok: true, data } })
const account = (workspaceId = owner) => ({ account: { user: { id: 'user-a' }, workspaceId } })
const snapshot = (extra = {}) => ({ revision: 'one', date: '2026-09-24', bootstrap: account(), data: { todos: [], history: [] }, tasks: [], journal: { entries: [], history: [] }, diaryDays: [], ...extra })

test('partial legacy snapshot keeps off-page history and local pending originals', async (t) => {
  const c = scopedClient(async ({ data }) => data.action === 'sync.snapshot'
    ? ok(snapshot({ diaryDays: [{ id: 'day-new', date: '2026-09-24', summary: '云端原文', manualInputs: [{ id: 'remote', content: '云端原文' }], version: 2 }] })) : ok(account()))
  t.after(() => c.api.__test.cancelDirtyFlushTimer())
  await c.api.bootstrap()
  const old = { id: 'day-old', date: '2026-01-01', summary: '历史原文' }
  c.cache.write(c.cache.KEYS.confirmedSnapshot, { diaryDays: [old], confirmedAt: '2026-09-23' })
  c.cache.write(c.cache.KEYS.diaryDays, [old, { id: 'day-new', date: '2026-09-24', version: 1, manualInputs: [{ id: 'local', content: '等待上传的原文' }] }])
  await c.api.syncNow({ skipQueueFlush: true })
  const rows = c.cache.read(c.cache.KEYS.diaryDays)
  assert.equal(rows.length, 2)
  assert.deepEqual(new Set(rows.find((row) => row.date === '2026-09-24').manualInputs.map((x) => x.content)), new Set(['云端原文', '等待上传的原文']))
  assert.equal(c.cache.read(c.cache.KEYS.confirmedSnapshot).diaryDays.find((row) => row.date === '2026-09-24').manualInputs.length, 1, 'pending originals are not falsely cloud-confirmed')
})

test('phone resumes a failed history page and never restarts completed collections', async (t) => {
  const cloud = cloudRuntime()
  for (let i = 0; i < 245; i++) {
    const id = `day_records_${date(i)}`
    cloud.rows.set(`day_records/${id}`, { id, date: date(i), ownerOpenId: owner, summary: `日记 ${i}`, version: 1, deletedAt: '' })
  }
  let calls = 0, failed = false
  const cursors = []
  const storage = new Map()
  const handler = async ({ data }) => {
    if (data.action === 'sync.snapshot') return ok(snapshot({ historyProtocol: 1 }))
    if (data.action !== 'sync.historyPage') return ok(account())
    calls++; cursors.push(data.payload.cursor)
    if (calls === 5 && !failed) { failed = true; throw new Error('network lost') }
    return ok(await cloud.api.syncHistoryPage(owner, data.payload))
  }
  let c = scopedClient(handler, storage)
  t.after(() => c.api.__test.cancelDirtyFlushTimer())
  await c.api.bootstrap()
  const first = await c.api.syncNow({ skipQueueFlush: true, historyPageBudget: 20 })
  assert.equal(first.history.pending, true)
  const checkpoint = c.cache.read(c.cache.KEYS.historyTransfer)
  assert.equal(checkpoint.records.day_records.length, 99)
  c = scopedClient(handler, storage)
  await c.api.bootstrap()
  const next = await c.api.syncNow({ skipQueueFlush: true, historyPageBudget: 20 })
  assert.deepEqual(cursors[5], checkpoint.cursor)
  assert.equal(next.history.pending, false)
  assert.equal(c.cache.read(c.cache.KEYS.diaryDays).length, 245)
  assert.equal(new Set(c.cache.read(c.cache.KEYS.diaryDays).map((row) => row.id)).size, 245)
  const count = calls
  await c.api.syncNow({ skipQueueFlush: true })
  assert.equal(calls, count, 'complete history is not reread while idle')
})

test('late history response cannot write its data or cursor into a newly selected workspace', async (t) => {
  let release, active = owner
  const c = scopedClient(async ({ data }) => {
    if (data.action === 'workspace.switch') { active = data.payload.workspaceId; return ok(account(active)) }
    if (data.action === 'sync.snapshot') return ok(snapshot({ historyProtocol: 1 }))
    if (data.action === 'sync.historyPage') return new Promise((resolve) => { release = () => resolve(ok({ records: [{ collection: 'tasks', document: { id: 'A-private', title: 'A-private' } }], nextCursor: { version: 1, workspaceId: owner, collection: 4, after: '' }, hasMore: false })) })
    return ok(account(active))
  })
  t.after(() => c.api.__test.cancelDirtyFlushTimer())
  await c.api.bootstrap()
  const request = c.api.syncNow({ skipQueueFlush: true })
  while (!release) await new Promise((resolve) => setImmediate(resolve))
  await c.api.call('workspace.switch', { workspaceId: 'space-b' })
  release()
  await assert.rejects(request, { code: 'STALE_SCOPE' })
  assert.deepEqual(c.cache.read(c.cache.KEYS.tasks, []), [])
  assert.equal(c.cache.read(c.cache.KEYS.historyTransfer, null), null)
})

test('history merging respects newer receipts and tombstones, and journal dates stand alone', () => {
  const merged = history.mergePage({ tasks: [{ id: 'a', title: '最新', version: 3 }], captures: [{ id: 'gone', journalDate: '2026-09-20' }] }, {
    records: [{ collection: 'tasks', document: { id: 'a', title: '旧页', version: 1 } }, { collection: 'captures', document: { id: 'gone', deletedAt: '2026-09-24', version: 2 } }, { collection: 'captures', document: { id: 'historical-journal', journalDate: '2026-09-20', content: '没有小记也显示' } }],
    nextCursor: {}, hasMore: false
  })
  const projected = history.project(merged, '2026-09-24')
  assert.equal(projected.tasks[0].title, '最新')
  assert.equal(projected.journal.history.length, 1)
  assert.deepEqual(projected.journal.history[0].entries.map((row) => row.id), ['historical-journal'])
})

test('history projection assigns legacy journal timestamps to the Shanghai day', () => {
  const projected = history.project({ captures: [{
    id: 'legacy-midnight', entryKind: 'journal_entry', source: 'wechat',
    content: '上海凌晨记录', occurredAt: '2026-09-19T16:30:00.000Z', journalDate: ''
  }] }, '2026-09-20')
  assert.deepEqual(projected.journal.entries.map((row) => row.id), ['legacy-midnight'])
  assert.equal(history.shanghaiDateFromValue('2026-09-19T16:30:00.000Z'), '2026-09-20')
})

test('a journal saved while receiving is not replaced by the cache captured at request start', async (t) => {
  let release
  const c = scopedClient(async ({ data }) => data.action === 'sync.snapshot'
    ? new Promise((resolve) => { release = () => resolve(ok(snapshot())) }) : ok(account()))
  t.after(() => c.api.__test.cancelDirtyFlushTimer())
  await c.api.bootstrap()
  c.cache.write(c.cache.KEYS.journal, { entries: [], history: [] })
  const receiving = c.api.syncNow({ skipQueueFlush: true })
  while (!release) await new Promise((resolve) => setImmediate(resolve))
  const pending = await c.api.call('journal.create', { id: 'new-local', content: '接收期间输入的原文' }, { queueOnFailure: true })
  assert.equal(pending.queued, true)
  // The capture page records its optimistic view after durable enqueue.
  c.cache.write(c.cache.KEYS.journal, { entries: [{ id: 'new-local', content: '接收期间输入的原文', pending: true }], history: [] })
  release()
  const result = await receiving
  assert.equal(c.cache.read(c.cache.KEYS.queue).length, 1)
  assert.equal(c.cache.read(c.cache.KEYS.journal).entries[0]?.id, 'new-local')
  assert.equal(result.views.journal.entries[0]?.content, '接收期间输入的原文')
  assert.equal((c.cache.read(c.cache.KEYS.confirmedSnapshot).journal.entries || []).length, 0)
})
