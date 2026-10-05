const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { scopedClient } = require('./helpers/scoped-client.cjs')
const { compileCommonJs } = require('./helpers/client.cjs')

function loadPage(call) {
  const { cache } = scopedClient(async () => { throw new Error('not used') })
  cache.adoptScope({ account: { user: { id: 'u' }, workspaceId: 'A' } })
  let date = '2026-09-24', page
  const messages = []
  const presenter = compileCommonJs(path.resolve(__dirname, '../miniprogram/pages/tasks/diary-presenter.js'))
  const feedback = compileCommonJs(path.resolve(__dirname, '../miniprogram/utils/sync-feedback.js'))
  const file = path.resolve(__dirname, '../miniprogram/pages/tasks/index.js')
  new Function('require', 'Page', 'wx', 'getApp', fs.readFileSync(file, 'utf8'))(
    (id) => id.includes('/api') ? { call, organizePendingDiaries: (options) => call('diary.organizationStep', options), getHybridStatus: () => ({ mode: 'cloud', pendingLocal: 0 }) } : id.includes('/cache') ? cache : id.includes('sync-feedback') ? feedback : { ...presenter, shanghaiDateKey: () => date },
    (value) => { page = value },
    { showLoading() {}, hideLoading() {}, showToast: (value) => messages.push(value.title) },
    () => ({ subscribeSync: () => () => {} })
  )
  page.data = structuredClone(page.data)
  page.setData = (patch, callback) => { Object.assign(page.data, patch); callback?.() }
  page.onLoad()
  page.onShow()
  return { page, cache, messages, date: (value) => { date = value } }
}

test('save acknowledgement cannot clear text entered while the original was uploading', async () => {
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const calls = []
  const c = loadPage(async (action, payload) => {
    calls.push({ action, payload })
    if (action === 'diary.appendInput') { await pending; return { acceptedInputId: payload.inputId, day: { date: payload.date }, queued: true } }
    throw new Error('AI must not start before cloud acknowledgement')
  })
  c.page.onDiaryInput({ detail: { value: 'first' } })
  const saving = c.page.organizeDiaryInput()
  c.page.onDiaryInput({ detail: { value: 'new text while uploading' } })
  release()
  await saving
  assert.equal(c.page.data.diaryInput, 'new text while uploading')
  assert.equal(c.cache.read(c.cache.KEYS.diaryDraftState).content, 'new text while uploading')
  assert.equal(calls.length, 1)
})

test('retry after ambiguous save response reuses the same input id, and AI failure does not restore an already saved draft', async () => {
  const ids = []
  const c = loadPage(async (action, payload) => {
    if (action === 'diary.organizationStep') throw new Error('AI offline')
    ids.push(payload.inputId)
    if (ids.length === 1) throw new Error('response lost')
    return { acceptedInputId: payload.inputId, day: { date: payload.date } }
  })
  c.page.onDiaryInput({ detail: { value: 'original' } })
  await c.page.organizeDiaryInput()
  assert.equal(c.page.data.diaryInput, 'original')
  await c.page.organizeDiaryInput()
  await c.page.organizationPromise
  assert.equal(ids[0], ids[1])
  assert.equal(c.page.data.diaryInput, '')
  assert.equal(c.messages.at(-1), '原文已保存，整理待重试')
})

test('midnight refresh advances the page while preserving the existing draft date', async () => {
  let saved
  const c = loadPage(async (action, payload) => { saved = payload; return { acceptedInputId: payload.inputId, day: { date: payload.date }, queued: true } })
  c.page.onDiaryInput({ detail: { value: 'yesterday reflection' } })
  c.date('2026-09-25')
  c.page.onShow()
  assert.equal(c.page.data.todayDate, '2026-09-25')
  await c.page.organizeDiaryInput()
  assert.equal(saved.date, '2026-09-24')
})

test('a save callback from the old workspace cannot clear or repopulate the new workspace draft', async () => {
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const c = loadPage(async (action, payload) => { await pending; return { acceptedInputId: payload.inputId, day: { date: payload.date } } })
  c.page.onDiaryInput({ detail: { value: 'A original' } })
  const saving = c.page.organizeDiaryInput()
  c.cache.adoptScope({ account: { user: { id: 'u' }, workspaceId: 'B' } })
  c.page.applyPage()
  c.page.onDiaryInput({ detail: { value: 'B draft' } })
  release()
  await saving
  assert.equal(c.page.data.diaryInput, 'B draft')
  assert.equal(c.cache.read(c.cache.KEYS.diaryDraftState).content, 'B draft')
  assert.equal(c.page.data.organizingDiaryInput, false)
  assert.equal(c.messages.length, 0)
})

test('saving returns with an editable new draft while the AI task is still running', async () => {
  let release
  const waiting = new Promise((resolve) => { release = resolve })
  const c = loadPage(async (action, payload) => {
    if (action === 'diary.appendInput') return { acceptedInputId: payload.inputId, day: { date: payload.date } }
    await waiting
    return { organizationJob: { status: 'complete' } }
  })
  c.page.onDiaryInput({ detail: { value: '第一段' } })
  await c.page.organizeDiaryInput()
  assert.equal(c.page.data.organizingDiaryInput, false)
  c.page.onDiaryInput({ detail: { value: '继续写第二段' } })
  release()
  await c.page.organizationPromise
  assert.equal(c.page.data.diaryInput, '继续写第二段')
  assert.equal(c.cache.read(c.cache.KEYS.diaryDraftState).content, '继续写第二段')
})
