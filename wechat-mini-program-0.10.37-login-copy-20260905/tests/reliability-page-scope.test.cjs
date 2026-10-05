const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function scopedRuntime(pageName) {
  let scope = 'A'
  let definition
  const storage = new Map()
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const keys = pageName === 'tasks'
    ? { diaryDraftState: 'diaryDraftState', diaryDraft: 'diaryDraft', diaryDays: 'diaryDays', todayTodos: 'todayTodos', journal: 'journal', tasks: 'tasks', diaryOrganization: 'diaryOrganization' }
    : { journalArchive: 'journalArchive', trash: 'trash' }
  const scopedKey = (key) => `${scope}:${key}`
  const cache = {
    KEYS: keys,
    scopeToken: () => scope,
    requestId: (prefix) => `${prefix}-id`,
    read: (key, fallback) => storage.has(scopedKey(key)) ? structuredClone(storage.get(scopedKey(key))) : fallback,
    write: (key, value) => { storage.set(scopedKey(key), structuredClone(value)); return value }
  }
  const feedback = { fromCache: () => ({ message: '', tone: 'idle', pending: 0 }) }
  const api = {
    call: () => pending,
    getHybridStatus: () => ({ mode: 'cloud' })
  }
  const app = { subscribeSync: () => () => {} }
  const filename = path.join(__dirname, '../miniprogram/pages', pageName, 'index.js')
  new Function('require', 'Page', 'wx', 'getApp', fs.readFileSync(filename, 'utf8'))(
    (id) => id.includes('/api') ? api : id.includes('/cache') ? cache : id.includes('sync-feedback') ? feedback : {
      shanghaiDateKey: () => '2026-09-25',
      buildDiaryView: () => ({ todayDateLabel: '', summary: '', summaryNodes: [], sourceLabel: '', updatedLabel: '', periods: [], manualInputs: [], stats: {}, newTodos: [], completed: [], todoNotes: [], journals: [], pastDiaryDays: [] })
    },
    (value) => { definition = value },
    { showToast() {}, showModal() {} },
    () => app
  )
  const page = { ...definition, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, structuredClone(patch)) } }
  return { page, cache, storage, release(value) { release(value) }, switchScope(next) { scope = next }, currentScope: () => scope }
}

test('a late task refresh cannot write the old workspace into the new workspace', async () => {
  const r = scopedRuntime('tasks')
  r.page.onLoad(); r.page.onShow()
  const refresh = r.page.refresh()
  r.switchScope('B')
  r.release({ tasks: [{ id: 'private-A', title: 'A 的任务' }] })
  await refresh
  assert.equal(r.cache.read(r.cache.KEYS.tasks, undefined), undefined)
})

test('a late archive refresh cannot write the old workspace into the new workspace', async () => {
  const r = scopedRuntime('archive')
  r.page.onLoad(); r.page.onShow()
  const refresh = r.page.refresh()
  r.switchScope('B')
  r.release({ entries: [{ id: 'private-A' }] })
  await refresh
  assert.equal(r.cache.read(r.cache.KEYS.journalArchive, undefined), undefined)
})

test('archive page clears the previous workspace before reading the next cache', () => {
  const r = scopedRuntime('archive')
  r.page.onLoad(); r.page.onShow()
  r.page.setData({ entries: [{ id: 'private-A' }], trashItems: [{ id: 'trash-A' }] })
  r.switchScope('B'); r.page.onShow()
  assert.deepEqual(r.page.data.entries, [])
  assert.deepEqual(r.page.data.trashItems, [])
})

function accountRuntime() {
  let scope = 'A'
  let definition
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const storage = new Map()
  const cache = {
    KEYS: { bootstrap: 'bootstrap' },
    scopeToken: () => scope,
    currentHomeTarget: () => '',
    read: (key, fallback) => storage.has(`${scope}:${key}`) ? structuredClone(storage.get(`${scope}:${key}`)) : fallback,
    write: (key, value) => { storage.set(`${scope}:${key}`, structuredClone(value)); return value }
  }
  const api = {
    call: () => pending,
    bootstrap: async () => ({ onboardingRequired: false, account: null }),
    homeConnection: () => ({ serverBaseUrl: '', token: '' }),
    getHybridStatus: () => ({ mode: 'local' }),
    previewHomeRecovery: () => ({ items: [], unscoped: 0 })
  }
  const wx = { showToast() {}, showModal() {}, cloud: { callFunction: async () => ({ result: { ok: true } }) } }
  new Function('require', 'Page', 'wx', 'getApp', fs.readFileSync(path.join(__dirname, '../miniprogram/pages/account/index.js'), 'utf8'))(
    (id) => id.includes('/api') ? api : id.includes('/cache') ? cache : id.includes('/config') ? { cloudSyncEnabled: true, apiFunction: 'notebookApi', clientVersion: 'test' } : id.includes('home-connection-text') ? { parseHomeConnectionText: () => ({}) } : { fromCache: () => ({}) },
    (value) => { definition = value }, wx, () => ({})
  )
  const page = { ...definition, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, structuredClone(patch)) } }
  return { page, release(value) { release(value) }, switchScope(next) { scope = next } }
}

test('a late account action cannot write an invite into a switched workspace', async () => {
  const r = accountRuntime()
  r.page.onShow()
  const running = r.page.createInvite()
  r.switchScope('B')
  r.release({ code: 'STALE-A' })
  await running
  assert.equal(r.page.data.invite, null)
})

test('account page clears members and desktop approval state on workspace change', () => {
  const r = accountRuntime()
  r.page.onShow()
  r.page.setData({ account: { workspaceId: 'A' }, members: [{ id: 'member-A' }], invite: { code: 'A' }, desktopQrStatus: 'pending' })
  r.switchScope('B'); r.page.onShow()
  assert.deepEqual(r.page.data.members, [])
  assert.equal(r.page.data.invite, null)
  assert.equal(r.page.data.desktopQrStatus, '')
})

function onboardingRuntime() {
  let scope = 'A'
  let definition
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const storage = new Map()
  const cache = {
    KEYS: { bootstrap: 'bootstrap' },
    scopeToken: () => scope,
    requestId: () => 'workspace-create-A',
    read: (key, fallback) => fallback,
    write: (key, value) => { storage.set(`${scope}:${key}`, structuredClone(value)); return value }
  }
  const api = { call: () => pending }
  new Function('require', 'Page', 'wx', 'getApp', fs.readFileSync(path.join(__dirname, '../miniprogram/pages/onboarding/index.js'), 'utf8'))(
    (id) => id.includes('/api') ? api : id.includes('/cache') ? cache : { cloudSyncEnabled: true },
    (value) => { definition = value },
    { getStorageSync: key => storage.get(key) || '', setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key), reLaunch() {} },
    () => ({})
  )
  const page = { ...definition, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, structuredClone(patch)) } }
  return { page, release(value) { release(value) }, switchScope(next) { scope = next }, storage }
}

test('a late personal-space creation cannot write its bootstrap into a switched workspace', async () => {
  const r = onboardingRuntime()
  r.page.onLoad({})
  r.page.setData({ stage: 'create' })
  const running = r.page.createPersonalSpace()
  r.switchScope('B')
  r.release({ account: { workspaceId: 'workspace-A' } })
  await running
  assert.equal(r.storage.has('A:bootstrap'), false)
  assert.equal(r.storage.has('B:bootstrap'), false)
})
