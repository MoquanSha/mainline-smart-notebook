const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { scopedClient } = require('./helpers/scoped-client.cjs')
const { cloudRuntime } = require('./helpers/cloud-runtime.cjs')
const { createJournalOrganization } = require('../miniprogram/utils/journal-organization')

function fixture(handler) {
  const { cache } = scopedClient(async () => { throw new Error('not used') })
  cache.adoptScope({ account: { user: { id: 'u' }, workspaceId: 'A' } })
  cache.write(cache.KEYS.bootstrap, { capabilities: { journalOrganization: 1 } })
  const row = { id: 'journal', rawContent: '原文', content: '原文', version: 1, organizationStatus: 'pending' }
  cache.write(cache.KEYS.journal, { entries: [row] })
  let visible = true, now = 1000
  const calls = [], events = []
  const create = () => createJournalOrganization({ cache, isVisible: () => visible, now: () => now,
    notify: (event) => events.push(event), request: async (payload) => { calls.push(payload); return handler(payload, cache) } })
  return { cache, row, calls, events, create, visible: (value) => { visible = value }, now: (value) => { now = value } }
}

test('queued journal originals wait for upload confirmation and idle triggers do not restart completed work', async () => {
  let completed = 0
  const c = fixture(async () => ({ organizationJob: { id: 'job', status: ++completed < 2 ? 'pending' : 'complete', completed, total: 2 } }))
  c.cache.write(c.cache.KEYS.queue, [{ action: 'journal.create', payload: { id: c.row.id } }])
  await c.create().resume()
  assert.equal(c.calls.length, 0)
  c.cache.write(c.cache.KEYS.queue, [])
  const worker = c.create()
  await Promise.all([worker.resume(), worker.resume()])
  assert.equal(c.calls.length, 2)
  assert.deepEqual(c.calls[0], { entryId: 'journal', retry: false })
  await c.create().resume()
  assert.equal(c.calls.length, 2)
})

test('background interrupts the next part and a new foreground coordinator continues', async () => {
  let completed = 0
  const c = fixture(async () => { c.visible(false); return { organizationJob: { id: 'job', status: ++completed < 2 ? 'pending' : 'complete', completed, total: 2 } } })
  await c.create().resume()
  assert.equal(c.calls.length, 1)
  c.visible(true)
  await c.create().resume()
  assert.equal(c.calls.length, 2)
})

test('a late response from A cannot write job status into B or start its next part', async () => {
  let enter, release
  const waiting = new Promise((resolve) => { release = resolve }), started = new Promise((resolve) => { enter = resolve })
  const c = fixture(async () => { enter(); await waiting; return { organizationJob: { id: 'A', status: 'pending', completed: 1, total: 2 } } })
  const running = c.create().resume()
  await started
  c.cache.adoptScope({ account: { user: { id: 'u' }, workspaceId: 'B' } })
  release(); await running
  assert.equal(c.calls.length, 1)
  assert.deepEqual(c.cache.read(c.cache.KEYS.journalOrganization, {}), {})
  assert.equal(c.events.length, 1)
})

test('ambiguous failures persist cooldown; explicit retry and changed originals can proceed', async () => {
  let attempt = 0
  const c = fixture(async () => { if (++attempt === 1) throw new Error('timeout'); return { organizationJob: { id: 'job', status: 'complete', completed: 1, total: 1 } } })
  await c.create().resume(); await c.create().resume()
  assert.equal(c.calls.length, 1)
  await c.create().resume({ entryId: 'journal', retry: true })
  assert.equal(c.calls.length, 2)
  c.cache.write(c.cache.KEYS.journal, { entries: [{ ...c.row, rawContent: '另一段原文' }] })
  await c.create().resume()
  assert.equal(c.calls.length, 3)
})

test('unsupported server, deleted entries and hidden app never start automatic journal AI', async () => {
  const c = fixture(async () => { throw new Error('not called') })
  c.cache.write(c.cache.KEYS.bootstrap, {})
  await c.create().resume()
  c.cache.write(c.cache.KEYS.bootstrap, { capabilities: { journalOrganization: 1 } })
  c.visible(false); await c.create().resume()
  c.visible(true); c.cache.write(c.cache.KEYS.journal, { entries: [{ ...c.row, deletedAt: 'deleted' }] })
  await c.create().resume()
  assert.equal(c.calls.length, 0)
})

test('receiving a desktop-owned pending original does not start a duplicate cloud model task', async () => {
  const c = fixture(async () => { throw new Error('must not call model'); })
  c.cache.write(c.cache.KEYS.journal, { entries: [{ ...c.row, organizationHost: 'desktop' }] })
  await c.create().resume(); await c.create().resume({ entryId: c.row.id, retry: true })
  assert.equal(c.calls.length, 0)
  const view = require('../miniprogram/pages/capture/presenter').present({ ...c.row, organizationHost: 'desktop', organizationStatus: 'failed' })
  assert.equal(view.organizationCanRetry, false)
  assert.match(view.organizerLabel, /电脑继续整理/)
})

test('actual page, API queue, app trigger and cloud dispatcher complete an offline long journal without losing the next draft', async (t) => {
  let modelCalls = 0
  const cloud = cloudRuntime([], { generateText: async ({ messages }) => {
    modelCalls++
    const part = JSON.parse(messages[1].content)
    return { text: JSON.stringify({ title: '我的原文', summary: '目录摘要', markdown: part.content, type: 'note', items: [] }) }
  } })
  const account = { user: { id: 'user' }, workspaceId: 'A' }
  const principal = { userId: 'user', workspaceId: 'A', role: 'owner' }
  const calls = []
  const client = scopedClient(async ({ data }) => {
    calls.push(data.action)
    if (data.action === 'bootstrap') return { result: { ok: true, data: { account, capabilities: { journalOrganization: 1 } } } }
    const result = await cloud.api.executeMutation('A', data.action, data.payload, principal, data.requestId)
    return { result: { ok: true, data: result.data } }
  })
  let app, definition
  new Function('require', 'App', fs.readFileSync(path.resolve(__dirname, '../miniprogram/app.js'), 'utf8'))(
    (id) => id.includes('config') ? {} : id.endsWith('/api') ? client.api : client.cache, (value) => { app = value })
  app.appVisible = true
  global.getApp = () => app
  const pageFile = path.resolve(__dirname, '../miniprogram/pages/capture/index.js'), native = createRequire(pageFile)
  new Function('require', 'Page', fs.readFileSync(pageFile, 'utf8'))(
    (id) => id === '../../utils/api' ? client.api : id === '../../utils/cache' ? client.cache : native(id), (value) => { definition = value })
  const page = { ...definition, data: structuredClone(definition.data), setData(value) { Object.assign(this.data, structuredClone(value)) } }
  t.after(() => { client.api.__test.cancelDirtyFlushTimer(); clearTimeout(app.syncNotifyTimer); page.onUnload() })
  await client.api.bootstrap(); page.onLoad(); page.onShow()
  const content = '甲'.repeat(3000) + '乙'.repeat(3000) + '可能没有完成，123.45 元。'
  page.onInput({ detail: { value: content } })
  await page.createEntry()
  assert.equal(modelCalls, 0)
  const id = client.cache.read(client.cache.KEYS.queue, [])[0].payload.id
  assert.equal(client.cache.read(client.cache.KEYS.queue, [])[0].payload.deferOrganization, true)
  page.onInput({ detail: { value: '新的草稿不能丢失' } })
  await client.api.flushDirtyQueueNow()
  const continuation = await client.api.organizePendingJournals()
  assert.equal(modelCalls, 3, JSON.stringify({ calls, continuation, queue: client.cache.read(client.cache.KEYS.queue, []).map((row) => ({ action: row.action, status: row.status, error: row.lastError })),
    capability: client.cache.read(client.cache.KEYS.bootstrap, {}).capabilities,
    rows: client.cache.read(client.cache.KEYS.journal, {}).entries?.map((row) => ({ id: row.id, pending: row.pending, organizationStatus: row.organizationStatus })) }))
  assert.equal(client.cache.read(client.cache.KEYS.queue, []).length, 0)
  page.applyOverview(client.cache.read(client.cache.KEYS.journal), false)
  const entry = page.findEntry(id)
  assert.equal(entry.organizationStatus, 'organized')
  assert.ok(entry.displaySummary.endsWith('可能没有完成，123.45 元。'))
  assert.equal(entry.originalContent, content)
  assert.equal(page.data.content, '新的草稿不能丢失')
  page.toggleOriginal({ currentTarget: { dataset: { id } } })
  assert.equal(page.findEntry(id).showOriginal, true)
  const previous = calls.length
  app.notifySyncListeners({ type: 'sync-cycle' })
  await client.api.organizePendingJournals()
  assert.equal(calls.length, previous)
})
