const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { cloudRuntime } = require('./helpers/cloud-runtime.cjs')
const { scopedClient } = require('./helpers/scoped-client.cjs')
const { withSyncSequence, readHead } = require('../cloudfunctions/notebookApi/sync-database')
const owner = 'space-a'
const ok = (data) => ({ result: { ok: true, data } })
const account = () => ({ account: { user: { id: 'user-a' }, workspaceId: owner } })
const task = (id, extra = {}) => ({ id, title: id, ownerOpenId: owner, version: 1, deletedAt: '', ...extra })

test('all deployed business writers use the identical transactional sequence contract', () => {
  const source = fs.readFileSync(path.join(__dirname, '../cloudfunctions/notebookApi/sync-database.js'), 'utf8')
  for (const name of ['desktopSync', 'wechatWebhook', 'wechatKfWebhook']) {
    assert.equal(fs.readFileSync(path.join(__dirname, '../cloudfunctions', name, 'sync-database.js'), 'utf8'), source)
    assert.match(fs.readFileSync(path.join(__dirname, '../cloudfunctions', name, 'index.js'), 'utf8'), /withSyncSequence\(app.database\(\)\)/)
  }
})

test('release enables ordered history only after the index manifest is explicitly verified', () => {
  const root = path.join(__dirname, '..')
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'cloudfunctions/ordered-sync-index-manifest.json'), 'utf8'))
  const config = JSON.parse(fs.readFileSync(path.join(root, 'cloudbaserc.json'), 'utf8'))
  assert.equal(manifest.status, 'ready')
  for (const fn of config.functions.filter((item) => ['notebookApi', 'desktopSync'].includes(item.name))) {
    assert.equal(fn.envVariables.ENABLE_ORDERED_SYNC, 'true')
    assert.equal(fn.envVariables.ORDERED_SYNC_INDEXES_VERIFIED, 'true')
  }
})

test('ordered history backfill is bounded, resumable, owner-scoped, and preserves visible data', async () => {
  const cloud = cloudRuntime()
  for (const id of ['a', 'b', 'c']) {
    cloud.rows.set('daily_tasks/' + id, {
      _id: id, id, ownerOpenId: owner, title: '原始标题-' + id, date: '2026-09-24',
      updatedAt: '2026-09-24T00:00:00.000Z', deletedAt: ''
    })
  }
  cloud.rows.set('daily_tasks/foreign', { _id: 'foreign', id: 'foreign', ownerOpenId: 'space-b', title: '隔离数据', updatedAt: '2026-09-24T00:00:00.000Z' })
  const first = await cloud.api.backfillOrdered(owner, { collection: 'daily_tasks', limit: 2 })
  assert.equal(first.scanned, 2)
  assert.equal(first.updated, 2)
  assert.equal(first.hasMore, true)
  assert.ok(Number.isSafeInteger(cloud.rows.get('daily_tasks/a')._syncSequence))
  assert.ok(Number.isSafeInteger(cloud.rows.get('daily_tasks/b')._syncSequence))
  assert.equal(cloud.rows.get('daily_tasks/a').title, '原始标题-a')
  const second = await cloud.api.backfillOrdered(owner, { collection: 'daily_tasks', after: first.nextAfter, limit: 2 })
  assert.equal(second.scanned, 1)
  assert.equal(second.updated, 1)
  assert.equal(second.hasMore, false)
  assert.ok(Number.isSafeInteger(cloud.rows.get('daily_tasks/c')._syncSequence))
  assert.equal(cloud.rows.get('daily_tasks/foreign')._syncSequence, undefined)
  const replay = await cloud.api.backfillOrdered(owner, { collection: 'daily_tasks', after: '', limit: 2 })
  assert.equal(replay.updated, 0, 're-running a completed page must not allocate another sequence')
  await assert.rejects(cloud.api.backfillOrdered(owner, { collection: 'proposals' }), { code: 'VALIDATION' })
  await assert.rejects(cloud.api.backfillOrdered('', { collection: 'daily_tasks' }), { code: 'WORKSPACE_REQUIRED' })
})

test('ordered history backfill action is restricted to workspace administrators', async () => {
  const cloud = cloudRuntime()
  cloud.rows.set('daily_tasks/a', { _id: 'a', id: 'a', ownerOpenId: owner, title: '标题', updatedAt: '2026-09-24T00:00:00.000Z' })
  const principal = { workspaceId: owner, userId: 'user-a', role: 'owner' }
  const result = await cloud.api.executeMutation(owner, 'sync.backfillOrdered', { collection: 'daily_tasks', limit: 1 }, principal, 'backfill-1')
  assert.equal(result.data.updated, 1)
  await assert.rejects(cloud.api.executeMutation(owner, 'sync.backfillOrdered', { collection: 'daily_tasks' }, { ...principal, role: 'member' }, 'backfill-2'), { code: 'FORBIDDEN' })
})

test('document and cursor sequence commit together, rollback together, and are isolated by workspace', async () => {
  const cloud = cloudRuntime(), db = withSyncSequence(cloud.db)
  await db.collection('tasks').doc('a').set(task('a'))
  await assert.rejects(db.runTransaction(async (tx) => {
    await tx.collection('tasks').doc('b').set(task('b'))
    throw new Error('crash before commit')
  }), /crash/)
  assert.equal(cloud.rows.has('tasks/b'), false)
  assert.equal((await readHead(db, owner)).sequence, 1)
  await db.collection('tasks').doc('other').set(task('other', { ownerOpenId: 'space-b' }))
  await db.collection('tasks').doc('a').update({ title: 'new' })
  assert.equal((await readHead(db, owner)).sequence, 2)
  assert.equal((await readHead(db, 'space-b')).sequence, 1)
  assert.equal(cloud.rows.get('tasks/a')._syncSequence, 2)
  await assert.rejects(db.collection('tasks').doc('a').remove(), { code: 'TOMBSTONE_REQUIRED' })
  assert.equal((await readHead(db, owner)).sequence, 2)
})

test('concurrent desktop and phone original writes enter one ordered incremental stream', async () => {
  const cloud = cloudRuntime()
  await Promise.all([
    cloud.desktop.pushRecordOperation(owner, { collection: 'tasks', id: 'desktop-task', data: { id: 'desktop-task', title: '电脑新增', version: 1 } }),
    cloud.api.appendDailyDiary(owner, { date: '2026-09-24', inputId: 'phone-original', content: '手机原文' })
  ])
  let cursor, more = true
  const records = []
  while (more) {
    const page = await cloud.api.syncChanges(owner, { cursor, after: 0 })
    records.push(...page.records); cursor = page.nextCursor; more = page.hasMore
  }
  assert.deepEqual(new Set(records.map((row) => row.collection)), new Set(['tasks', 'day_records']))
  assert.equal(cursor.through, 2)
  assert.ok(records.every((row) => !('_syncSequence' in row.document)))
  const before = cloud.metrics.reads
  const idle = await cloud.api.syncChanges(owner, { after: 2 })
  assert.equal(idle.hasMore, false)
  assert.equal(cloud.metrics.reads - before, 1, 'idle reads only the head, not any history')
})

test('a record updated beyond a captured window is received by the next window, never skipped', async () => {
  const cloud = cloudRuntime(), db = withSyncSequence(cloud.db)
  await db.collection('tasks').doc('a').set(task('a'))
  await db.collection('tasks').doc('b').set(task('b'))
  const first = await cloud.api.syncChanges(owner, { after: 0, limit: 1 })
  assert.equal(first.records[0].document.id, 'a')
  assert.equal(first.nextCursor.through, 2)
  await db.collection('tasks').doc('b').update({ title: '修改发生在读取过程中', version: 2 })
  let cursor = first.nextCursor, more = true
  while (more) {
    const page = await cloud.api.syncChanges(owner, { cursor, limit: 1 })
    cursor = page.nextCursor; more = page.hasMore
  }
  assert.equal(cursor.through, 2)
  const next = await cloud.api.syncChanges(owner, { after: cursor.through })
  assert.equal(next.records[0].document.id, 'b')
  assert.equal(next.records[0].document.title, '修改发生在读取过程中')
  assert.equal(next.nextCursor.through, 3)
})

test('bulk delete publishes every tombstone including records beyond an old snapshot page', async () => {
  const cloud = cloudRuntime(), db = withSyncSequence(cloud.db)
  for (let i = 0; i < 125; i++) cloud.rows.set('tasks/t' + i, task('t' + i))
  cloud.rows.set('tasks/foreign', task('foreign', { ownerOpenId: 'space-b' }))
  assert.equal((await db.collection('tasks').where({ ownerOpenId: owner }).update({ deletedAt: '2026-09-24' })).updated, 125)
  let cursor, more = true
  const ids = new Set()
  while (more) {
    const page = await cloud.api.syncChanges(owner, { cursor, after: 0, limit: 47 })
    for (const row of page.records) { assert.equal(row.document.deletedAt, '2026-09-24'); ids.add(row.document.id) }
    cursor = page.nextCursor; more = page.hasMore
  }
  assert.equal(ids.size, 125)
  assert.equal(ids.has('foreign'), false)
  assert.equal(cloud.rows.get('tasks/foreign').deletedAt, '')
})

test('phone fills history, catches an insertion behind its ID cursor, then receives only changes', async (t) => {
  const cloud = cloudRuntime(), db = withSyncSequence(cloud.db)
  for (let i = 0; i < 125; i++) cloud.rows.set('tasks/t' + String(i).padStart(3, '0'), task('t' + String(i).padStart(3, '0')))
  let injected = false
  const calls = []
  const client = scopedClient(async ({ data }) => {
    calls.push(data.action)
    if (data.action === 'sync.snapshot') return ok({ streamProtocol: 2, historyProtocol: 2, date: '2026-09-24', revision: 'legacy-signal', sequence: (await readHead(db, owner)).sequence })
    if (data.action === 'sync.historyPage') {
      const page = await cloud.api.syncHistoryPage(owner, data.payload)
      if (!injected) {
        injected = true
        await db.collection('tasks').doc('aaa-new').set(task('aaa-new'))
        await db.collection('tasks').doc('t000').update({ deletedAt: '2026-09-24', version: 2 })
      }
      return ok(page)
    }
    if (data.action === 'sync.changes') return ok(await cloud.api.syncChanges(owner, data.payload))
    return ok(account())
  })
  t.after(() => client.api.__test.cancelDirtyFlushTimer())
  await client.api.bootstrap()
  const result = await client.api.syncNow({ skipQueueFlush: true, historyPageBudget: 20 })
  assert.equal(result.history.pending, false)
  const tasks = client.cache.read(client.cache.KEYS.tasks)
  assert.equal(tasks.length, 125)
  assert.ok(tasks.some((row) => row.id === 'aaa-new'))
  assert.ok(!tasks.some((row) => row.id === 't000'))
  calls.length = 0
  await client.api.syncNow({ skipQueueFlush: true })
  assert.deepEqual(calls, ['sync.snapshot'], 'an idle sync has no business/history reads')
  calls.length = 0
  await db.collection('tasks').doc('t124').update({ title: '只传这条变化', version: 2 })
  await client.api.syncNow({ skipQueueFlush: true, historyPageBudget: 20 })
  assert.ok(!calls.includes('sync.historyPage'))
  assert.equal(client.cache.read(client.cache.KEYS.tasks).find((row) => row.id === 't124').title, '只传这条变化')
})

test('change cursors reject another workspace and invalid sequence ranges', async () => {
  const cloud = cloudRuntime()
  await assert.rejects(cloud.api.syncChanges(owner, { cursor: { version: 2, workspaceId: 'space-b', from: 0, through: 0, after: 0, collection: 0 } }), { code: 'WORKSPACE_MISMATCH' })
  await assert.rejects(cloud.api.syncChanges(owner, { after: 50 }), { code: 'CHANGE_CURSOR_INVALID' })
})

test('ordered snapshot header reads no business collection once the daily rollover was checked', async () => {
  const crypto = require('node:crypto')
  const cloud = cloudRuntime()
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const signalId = 'sync_signal_' + crypto.createHash('sha256').update(owner).digest('hex').slice(0, 32)
  cloud.rows.set('sync_signals/' + signalId, { id: signalId, ownerOpenId: owner, rolloverDate: date, revision: 'same' })
  const old = process.env.ENABLE_ORDERED_SYNC, oldIndexes = process.env.ORDERED_SYNC_INDEXES_VERIFIED
  process.env.ENABLE_ORDERED_SYNC = 'true'
  process.env.ORDERED_SYNC_INDEXES_VERIFIED = 'true'
  try {
    const before = { ...cloud.metrics }
    const result = await cloud.api.syncSnapshot(owner, { workspaceId: owner }, { historyProtocol: 2, cacheReady: true, knownRevision: 'same' })
    assert.equal(result.streamProtocol, 2)
    assert.equal(result.sequence, 0)
    assert.equal(cloud.metrics.reads - before.reads, 2)
    assert.equal(cloud.metrics.writes - before.writes, 0)
    assert.equal(result.quota.businessReadQueries, 0)
    assert.equal(result.tasks, undefined, 'the header never masquerades as an empty full snapshot')
  } finally {
    if (old === undefined) delete process.env.ENABLE_ORDERED_SYNC
    else process.env.ENABLE_ORDERED_SYNC = old
    if (oldIndexes === undefined) delete process.env.ORDERED_SYNC_INDEXES_VERIFIED
    else process.env.ORDERED_SYNC_INDEXES_VERIFIED = oldIndexes
  }
})

test('old snapshot grouping keeps undated rows and date-only diaries without deleting off-page entries', () => {
  const history = require('../miniprogram/utils/sync-history')
  const result = history.mergeLegacySnapshot({
    date: '2026-09-24', data: { todos: [{ id: 'today', title: '没有重复日期字段' }], history: [] },
    diaryDays: [{ date: '2026-09-24', summary: '仅日期的旧小记' }],
    journal: { entries: [], favorites: [], hidden: [{ id: 'moved', journalDate: '2026-09-01', hiddenAt: '2026-09-24' }], history: [] }
  }, {
    date: '2026-09-24', todayHistory: [{ date: '2025-01-01', todos: [{ id: 'offpage' }] }],
    journal: { entries: [], history: [{ date: '2026-09-01', entries: [{ id: 'moved' }, { id: 'untouched' }] }] },
    diaryDays: [{ date: '2025-01-01', summary: '更早原文' }]
  })
  assert.equal(result.data.todos[0].id, 'today')
  assert.equal(result.data.history[0].todos[0].id, 'offpage')
  assert.deepEqual(result.journal.history[0].entries.map((row) => row.id), ['untouched'])
  assert.equal(result.diaryDays.length, 2)
  assert.equal(result.diaryDays.find((row) => row.date === '2026-09-24').summary, '仅日期的旧小记')
})

test('archived journal entries stay out of normal history, favorites and hidden views', () => {
  const history = require('../miniprogram/utils/sync-history')
  const result = history.project({ captures: [
    { id: 'a', journalDate: '2026-09-20', journalArchived: true, favoritedAt: '2026-09-21' },
    { id: 'b', journalDate: '2026-09-20', archivedAt: '2026-09-21', hiddenAt: '2026-09-21' }
  ] }, '2026-09-24')
  assert.equal(result.journalArchive.length, 2)
  assert.deepEqual(result.journal, { entries: [], favorites: [], hidden: [], history: [] })
})
