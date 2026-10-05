const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), { createRequire } = require('node:module')
const { scopedClient } = require('./helpers/scoped-client.cjs')
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
const owner = { account: { user: { id: 'user' }, workspaceId: 'space' } }
const row = (id, extra = {}) => ({ id, journalDate: today, rawContent: '原文 ' + id, content: '原文 ' + id, version: 1,
  checklistItems: [{ id: 'item', text: '处理', done: false }], ...extra })
const overview = (...entries) => ({ entries, favorites: [], hidden: [], history: [] })
const ok = (data) => ({ result: { ok: true, data } })
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function runtime(remote = overview()) {
  const r = scopedClient(async ({ data }) => data.action === 'sync.snapshot'
    ? ok({ revision: 'one', date: today, bootstrap: owner, data: { todos: [], history: [] }, tasks: [], journal: remote, diaryDays: [] }) : ok(owner))
  r.cache.adoptScope(owner)
  return r
}

test('one blocked journal edit preserves only its intent while unrelated rows and same-record text still receive', async (t) => {
  const r = runtime(overview(row('a', { version: 2, content: '电脑更新正文', rawContent: '电脑更新正文' }), row('b')))
  t.after(() => r.api.__test.cancelDirtyFlushTimer())
  await r.api.bootstrap(); r.cache.write(r.cache.KEYS.journal, overview(row('a')))
  const operation = r.cache.enqueue('journal.toggleItem', { entryId: 'a', itemId: 'item', done: true }, { id: 'toggle' })
  r.cache.write(r.cache.KEYS.queue, [{ ...operation, status: 'blocked', lastError: '需要处理冲突' }])
  const result = await r.api.syncNow({ skipQueueFlush: true })
  const a = result.views.journal.entries.find((row) => row.id === 'a')
  assert.ok(result.views.journal.entries.some((row) => row.id === 'b'))
  assert.equal(a.content, '电脑更新正文'); assert.equal(a.checklistItems[0].done, true)
  assert.equal(a.syncBlocked, true)
  assert.equal(r.cache.read(r.cache.KEYS.confirmedSnapshot).journal.entries.find((row) => row.id === 'a').checklistItems[0].done, false)
})

test('durable queued journal fields survive reopening before any receive or page callback', async (t) => {
  const r = runtime(); t.after(() => r.api.__test.cancelDirtyFlushTimer())
  await r.api.bootstrap(); r.cache.write(r.cache.KEYS.journal, overview(row('a')))
  await r.api.call('capture.setFavorite', { id: 'a', favorited: true }, { queueOnFailure: true })
  assert.equal(r.cache.read(r.cache.KEYS.journal).favorites[0]?.id, 'a')
  await r.api.call('journal.toggleItem', { entryId: 'a', itemId: 'item', done: true }, { queueOnFailure: true })
  assert.equal(r.cache.read(r.cache.KEYS.journal).entries[0].checklistItems[0].done, true)
  await r.api.call('journal.create', { id: 'new', content: '  精确保留\n', date: today }, { queueOnFailure: true })
  assert.equal(r.cache.read(r.cache.KEYS.journal).entries.find((row) => row.id === 'new').rawContent, '  精确保留\n')
})

function pageRuntime() {
  const r = runtime(); r.cache.write(r.cache.KEYS.journal, overview(row('a')))
  const api = { ...r.api }; let definition
  const filename = path.join(__dirname, '../miniprogram/pages/capture/index.js'), native = createRequire(filename)
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { Page(value) { definition = value },
    wx: { getStorageSync: () => false }, getApp: () => ({ subscribeSync: () => () => {} }),
    require: (id) => id === '../../utils/api' ? api : id === '../../utils/cache' ? r.cache : id === '../../utils/candidate-refresh' ? { refreshIfDue: async () => {} } : native(id),
    setTimeout: () => 1, clearTimeout() {} })
  const p = { ...definition, data: structuredClone(definition.data), setData(value) { Object.assign(this.data, structuredClone(value)) } }
  p.onLoad(); p.onShow()
  return { ...r, api, p }
}
const event = (data = {}) => ({ currentTarget: { dataset: { id: 'a', entry: 'a', item: 'item', ...data } } })

for (const operation of ['toggle', 'favorite', 'hide']) test(`late ${operation} failure cannot restore an old whole-page snapshot`, async () => {
  const r = pageRuntime(), reply = deferred(); r.api.call = () => reply.promise
  const pending = operation === 'toggle' ? r.p.toggleItem(event()) : r.p.mutateRecord(event({ action: operation }))
  r.p.applyOverview(overview(row('a', { version: 5, content: '等待期间的新正文' }), row('new-from-desktop')))
  reply.reject(new Error('请求失败')); await pending
  assert.ok(r.p.findEntry('new-from-desktop')); assert.equal(r.p.findEntry('a').content, '等待期间的新正文')
  assert.ok(r.cache.read(r.cache.KEYS.journal).entries.some((item) => item.id === 'new-from-desktop'))
})

test('late successful field action cannot overwrite a newer received body', async () => {
  const r = pageRuntime(), reply = deferred(); r.api.call = () => reply.promise
  const pending = r.p.mutateRecord(event({ action: 'favorite' }))
  r.p.applyOverview(overview(row('a', { version: 5, content: '最新正文', favoritedAt: 'now' }), row('new')))
  reply.resolve(row('a', { version: 2, content: '旧回复正文', favoritedAt: 'now' })); await pending
  assert.equal(r.p.findEntry('a').content, '最新正文'); assert.ok(r.p.findEntry('new'))
})

for (const all of [false, true]) test(`proposal ${all ? 'all' : 'single'} failure keeps arrivals and does not claim an unsaved local choice`, async () => {
  const r = pageRuntime(), reply = deferred(); r.api.call = () => reply.promise
  r.p.applyProposals([{ id: 'a', status: 'pending', version: 1 }])
  const pending = all ? r.p.applyAllProposals() : r.p.handleProposal(event({ action: 'apply' }))
  assert.doesNotMatch(r.p.data.syncMessage, /已保存/)
  r.p.applyProposals([{ id: 'a', status: 'pending', version: 2, title: '更新内容' }, { id: 'b', status: 'pending' }])
  reply.reject(new Error('请求失败')); await pending
  assert.equal(r.p.data.proposals.find((row) => row.id === 'a').version, 2)
  assert.ok(r.p.data.proposals.some((row) => row.id === 'b'))
})

test('delayed upload receipt preserves a newer queued checkbox and received body, then settles only the next confirmed operation', async (t) => {
  const entered = deferred(), release = deferred(); let pushes = 0
  const r = scopedClient(async ({ data }) => {
    if (data.action !== 'sync.push') return ok(owner)
    const operation = data.payload.operations[0]; pushes++
    if (pushes === 1) { entered.resolve(); await release.promise }
    return ok({ results: [{ requestId: operation.requestId, ok: true, data: row('a', {
      version: pushes === 1 ? 2 : 6, content: pushes === 1 ? '旧回执正文' : '电脑新正文',
      checklistItems: [{ id: 'item', text: '处理', done: operation.payload.done }]
    }) }] })
  })
  t.after(() => r.api.__test.cancelDirtyFlushTimer()); await r.api.bootstrap()
  r.cache.write(r.cache.KEYS.journal, overview(row('a')))
  await r.api.call('journal.toggleItem', { entryId: 'a', itemId: 'item', done: true })
  const upload = r.api.flushQueue(); await entered.promise
  r.cache.write(r.cache.KEYS.journal, overview(row('a', { version: 5, content: '电脑新正文' }), row('b')))
  await r.api.call('journal.toggleItem', { entryId: 'a', itemId: 'item', done: false })
  const nextId = r.cache.read(r.cache.KEYS.queue)[0].id
  release.resolve(); await upload
  let a = r.cache.read(r.cache.KEYS.journal).entries.find((entry) => entry.id === 'a')
  assert.equal(a.content, '电脑新正文'); assert.equal(a.checklistItems[0].done, false)
  assert.equal(a.syncPending, true); assert.equal(r.cache.read(r.cache.KEYS.queue)[0].id, nextId)
  assert.ok(r.cache.read(r.cache.KEYS.journal).entries.some((entry) => entry.id === 'b'))
  await r.api.flushQueue()
  a = r.cache.read(r.cache.KEYS.journal).entries.find((entry) => entry.id === 'a')
  assert.equal(a.checklistItems[0].done, false); assert.ok(!a.syncPending)
  assert.equal(r.cache.read(r.cache.KEYS.queue).length, 0); assert.equal(pushes, 2)
  await r.api.flushQueue(); assert.equal(pushes, 2, 'empty queue makes no idle request')
})

test('blocked edit displays the error and keeps the cloud receipt distinct from local intention', async (t) => {
  const r = scopedClient(async ({ data }) => data.action !== 'sync.push' ? ok(owner) : ok({ results: data.payload.operations.map((operation) => ({
    requestId: operation.requestId, ok: false, error: { code: 'FORBIDDEN', message: '空间权限已变更', retryable: false }
  })) }))
  t.after(() => r.api.__test.cancelDirtyFlushTimer()); await r.api.bootstrap()
  r.cache.write(r.cache.KEYS.journal, overview(row('a')))
  r.cache.write(r.cache.KEYS.confirmedSnapshot, { journal: overview(row('a')) })
  await r.api.call('capture.setFavorite', { id: 'a', favorited: true }); await r.api.flushQueue()
  const a = r.cache.read(r.cache.KEYS.journal).entries[0]
  assert.equal(a.syncBlocked, true); assert.equal(a.syncError, '空间权限已变更')
  assert.equal(r.cache.read(r.cache.KEYS.confirmedSnapshot).journal.entries[0].favoritedAt, undefined)
  const { present } = require('../miniprogram/pages/capture/presenter')
  assert.equal(present(a).syncLabel, '修改待处理')
})

test('a received tombstone stays authoritative through further local projections and an old mutation reply', async (t) => {
  const deleted = row('a', { version: 9, trashedAt: '2026-09-24T00:00:00Z', deletionId: 'delete-a' })
  const r = scopedClient(async ({ data }) => {
    if (data.action === 'sync.snapshot') return ok({ revision: 'one', historyProtocol: 1, date: today, bootstrap: owner,
      data: { todos: [], history: [] }, tasks: [], journal: overview(), diaryDays: [] })
    if (data.action === 'sync.historyPage') return ok({ records: [deleted, row('b')].map((document) => ({ collection: 'captures', document })),
      nextCursor: { version: 1, collection: 4, after: '' }, hasMore: false })
    if (data.action === 'capture.setFavorite') return ok(row('a', { version: 2, favoritedAt: '2026-09-23T00:00:00Z' }))
    return ok(owner)
  })
  t.after(() => r.api.__test.cancelDirtyFlushTimer()); await r.api.bootstrap()
  await r.api.call('journal.create', { id: 'a', content: '待恢复原文', date: today })
  await r.api.syncNow({ skipQueueFlush: true })
  assert.ok(!r.cache.read(r.cache.KEYS.journal).entries.some((entry) => entry.id === 'a'))
  await r.api.call('capture.setFavorite', { id: 'b', favorited: true })
  assert.ok(!r.cache.read(r.cache.KEYS.journal).entries.some((entry) => entry.id === 'a'), 'another edit cannot revive the old queued create')
  await r.api.call('capture.setFavorite', { id: 'a', favorited: true }, { immediateSync: true })
  assert.ok(!r.cache.read(r.cache.KEYS.journal).entries.some((entry) => entry.id === 'a'), 'old reply cannot revive a received deletion')
  assert.equal(r.cache.read(r.cache.KEYS.queue).find((item) => item.action === 'journal.create').payload.content, '待恢复原文')
})

test('unrelated pending operations cannot project into a different workspace', () => {
  const { projectJournal } = require('../miniprogram/utils/journal-intents')
  const view = projectJournal({ journal: overview(row('a')), date: today,
    scope: { userId: 'u', workspaceId: 'B' }, queue: [{ id: 'old', action: 'capture.hide', payload: { id: 'a' },
      createdAt: 'now', scope: { userId: 'u', workspaceId: 'A' } }] })
  assert.equal(view.journal.entries[0].id, 'a'); assert.equal(view.journal.hidden.length, 0)
})

test('a deletion receipt survives cache projection and stale legacy snapshots without history protocol', async (t) => {
  const deleted = row('a', { version: 9, trashedAt: '2026-09-24T00:00:00Z', deletionId: 'delete-a' })
  const r = scopedClient(async ({ data }) => {
    if (data.action === 'journal.delete') return ok(deleted)
    if (data.action === 'sync.snapshot') return ok({ revision: 'stale', date: today, bootstrap: owner,
      data: { todos: [], history: [] }, tasks: [], journal: overview(row('a'), row('b')), diaryDays: [] })
    return ok(owner)
  })
  t.after(() => r.api.__test.cancelDirtyFlushTimer()); await r.api.bootstrap()
  r.cache.write(r.cache.KEYS.journal, overview(row('a'), row('b')))
  await r.api.call('journal.create', { id: 'a', content: '未获确认的原文', date: today })
  await r.api.call('journal.delete', { entryId: 'a' }, { immediateSync: true })
  await r.api.call('capture.setFavorite', { id: 'b', favorited: true })
  await r.api.syncNow({ skipQueueFlush: true })
  assert.ok(!r.cache.read(r.cache.KEYS.journal).entries.some((entry) => entry.id === 'a'))
  assert.equal(r.cache.read(r.cache.KEYS.queue).find((item) => item.action === 'journal.create').payload.content, '未获确认的原文')
  assert.equal(r.cache.read(r.cache.KEYS.confirmedSnapshot).journalTombstones[0].deletionId, 'delete-a')
  assert.ok(!r.cache.read(r.cache.KEYS.confirmedSnapshot).journal.entries.some((entry) => entry.id === 'a'), 'rebase context cannot use a deleted row from a stale snapshot')
})

test('a receipt storage failure keeps the exact original upload available instead of acknowledging it', async (t) => {
  const r = scopedClient(async ({ data }) => data.action === 'capture.setFavorite'
    ? ok(row('a', { version: 2, favoritedAt: 'confirmed' })) : ok(owner))
  t.after(() => r.api.__test.cancelDirtyFlushTimer()); await r.api.bootstrap()
  r.cache.write(r.cache.KEYS.journal, overview(row('a')))
  const write = global.wx.setStorageSync; let failed = false
  global.wx.setStorageSync = (key, value) => {
    if (!failed && key.endsWith('.confirmedSnapshot')) { failed = true; throw new Error('receipt storage full') }
    write(key, value)
  }
  await assert.rejects(r.api.call('capture.setFavorite', { id: 'a', favorited: true }, { immediateSync: true, requestId: 'stable-retry' }), { code: 'LOCAL_STORAGE_WRITE_FAILED' })
  const queue = r.cache.read(r.cache.KEYS.queue)
  assert.equal(queue.length, 1); assert.equal(queue[0].id, 'stable-retry')
  assert.equal(queue[0].payload.favorited, true); assert.equal(queue[0].status, 'blocked')
  assert.ok(r.cache.read(r.cache.KEYS.journal).entries[0].syncBlocked)
})

test('restore requires a matching deletion proof and a later reply cannot undo that restore', () => {
  const { projectJournal } = require('../miniprogram/utils/journal-intents')
  const tombstone = row('a', { version: 4, trashedAt: 'then', deletionId: 'd4' })
  const absent = projectJournal({ journal: overview(), records: [tombstone, row('a', { version: 7 })], date: today })
  assert.equal(absent.journal.entries.length, 0); assert.equal(absent.tombstones.length, 1)
  const restored = row('a', { version: 8, trashedAt: '', deletionId: '', restoreOf: 'd4', restoreId: 'r8' })
  const view = projectJournal({ journal: overview(), records: [tombstone, restored, tombstone], date: today })
  assert.equal(view.journal.entries[0].version, 8); assert.equal(view.tombstones.length, 0)
})

test('a permanent deletion marker alone is sufficient to keep a queued record hidden', () => {
  const { projectJournal } = require('../miniprogram/utils/journal-intents')
  const view = projectJournal({ journal: overview(), date: today, records: [row('a', { version: 10, permanentlyPurgedAt: 'then', deletionId: 'd' }),
    row('a', { version: 11, restoreOf: 'd', restoreId: 'r' })],
    queue: [{ id: 'old', action: 'journal.create', payload: { id: 'a', content: '原文', date: today } }] })
  assert.equal(view.journal.entries.length, 0); assert.equal(view.tombstones.length, 1)
})

test('scope transition before onShow rejects old clicks and old completion callbacks', async () => {
  const r = pageRuntime(), reply = deferred(); let calls = 0
  r.api.call = () => { calls++; return reply.promise }
  const pending = r.p.mutateRecord(event({ action: 'favorite' }))
  r.cache.adoptScope({ account: { user: { id: 'other' }, workspaceId: 'B' } })
  r.cache.write(r.cache.KEYS.journal, overview(row('b')))
  await r.p.mutateRecord(event({ action: 'hide' })); assert.equal(calls, 1)
  reply.resolve(row('a', { favoritedAt: 'now' })); await pending
  assert.deepEqual(r.cache.read(r.cache.KEYS.journal).entries.map((entry) => entry.id), ['b'])
  r.p.onShow(); assert.ok(r.p.findEntry('b')); assert.ok(!r.p.findEntry('a'))
})

test('duplicate field clicks share one in-flight operation while a different field can proceed', async () => {
  const r = pageRuntime(), reply = deferred(); const calls = []
  r.api.call = (action) => { calls.push(action); return reply.promise }
  const first = r.p.mutateRecord(event({ action: 'favorite' }))
  await r.p.mutateRecord(event({ action: 'favorite' }))
  const second = r.p.toggleItem(event())
  assert.deepEqual(calls, ['capture.setFavorite', 'journal.toggleItem'])
  reply.resolve({ queued: true }); await Promise.all([first, second])
  assert.equal(r.p.journalActions.size, 0)
})

test('journal field action with a full local store sends nothing and does not claim saved', async () => {
  const r = pageRuntime(); let network = 0
  global.wx.cloud.callFunction = async () => { network++; throw new Error('must not send') }
  const write = global.wx.setStorageSync
  global.wx.setStorageSync = (key, value) => { if (key.endsWith('.queue')) throw new Error('storage full'); write(key, value) }
  await r.p.mutateRecord(event({ action: 'favorite' }))
  assert.equal(network, 0); assert.doesNotMatch(r.p.data.syncMessage, /已保存/)
  assert.equal(r.cache.read(r.cache.KEYS.queue).length, 0)
  assert.ok(!r.cache.read(r.cache.KEYS.journal).entries[0].favoritedAt)
})

test('pending checklist preserves Markdown prose and supplements deduplicate by stable ID', async (t) => {
  const r = runtime(); t.after(() => r.api.__test.cancelDirtyFlushTimer()); await r.api.bootstrap()
  const text = '# 感悟\n\n不确定是否完成，成本 120 元。\n\n- [ ] 处理\n\n```md\n- [ ] 处理\n```\n'
  r.cache.write(r.cache.KEYS.journal, overview(row('a', { markdown: text, organizedContent: text })))
  await r.api.call('journal.toggleItem', { entryId: 'a', itemId: 'item', done: true })
  const payload = { entryId: 'a', supplementId: 's', content: '  后续补充\n\n仍然不确定。\n' }
  await r.api.call('journal.append', payload, { requestId: 'append' })
  await r.api.call('journal.append', payload, { requestId: 'append' })
  const a = r.cache.read(r.cache.KEYS.journal).entries[0]
  assert.equal(a.markdown, text.replace('- [ ] 处理', '- [x] 处理'))
  assert.equal(a.journalSupplements.length, 1); assert.equal(a.journalSupplements[0].content, payload.content)
  assert.equal(r.cache.read(r.cache.KEYS.queue).length, 2)
})

for (const all of [false, true]) test(`confirmed proposal ${all ? 'all' : 'single'} fetches a fresh decision list and retains arrivals during the read`, async () => {
  const r = pageRuntime(), arrived = deferred(), release = deferred(); const reads = []
  r.p.applyProposals([{ id: 'a', status: 'pending', version: 1 }])
  r.api.call = async (action, payload, options = {}) => {
    if (action.startsWith('proposal.apply')) return all ? { applied: 1 } : { proposal: { id: 'a', status: 'applied', version: 2 } }
    assert.equal(action, 'proposal.list'); reads.push(options)
    arrived.resolve(); await release.promise
    return { complete: true, proposals: [{ id: 'c', status: 'pending', version: 2, title: '旧回复' }] }
  }
  const pending = all ? r.p.applyAllProposals() : r.p.handleProposal(event({ action: 'apply' }))
  await arrived.promise
  r.p.applyProposals([{ id: 'a', status: 'pending', version: 1 }, { id: 'b', status: 'pending', version: 1 },
    { id: 'c', status: 'pending', version: 5, title: '等待期间的新正文' }])
  release.resolve(); await pending
  assert.equal(reads.length, 1); assert.equal(reads[0].forceRemote, true)
  assert.ok(!r.p.data.proposals.some((row) => row.id === 'a'))
  assert.ok(r.p.data.proposals.some((row) => row.id === 'b'))
  assert.equal(r.p.data.proposals.find((row) => row.id === 'c').title, '等待期间的新正文')
})

test('partial proposal read cannot remove off-page decisions and a failed read cannot claim a refreshed list', async () => {
  const r = pageRuntime(); r.p.applyProposals([{ id: 'old', status: 'pending', version: 1 }])
  r.api.call = async () => ({ complete: false, proposals: [{ id: 'new', status: 'pending', version: 1 }] })
  await r.p.refresh({ silent: true, skipCandidateRefresh: true, forceProposals: true })
  assert.deepEqual(new Set(r.p.data.proposals.map((row) => row.id)), new Set(['old', 'new']))
  r.api.call = async (action) => { if (action === 'proposal.applyAll') return { applied: 2 }; throw new Error('read interrupted') }
  await r.p.applyAllProposals()
  assert.match(r.p.data.syncMessage, /列表更新失败/)
  assert.equal(r.p.data.proposals.length, 2)
})

test('cloud proposal list declares completeness before filtering and never treats a capped page as complete', async () => {
  const { cloudRuntime } = require('./helpers/cloud-runtime.cjs')
  for (const count of [2, 205]) {
    const cloud = cloudRuntime()
    for (let i = 0; i < count; i++) cloud.rows.set(`proposals/p${i}`, { id: `p${i}`, ownerOpenId: 'space', status: 'pending',
      type: 'today_todo', suggestedHandling: 'ask_user', deletedAt: '', createdAt: String(i).padStart(4, '0') })
    const response = await cloud.api.executeMutation('space', 'proposal.list', {})
    assert.equal(response.data.complete, count < 200)
    assert.equal(response.data.proposals.length, Math.min(200, count))
  }
})
