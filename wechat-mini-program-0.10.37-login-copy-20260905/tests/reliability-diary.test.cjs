const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { loadClient } = require('./helpers/client.cjs')
const { scopedClient } = require('./helpers/scoped-client.cjs')
const { splitInputs } = require('../cloudfunctions/notebookApi/diary-store.js')

function loadCloud(generateText = async () => { throw new Error('AI offline') }) {
  const rows = new Map()
  let chain = Promise.resolve()
  const collection = (store, name) => ({
    doc: (id) => ({
      get: async () => ({ data: store.has(`${name}/${id}`) ? [structuredClone(store.get(`${name}/${id}`))] : [] }),
      set: async (data) => { store.set(`${name}/${id}`, structuredClone(data)); return {} },
      update: async (patch) => {
        if (!store.has(`${name}/${id}`)) return { updated: 0 }
        store.set(`${name}/${id}`, { ...store.get(`${name}/${id}`), ...structuredClone(patch) })
        return { updated: 1 }
      }
    }),
    where: () => ({ orderBy() { return this }, limit() { return this }, get: async () => ({ data: [] }) })
  })
  const db = {
    command: { inc: (n) => n }, collection: (name) => collection(rows, name),
    runTransaction: (callback) => {
      const operation = chain.then(async () => {
        const snapshot = new Map(structuredClone([...rows]))
        const result = await callback({ collection: (name) => collection(snapshot, name) })
        for (const [key, value] of snapshot) rows.set(key, value)
        return result
      })
      chain = operation.catch(() => {})
      return operation
    }
  }
  const file = path.resolve(__dirname, '../cloudfunctions/notebookApi/index.js')
  const native = createRequire(file)
  const module = { exports: {} }
  new Function('require', 'module', 'exports', fs.readFileSync(file, 'utf8'))(
    (id) => id === '@cloudbase/node-sdk' ? { init: () => ({ database: () => db, ai: () => ({ createModel: () => ({ generateText }) }) }) } : native(id), module, module.exports
  )
  const desktopFile = path.resolve(__dirname, '../cloudfunctions/desktopSync/index.js')
  const desktopModule = { exports: {} }
  new Function('require', 'module', 'exports', fs.readFileSync(desktopFile, 'utf8'))(
    (id) => id === '@cloudbase/node-sdk' ? { init: () => ({ database: () => db }) } : createRequire(desktopFile)(id), desktopModule, desktopModule.exports
  )
  return { api: module.exports.__test, desktop: desktopModule.exports.__test, rows, day: () => [...rows].find(([key]) => key.startsWith('day_records/'))?.[1] }
}

test('diary original is durable without an AI call, replays once, and never silently truncates', async () => {
  let aiCalls = 0
  const cloud = loadCloud(async () => { aiCalls++; throw new Error('must not invoke') })
  const payload = { date: '2026-09-23', inputId: 'original-a', content: '原文🙂'.repeat(2000) + '不是已经完成，也许明天完成，费用 123.45 元。' }
  await Promise.all([cloud.api.appendDailyDiary('space-a', payload), cloud.api.appendDailyDiary('space-a', payload)])
  assert.equal(aiCalls, 0)
  assert.equal(cloud.day().manualInputs.length, 1)
  assert.equal(cloud.day().manualInputs[0].content, payload.content)
  assert.equal(cloud.day().version, 1)
  const replay = await cloud.api.appendDailyDiary('space-a', payload)
  assert.equal(replay.replay, true)
  assert.equal(replay.day.manualInputs[0].content, payload.content)
  await assert.rejects(cloud.api.appendDailyDiary('space-a', { ...payload, content: 'different' }), { code: 'INPUT_ID_CONFLICT' })
})

test('an old AI response cannot overwrite another original added while it was running', async () => {
  let entered, release
  const started = new Promise((resolve) => { entered = resolve })
  const waiting = new Promise((resolve) => { release = resolve })
  const cloud = loadCloud(async () => { entered(); await waiting; return { text: JSON.stringify({ summary: '## 今日记录\n\nOLD' }) } })
  const payload = { date: '2026-09-24', inputId: 'first', content: 'first original' }
  const organizing = cloud.api.refreshDailyDiary('space-a', payload, { requireInput: true })
  await started
  assert.equal(cloud.day().manualInputs[0].content, 'first original')
  await cloud.api.appendDailyDiary('space-a', { ...payload, inputId: 'second', content: 'second original' })
  release()
  const result = await organizing
  assert.equal(result.stale, true)
  assert.deepEqual(cloud.day().manualInputs.map((item) => item.id), ['first', 'second'])
  assert.ok(!cloud.day().summary.includes('OLD'))
})

test('AI failure preserves originals and long text is sent in complete unicode-safe segments', async () => {
  const cloud = loadCloud()
  const content = '甲🙂否定'.repeat(1600) + '结尾 999，不确定'
  await cloud.api.appendDailyDiary('space-a', { date: '2026-09-24', inputId: 'long', content })
  const result = await cloud.api.refreshDailyDiary('space-a', { date: '2026-09-24' })
  assert.equal(result.day.manualInputs[0].content, content)
  assert.ok(result.day.summary.includes(content))
  assert.equal(splitInputs([{ id: 'long', content }]).map((part) => part.content).join(''), content)
  assert.ok(splitInputs([{ id: 'long', content }]).every((part) => Array.from(part.content).length <= 3000))
})

test('retry after a middle-segment failure reuses completed AI segments instead of paying for them again', async () => {
  const parts = ['甲'.repeat(3000), '乙'.repeat(3000), '丙'.repeat(1000)]
  const calls = new Map()
  const cloud = loadCloud(async (request) => {
    const part = JSON.parse(request.messages[1].content).manualInputs[0].content
    calls.set(part, (calls.get(part) || 0) + 1)
    if (part === parts[1] && calls.get(part) === 1) throw new Error('middle segment network failure')
    return { text: JSON.stringify({ summary: '## 今日记录\n\n' + part }) }
  })
  await cloud.api.appendDailyDiary('space-a', { date: '2026-09-24', inputId: 'three', content: parts.join('') })
  await cloud.api.refreshDailyDiary('space-a', { date: '2026-09-24' })
  assert.equal(cloud.day().manualInputs[0].content, parts.join(''))
  const result = await cloud.api.refreshDailyDiary('space-a', { date: '2026-09-24' })
  assert.equal(calls.get(parts[0]), 1)
  assert.equal(calls.get(parts[1]), 2)
  assert.equal(calls.get(parts[2]), 1)
  assert.ok(parts.every((part) => result.day.summary.includes(part)))
})

test('concurrent organization of identical inputs shares one running AI job', async () => {
  let release, entered
  const waiting = new Promise((resolve) => { release = resolve })
  const started = new Promise((resolve) => { entered = resolve })
  let calls = 0
  const cloud = loadCloud(async () => { calls++; entered(); await waiting; return { text: '{"summary":"## 今日记录\\n\\n原文"}' } })
  await cloud.api.appendDailyDiary('space-a', { date: '2026-09-24', inputId: 'one', content: '原文' })
  const first = cloud.api.refreshDailyDiary('space-a', { date: '2026-09-24' })
  await started
  const second = cloud.api.refreshDailyDiary('space-a', { date: '2026-09-24' })
  await new Promise((resolve) => setImmediate(resolve))
  release()
  await Promise.all([first, second])
  assert.equal(calls, 1)
})

test('actual mobile upload receipt triggers app-level bounded organization and persists confirmed full diary', async (t) => {
  let modelCalls = 0
  const cloud = loadCloud(async (request) => {
    modelCalls++
    return { text: JSON.stringify({ summary: '## 今日记录\n\n' + JSON.parse(request.messages[1].content).manualInputs[0].content }) }
  })
  const account = { user: { id: 'user' }, workspaceId: 'A' }
  const principal = { userId: 'user', workspaceId: 'A', openId: 'wx-user', role: 'owner' }
  const actions = []
  const client = scopedClient(async ({ data }) => {
    actions.push(data.action)
    if (data.action === 'bootstrap') return { result: { ok: true, data: { account, capabilities: { diaryOrganization: 1 } } } }
    const result = await cloud.api.executeMutation('A', data.action, data.payload, principal, data.requestId)
    return { result: { ok: true, data: result.data } }
  })
  let app
  new Function('require', 'App', fs.readFileSync(path.resolve(__dirname, '../miniprogram/app.js'), 'utf8'))(
    (id) => id.includes('config') ? {} : id.endsWith('/api') ? client.api : client.cache,
    (value) => { app = value })
  app.appVisible = true
  global.getApp = () => app
  t.after(async () => {
    app.onHide()
    await Promise.allSettled([app.syncPromise, app.foregroundSyncPromise].filter(Boolean))
    client.api.__test.cancelDirtyFlushTimer(); clearTimeout(app.syncNotifyTimer)
  })
  await client.api.bootstrap()
  const content = '甲'.repeat(3000) + '乙'.repeat(3000) + '丙'.repeat(123)
  const local = await client.api.call('diary.appendInput', { date: '2026-09-24', inputId: 'offline', content })
  assert.equal(local.queued, true)
  assert.equal(modelCalls, 0)
  await client.api.flushDirtyQueueNow()
  // The actual app sync-cycle callback has already started the same worker.
  await client.api.organizePendingDiaries()
  assert.equal(client.cache.read(client.cache.KEYS.queue, []).length, 0)
  assert.equal(actions.filter((action) => action === 'diary.organizationStep').length, 3)
  assert.equal(modelCalls, 3)
  const saved = client.cache.read(client.cache.KEYS.diaryDays, [])[0]
  const confirmed = client.cache.read(client.cache.KEYS.confirmedSnapshot, {}).diaryDays[0]
  assert.equal(saved.organizationStatus, 'organized')
  assert.equal(saved.manualInputs[0].pending, false)
  assert.equal(confirmed.summary, saved.summary)
  assert.equal(saved.manualInputs[0].content, content)
  assert.ok(saved.summary.endsWith('丙'.repeat(123)))
  const before = actions.length
  app.notifySyncListeners({ type: 'sync-cycle' })
  await client.api.organizePendingDiaries()
  assert.equal(actions.length, before)
})

test('offline diary save is replayed through the normal queue and its acknowledgement updates the day', async (t) => {
  const client = loadClient(async ({ data }) => ({ result: { ok: true, data: {
    results: data.payload.operations.map((operation) => ({ requestId: operation.requestId, ok: true, data: {
      acceptedInputId: operation.payload.inputId,
      day: { id: 'day_records_2026-09-24', date: '2026-09-24', manualInputs: [{ id: operation.payload.inputId, content: operation.payload.content }], summary: '## 今日记录\n\n原文', version: 1 }
    } }))
  } } }))
  t.after(() => client.api.__test.cancelDirtyFlushTimer())
  const saved = await client.api.call('diary.appendInput', { date: '2026-09-24', inputId: 'offline-1', content: '原文' })
  assert.equal(saved.queued, true)
  assert.equal(client.queue().length, 1)
  const result = await client.api.flushDirtyQueueNow()
  assert.equal(result.flush.sent, 1)
  assert.equal(client.queue().length, 0)
  assert.equal(client.cache.read(client.cache.KEYS.diaryDays, [])[0].manualInputs[0].id, 'offline-1')
})

test('real mobile and desktop handlers use the same cloud document and retain concurrent originals', async () => {
  const cloud = loadCloud()
  const date = '2026-09-24', owner = 'shared-space'
  assert.equal(cloud.api.scopedDayId(owner, date), cloud.desktop.cloudDocumentId(owner, 'day_records', `day_records_${date}`))
  await Promise.all([
    cloud.api.appendDailyDiary(owner, { date, inputId: 'phone', content: '手机原文' }),
    cloud.desktop.pushDiaryOperation(owner, { collection: 'day_records', id: `day_records_${date}`, data: {
      date, summary: '## 今日记录\n\n电脑原文', manualInputs: [{ id: 'desktop', content: '电脑原文', source: 'desktop', createdAt: '2026-09-24T01:00:00Z' }]
    } })
  ])
  assert.equal([...cloud.rows.keys()].filter((key) => key.startsWith('day_records/')).length, 1)
  assert.deepEqual(new Set(cloud.day().manualInputs.map((item) => item.id)), new Set(['phone', 'desktop']))
})

test('legacy phone originals migrate into the canonical desktop day without deleting the recovery record', async () => {
  const cloud = loadCloud()
  const date = '2026-09-23', owner = 'legacy-space'
  const oldKey = `day_records/${cloud.api.workspaceScopedId(owner, `day_${date}`)}`
  const old = { id: `day_records_${date}`, ownerOpenId: owner, date, manualInputs: [{ id: 'old', content: '旧原文', createdAt: '2026-09-23T01:00:00Z' }], summary: '旧原文', version: 4 }
  cloud.rows.set(oldKey, old)
  await cloud.api.appendDailyDiary(owner, { date, inputId: 'new', content: '新原文' })
  assert.deepEqual(cloud.rows.get(oldKey), old)
  const current = cloud.rows.get(`day_records/${cloud.api.scopedDayId(owner, date)}`)
  assert.deepEqual(current.manualInputs.map((input) => input.id), ['old', 'new'])
  assert.equal(current.legacyDiaryMigrated, true)
})

test('oversized legacy diary migration fails explicitly and leaves the recovery record untouched', async () => {
  const cloud = loadCloud()
  const date = '2026-09-22', owner = 'legacy-capacity-space'
  const oldKey = `day_records/${cloud.api.workspaceScopedId(owner, `day_${date}`)}`
  const old = {
    id: `day_records_${date}`, ownerOpenId: owner, date,
    manualInputs: [{ id: 'old', content: '旧原文'.repeat(140000), createdAt: '2026-09-22T01:00:00Z' }],
    summary: '旧原文', version: 4
  }
  cloud.rows.set(oldKey, old)
  await assert.rejects(
    cloud.api.appendDailyDiary(owner, { date, inputId: 'new', content: '新原文' }),
    { code: 'RECORD_CAPACITY' }
  )
  assert.deepEqual(cloud.rows.get(oldKey), old)
  assert.equal([...cloud.rows.keys()].filter((key) => key.startsWith('day_records/')).length, 1)
})

test('desktop upload retains conflicting immutable originals and cannot resurrect a deleted day', async () => {
  const cloud = loadCloud()
  const date = '2026-09-22', owner = 'conflict-space'
  await cloud.api.appendDailyDiary(owner, { date, inputId: 'shared', content: '手机原文' })
  const operation = { id: `day_records_${date}`, data: { date, summary: '## 今日记录\n\n电脑原文', manualInputs: [{ id: 'shared', content: '电脑原文' }] } }
  await cloud.desktop.pushDiaryOperation(owner, operation)
  const key = `day_records/${cloud.api.scopedDayId(owner, date)}`
  assert.deepEqual(new Set(cloud.rows.get(key).manualInputs.map((input) => input.content)), new Set(['手机原文', '电脑原文']))
  cloud.rows.get(key).deletedAt = '2026-09-24T01:00:00Z'
  const retry = await cloud.desktop.pushDiaryOperation(owner, operation)
  // A stale upload may add preserved originals to the tombstone, but the
  // returned cloud document must remain deleted instead of looping forever.
  assert.equal(retry.value.document.deletedAt, '2026-09-24T01:00:00Z')
  assert.deepEqual(new Set(retry.value.document.manualInputs.map((input) => input.content)), new Set(['手机原文', '电脑原文']))
  assert.equal(cloud.rows.get(key).deletedAt, '2026-09-24T01:00:00Z')
  const version = cloud.rows.get(key).version
  assert.equal((await cloud.desktop.pushDiaryOperation(owner, operation)).status, 'unchanged')
  assert.equal(cloud.rows.get(key).version, version)
})
