const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

function pageRuntime(name, receive) {
  let definition, scope = 'a', listener, nextId = 0
  const storage = new Map(), calls = [], timers = new Map()
  const scopedKey = (key) => /DraftState$/.test(String(key)) ? scope + '.' + key : key
  const cache = { KEYS: { journal: 'journal', queue: 'queue', bootstrap: 'bootstrap', historyTransfer: 'history', proposals: 'proposals', todayTodos: 'today',
      journalDraftState: 'journalDraftState', homeDraftState: 'homeDraftState' },
    requestId: (prefix) => prefix + '-' + (++nextId),
    scopeToken: () => scope, read: (key, fallback) => storage.has(scopedKey(key)) ? structuredClone(storage.get(scopedKey(key))) : fallback,
    write: (key, value) => storage.set(scopedKey(key), structuredClone(value)) }
  const api = { getHybridStatus: () => ({ mode: 'cloud', pendingLocal: 0 }),
    splitTodayTodoInput: (text) => [{ title: text, raw: text }],
    prepareTodayTodoPayload: () => ({ clientItems: [{ id: 'new-todo' }] }),
    call: async (action) => { calls.push(action); return action === 'proposal.list' ? { proposals: [] } : { entries: [{ id: 'truncated', content: '限量旧接口' }], history: [] } },
    flushDirtyQueueNow: async () => {}, hasPendingQueue: () => false }
  const app = { subscribeSync(fn) { listener = fn; return () => { listener = null } },
    requestSync: async (reason) => { calls.push(reason); return receive(cache) } }
  const filename = path.join(__dirname, '../miniprogram/pages', name, 'index.js')
  const realRequire = createRequire(filename)
  const context = { Page(value) { definition = value }, getApp: () => app, wx: { getStorageSync: () => false, removeStorageSync() {} },
    require: (id) => id === '../../utils/api' ? api : id === '../../utils/cache' ? cache : id === '../../utils/candidate-refresh'
      ? { refreshIfDue: async () => {} } : realRequire(id),
    setTimeout(fn) { const id = timers.size + 1; timers.set(id, fn); return id }, clearTimeout(id) { timers.delete(id) } }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context)
  const page = { ...definition, data: structuredClone(definition.data), setData(value) {
    for (const [key, next] of Object.entries(value)) {
      const parts = key.split('.')
      let target = this.data
      for (const part of parts.slice(0, -1)) target = target[part] || (target[part] = {})
      target[parts.at(-1)] = structuredClone(next)
    }
  } }
  return { page, api, cache, storage, calls, app, timers, emit: (event) => listener && listener(event), switchScope(next) { scope = next } }
}

test('manual journal refresh receives merged history through the shared sync and shows incomplete reception', async () => {
  const overview = { entries: [], history: [{ date: '2020-01-01', entries: [{ id: 'old', content: '历史原文' }] }] }
  const r = pageRuntime('capture', async (cache) => {
    cache.write(cache.KEYS.journal, overview)
    return { remoteFresh: false, history: { pending: true }, flush: { sent: 1 }, views: { journal: overview }, transport: { mode: 'cloud' } }
  })
  await r.page.syncJournalFromCloud()
  assert.deepEqual(r.calls, ['journal-manual-refresh'], 'manual refresh must not call the bounded overview endpoint')
  assert.equal(r.page.data.history[0].entries[0].id, 'old')
  assert.match(r.page.data.syncMessage, /历史.*接收/)
  assert.notEqual(r.page.data.syncTone, 'ok')
  assert.doesNotMatch(r.page.data.syncMessage, /同步完成|已同步/)
  assert.equal(r.page.data.refreshingJournal, false)
})

test('manual home refresh cannot turn partial history or a failed page into success', async () => {
  for (const error of [null, { code: 'NETWORK', message: '网络中断' }]) {
    const r = pageRuntime('home', async () => ({ remoteFresh: false, history: { pending: true, error }, flush: {}, transport: { mode: 'cloud' } }))
    await r.page.syncComputer()
    assert.notEqual(r.page.data.syncTone, 'ok')
    assert.match(r.page.data.syncMessage, error ? /中断|未完成/ : /历史.*接收/)
    assert.equal(r.page.data.syncingComputer, false)
  }
})

test('failed sync with an empty upload queue never invents a pending item', async () => {
  const r = pageRuntime('home', async () => ({}))
  await r.page.handleRealtimeSync({ type: 'sync-error', error: new Error('接收断网') })
  assert.doesNotMatch(r.page.data.syncMessage, /1 项等待上传/)
  assert.match(r.page.data.syncMessage, /接收|同步.*未完成/)
})

test('blocked writes stay visible even if the cloud receive has completed', async () => {
  const r = pageRuntime('home', async () => ({ remoteFresh: true, flush: {}, transport: { mode: 'cloud' } }))
  r.storage.set('queue', [{ id: 'b', status: 'blocked', lastError: '记录已删除，请恢复或另存' }])
  await r.page.syncComputer()
  assert.equal(r.page.data.syncTone, 'error')
  assert.match(r.page.data.syncMessage, /1 项.*需要处理/)
  assert.match(r.page.data.syncMessage, /已删除/)
})

test('old-space manual completion and error do not touch the new page or new cache', async () => {
  for (const name of ['home', 'capture']) for (const fail of [false, true]) {
    let release
    const r = pageRuntime(name, () => new Promise((resolve, reject) => { release = fail ? () => reject(new Error('A 的错误')) : () => resolve({
      scopeToken: 'a', remoteFresh: true, data: { todos: [{ id: 'private-a', title: 'A 内容' }] }, views: { journal: { entries: [{ id: 'private-a', content: 'A 内容' }] } }
    }) }))
    const promise = name === 'home' ? r.page.syncComputer() : r.page.syncJournalFromCloud()
    r.switchScope('b')
    r.storage.set('journal', { entries: [{ id: 'private-b', content: 'B 内容' }], history: [] })
    r.page.setData({ syncMessage: 'B 页面', refreshingJournal: false, syncingComputer: false })
    release()
    await promise
    assert.equal(r.page.data.syncMessage, 'B 页面')
    assert.equal(r.storage.get('journal').entries[0].id, 'private-b')
    assert.ok(!JSON.stringify(r.page.data).includes('private-a'))
  }
})

test('a completed upload does not claim that the other device has received it', async () => {
  const r = pageRuntime('home', async () => ({ remoteFresh: true, flush: { sent: 1 }, transport: { mode: 'cloud' } }))
  await r.page.syncComputer()
  assert.equal(r.page.data.syncTone, 'ok')
  assert.match(r.page.data.syncMessage, /云端/)
  assert.doesNotMatch(r.page.data.syncMessage, /电脑已|双方|两端.*完成/)
})

test('transport events and page return cannot overwrite a pending-history warning', async () => {
  const r = pageRuntime('home', async () => ({}))
  r.storage.set('history', { protocol: 2, phase: 'history' })
  await r.page.handleRealtimeSync({ type: 'transport-state', state: { mode: 'cloud' } })
  assert.match(r.page.data.syncMessage, /历史.*接收/)
  assert.notEqual(r.page.data.syncTone, 'ok')
  r.page.onShow()
  assert.match(r.page.data.syncMessage, /历史.*接收/)
})

test('switching spaces preserves each unsent input draft instead of clearing it or leaking it', () => {
  for (const name of ['home', 'capture']) {
    const r = pageRuntime(name, async () => ({}))
    r.page.onShow()
    r.page.onInput({ detail: { value: 'A 尚未提交的文字' } })
    r.switchScope('b')
    r.page.onShow()
    const field = name === 'home' ? 'draft' : 'content'
    assert.equal(r.page.data[field], '')
    r.page.onInput({ detail: { value: 'B 尚未提交的文字' } })
    r.switchScope('a')
    r.page.onShow()
    assert.equal(r.page.data[field], 'A 尚未提交的文字')
    r.switchScope('b')
    r.page.onShow()
    assert.equal(r.page.data[field], 'B 尚未提交的文字')
  }
})

test('a delayed save or failure never clears the next text being typed', async () => {
  for (const name of ['home', 'capture']) for (const fail of [false, true]) {
    const r = pageRuntime(name, async () => ({}))
    let release
    r.api.call = () => new Promise((resolve, reject) => {
      release = () => fail ? reject(new Error('保存失败')) : resolve({ queued: true, todos: [] })
    })
    r.page.onInput({ detail: { value: '第一段原文' } })
    const saving = name === 'home' ? r.page.addTodo() : r.page.createEntry()
    assert.equal(typeof release, 'function')
    r.page.onInput({ detail: { value: '等待期间写下的新文字' } })
    release()
    await saving
    const field = name === 'home' ? 'draft' : 'content'
    assert.equal(r.page.data[field], '等待期间写下的新文字')
    const key = name === 'home' ? r.cache.KEYS.homeDraftState : r.cache.KEYS.journalDraftState
    assert.equal(r.cache.read(key).content, '等待期间写下的新文字')
  }
})

test('a delayed today-todo acknowledgement merges records received while it was in flight', async () => {
  const r = pageRuntime('home', async () => ({}))
  let release
  r.api.call = () => new Promise((resolve) => { release = resolve })
  r.page.onInput({ detail: { value: '手机新增待办' } })
  const saving = r.page.addTodo()
  r.page.setData({ todos: [{ id: 'desktop-arrival', title: '期间收到的电脑待办', status: 'planned', version: 4, comments: [] }], completed: [] })
  release({ queued: true, todos: [{ id: 'new-todo', title: '手机新增待办', status: 'planned', version: 1, pending: true, comments: [] }] })
  await saving
  assert.deepEqual(new Set(r.page.data.todos.map((item) => item.id)), new Set(['new-todo', 'desktop-arrival']))
  assert.deepEqual(new Set((r.cache.read(r.cache.KEYS.todayTodos, {}).todos || []).map((item) => item.id)), new Set(['new-todo', 'desktop-arrival']))
})

test('failed draft storage leaves the editor intact and never submits or claims it was saved', async () => {
  for (const name of ['home', 'capture']) {
    const r = pageRuntime(name, async () => ({}))
    r.cache.write = () => { throw Object.assign(new Error('本机存储空间不足'), { code: 'LOCAL_STORAGE_WRITE_FAILED' }) }
    r.page.onInput({ detail: { value: '还在输入框中的原文' } })
    if (name === 'home') await r.page.addTodo()
    else await r.page.createEntry()
    assert.deepEqual(r.calls, [])
    assert.equal(r.page.data[name === 'home' ? 'draft' : 'content'], '还在输入框中的原文')
    assert.equal(r.page.data.syncTone, 'error')
    assert.match(r.page.data.syncMessage, /存储空间不足/)
  }
})

test('confirmed comment submission clears its persisted draft while retaining the next typed comment', async () => {
  for (const nextText of ['', '下一条评论']) {
    const r = pageRuntime('home', async () => ({}))
    r.page.setData({ todos: [{ id: 't', title: '待办', comments: [] }] })
    r.page.onCommentInput({ currentTarget: { dataset: { id: 't' } }, detail: { value: '已提交评论' } })
    let release
    r.api.mutateTodayTodo = () => new Promise((resolve) => { release = () => resolve({ queued: true }) })
    const request = r.page.addComment({ currentTarget: { dataset: { id: 't', version: 1 } } })
    if (nextText) r.page.onCommentInput({ currentTarget: { dataset: { id: 't' } }, detail: { value: nextText } })
    release()
    await request
    assert.equal(r.cache.read(r.cache.KEYS.homeDraftState).comments.t, nextText)
    assert.equal(r.page.data.commentDrafts.t, nextText)
  }
})

test('a queued comment deletion stays in the waiting-sync state instead of looking cloud-confirmed', async () => {
  const r = pageRuntime('home', async () => ({}))
  r.page.setData({ todos: [{ id: 't', title: '待办', version: 3, comments: [{ id: 'c', content: '待删除' }] }] })
  r.api.mutateTodayTodo = async () => ({ queued: true })
  await r.page.deleteComment({ currentTarget: { dataset: { id: 't', commentId: 'c', version: 3 } } })
  assert.equal(r.page.data.syncTone, 'syncing')
  assert.match(r.page.data.syncMessage, /等待|同步刷新/)
})

const feedback = require('../miniprogram/utils/sync-feedback')

test('a failed receive header is visible even when the upload was acknowledged', () => {
  const result = feedback.describe({ transport: { mode: 'home' }, flush: { sent: 1 },
    receiveError: { code: 'HOME_OFFLINE', message: '接收响应丢失' }, remoteFresh: false })
  assert.match(result.message, /已确认保存/)
  assert.match(result.message, /接收响应丢失/)
  assert.equal(result.tone, 'error')
  assert.doesNotMatch(result.message, /内容已接收/)
})

test('home receiving feedback reads its own checkpoint rather than a finished cloud checkpoint', () => {
  const cache = { KEYS: { historyTransfer: 'cloud', homeHistoryTransfer: 'home', queue: 'queue' },
    read: key => key === 'home' ? { protocol: 2, phase: 'history' } : key === 'cloud' ? { protocol: 2, phase: 'idle' } : [] }
  const result = feedback.fromCache(cache, { mode: 'home' })
  assert.match(result.message, /历史仍在接收/)
  assert.equal(result.tone, 'syncing')
})
