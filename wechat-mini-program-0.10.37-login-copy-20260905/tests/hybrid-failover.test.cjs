const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const MINI_ROOT = path.join(__dirname, '..', 'miniprogram')

function compile(file, dependencies = {}) {
  const source = fs.readFileSync(file, 'utf8')
  const module = { exports: {} }
  const localRequire = (request) => Object.prototype.hasOwnProperty.call(dependencies, request)
    ? dependencies[request]
    : require('node:module').createRequire(file)(request)
  new Function('require', 'module', 'exports', '__filename', '__dirname', source)(localRequire, module, module.exports, file, path.dirname(file))
  return module.exports
}

function createCache(initial = {}) {
  const scope = { userId: 'hybrid-user', workspaceId: 'hybrid-workspace' }
  const store = new Map(Object.entries({ ...initial,
    mirrorQueue: (initial.mirrorQueue || []).map((item) => ({ ...item, scope, homeTarget: 'synthetic-home' })) }))
  const KEYS = {
    queue: 'queue', mirrorQueue: 'mirrorQueue', bootstrap: 'bootstrap', todayTodos: 'todayTodos',
    journal: 'journal', journalArchive: 'journalArchive', trash: 'trash', proposals: 'proposals', tasks: 'tasks',
    homeConnection: 'homeConnection', hybridState: 'hybridState', deviceStatus: 'deviceStatus'
  }
  const api = {
    KEYS,
    currentScope() { return scope },
    currentHomeTarget() { return api.readConnection().token ? 'synthetic-home' : null },
    assertHomeTarget(item) { assert.equal(item.homeTarget, api.currentHomeTarget()) },
    read(key, fallback) { return store.has(key) ? store.get(key) : fallback },
    write(key, value) { store.set(key, value); return value },
    requestId(prefix = 'req') { return `${prefix}_stable` },
    enqueue(action, payload, options = {}) {
      const queue = api.read(KEYS.queue, [])
      const id = options.id || payload.requestId
      const known = queue.find((item) => item.id === id)
      if (known) return known
      const item = { id, action, payload, scope, homeTarget: api.currentHomeTarget(), attempts: 0, createdAt: '2026-08-14T00:00:00.000Z' }
      store.set(KEYS.queue, [...queue, item])
      return item
    },
    dequeue(id) {
      const next = api.read(KEYS.queue, []).filter((item) => item.id !== id)
      store.set(KEYS.queue, next)
      return next
    },
    readConnection() { return api.read(KEYS.homeConnection, { serverBaseUrl: '', token: '' }) },
    writeConnection(value) { return api.write(KEYS.homeConnection, value) },
    readHybridState() {
      return api.read(KEYS.hybridState, {
        mode: 'cloud', quotaBlocked: false, homeReachable: null,
        lastCloudError: '', lastCloudSuccessAt: '', lastHomeSuccessAt: '', cloudProbeAfter: 0
      })
    },
    writeHybridState(patch) {
      const next = { ...api.readHybridState(), ...patch }
      store.set(KEYS.hybridState, next)
      return next
    },
    enqueueMirror(action, payload, destinations = {}, options = {}) {
      const rows = api.read(KEYS.mirrorQueue, [])
      const requestId = options.id || payload.requestId
      const id = `${requestId}:${destinations.cloud ? 'c' : ''}${destinations.home ? 'h' : ''}`
      const known = rows.find((item) => item.id === id)
      if (known) return known
      const item = { id, requestId, action, payload, scope, homeTarget: api.currentHomeTarget(), pendingCloud: Boolean(destinations.cloud), pendingHome: Boolean(destinations.home), attempts: 0 }
      store.set(KEYS.mirrorQueue, [...rows, item])
      return item
    }
  }
  return api
}

function loadHybridClient({ cloudHandler, homeHandler, configured = true, initial = {}, cloudSyncEnabled = true }) {
  const cache = createCache({
    queue: [], mirrorQueue: [],
    homeConnection: configured ? { serverBaseUrl: 'https://home.example.com', token: 'x'.repeat(40) } : { serverBaseUrl: '', token: '' },
    ...initial
  })
  const policy = compile(path.join(MINI_ROOT, 'utils', 'sync-policy.js'))
  const hybrid = compile(path.join(MINI_ROOT, 'utils', 'hybrid-policy.js'))
  const home = {
    configured: () => configured,
    connection: () => cache.readConnection(),
    rpc: homeHandler || (() => Promise.reject(Object.assign(new Error('home offline'), { code: 'HOME_OFFLINE', retryable: true }))),
    testConnection: () => Promise.resolve({}),
    uploadImage: () => Promise.resolve({ id: 'home-image' })
  }
  global.wx = {
    cloud: {
      callFunction: cloudHandler,
      uploadFile: () => Promise.resolve({ fileID: 'cloud://image' })
    },
    saveFile: ({ tempFilePath, success }) => success({ savedFilePath: tempFilePath })
  }
  const app = {
    realtimeStarts: [],
    notifySyncListeners() {},
    stopRealtimeSync() {},
    rememberLocalSyncRevision() {},
    startRealtimeSync(channel, workspaceId) { this.realtimeStarts.push({ channel, workspaceId }) }
  }
  global.getApp = () => app
  const api = compile(path.join(MINI_ROOT, 'utils', 'api.js'), {
    '../config/env': { apiFunction: 'notebookApi', clientVersion: 'hybrid-test', cloudSyncEnabled },
    './cache': cache,
    './home-transport': home,
    './hybrid-policy': hybrid,
    './sync-policy': policy
  })
  return { api, cache, hybrid, app }
}

test('电脑本地模式完全跳过 CloudBase，并保留暂停的旧待回灌云端队列', async () => {
  let cloudCalls = 0
  const homeCalls = []
  const { api, cache } = loadHybridClient({
    cloudSyncEnabled: false,
    cloudHandler: () => { cloudCalls += 1; return success({}) },
    homeHandler: (action, payload) => {
      homeCalls.push({ action, payload })
      return Promise.resolve({ id: payload.id || 'saved', version: 1 })
    },
    initial: {
      mirrorQueue: [{
        id: 'old-cloud:c', requestId: 'old-cloud', action: 'journal.create',
        payload: { id: 'old-cloud' }, pendingCloud: true, pendingHome: false
      }]
    }
  })
  const result = await api.call('journal.create', { id: 'local-note', content: '只写电脑' })
  const mirror = await api.flushMirrorQueue()

  assert.equal(api.__test.CLOUD_SYNC_ENABLED, false)
  assert.equal(result.id, 'local-note')
  assert.equal(cloudCalls, 0)
  assert.deepEqual(homeCalls.map((item) => item.action), ['journal.create'])
  assert.equal(mirror.remaining, 1)
  assert.equal(cache.read(cache.KEYS.mirrorQueue, []).length, 1)
  assert.equal(cache.read(cache.KEYS.mirrorQueue, [])[0].status, 'blocked')
  assert.equal(api.getHybridStatus().mode, 'home')
})

function success(data) { return Promise.resolve({ result: { ok: true, data } }) }
function quota() { return Promise.resolve({ result: { ok: false, error: { code: 'InsufficientBalance', message: 'InsufficientBalance: quota exhausted' } } }) }

test('只把明确的额度错误识别为容灾切换，不把普通断网误判为额度不足', () => {
  const policy = compile(path.join(MINI_ROOT, 'utils', 'hybrid-policy.js'))
  assert.equal(policy.isQuotaError({ code: 'InsufficientBalance' }), true)
  assert.equal(policy.isQuotaError({ message: '本月额度不足' }), true)
  assert.equal(policy.isQuotaError({ errMsg: 'request:fail timeout' }), false)
})

test('云端额度耗尽后同一次操作自动交给家庭服务器，并保留待回灌日志', async () => {
  const homeCalls = []
  const { api, cache } = loadHybridClient({
    cloudHandler: quota,
    homeHandler: (action, payload) => {
      homeCalls.push({ action, payload })
      return Promise.resolve({ todos: [{ id: payload.todoId, status: 'done', version: 2 }] })
    }
  })
  const result = await api.call('todayTodo.complete', { todoId: 'todo-1', baseVersion: 1 }, { queueOnFailure: true })
  assert.equal(result.todos[0].status, 'done')
  assert.deepEqual(homeCalls.map((item) => item.action), ['todayTodo.complete'])
  assert.equal(cache.readHybridState().quotaBlocked, true)
  assert.equal(api.getHybridStatus().mode, 'home')
  assert.equal(cache.read(cache.KEYS.queue, []).length, 0)
  assert.equal(cache.read(cache.KEYS.mirrorQueue, []).filter((item) => item.pendingCloud).length, 1)
})

test('普通网络超时不会切换到家庭服务器，操作留在手机等待原线路恢复', async () => {
  let homeCalls = 0
  const { api, cache } = loadHybridClient({
    cloudHandler: () => Promise.reject(Object.assign(new Error('request timeout'), { code: 'NETWORK_ERROR' })),
    homeHandler: () => { homeCalls += 1; return Promise.resolve({}) }
  })
  const result = await api.call('journal.create', { id: 'capture_client_1_test', content: '离线记录' }, { queueOnFailure: true })
  assert.equal(result.queued, true)
  assert.equal(homeCalls, 0)
  assert.equal(cache.readHybridState().quotaBlocked, false)
  assert.equal(cache.read(cache.KEYS.queue, []).length, 1)
})

test('云端正常读取时用同一份快照预热家庭备用且相同快照不重复写入', async () => {
  const homeCalls = []
  const bundle = { todos: [{ id: 'warm-1', status: 'planned', version: 3 }], history: [] }
  const { api } = loadHybridClient({
    cloudHandler: ({ data }) => data.action === 'todayTodo.list' ? success(bundle) : success({}),
    homeHandler: (action, payload) => {
      homeCalls.push({ action, payload })
      return Promise.resolve({ merged: true })
    }
  })

  await api.call('todayTodo.list', { historyDays: 14 })
  await new Promise((resolve) => setTimeout(resolve, 160))
  await api.call('todayTodo.list', { historyDays: 14 })
  await new Promise((resolve) => setTimeout(resolve, 160))

  assert.equal(homeCalls.length, 1)
  assert.equal(homeCalls[0].action, 'hybrid.mergeCloudRead')
  assert.equal(homeCalls[0].payload.sourceAction, 'todayTodo.list')
  assert.deepEqual(homeCalls[0].payload.data, bundle)
})

test('额度不足且家庭电脑离线时操作仍保存在手机，模式显示为本地', async () => {
  const { api, cache } = loadHybridClient({ cloudHandler: quota })
  const result = await api.call('journal.create', { id: 'capture_client_2_test', content: '电脑关机时记录' }, { queueOnFailure: true })
  assert.equal(result.queued, true)
  assert.equal(api.getHybridStatus().mode, 'local')
  assert.equal(cache.read(cache.KEYS.queue, []).length, 1)
})

test('额度不足且未配置家庭服务器时，所有主要读取页直接返回手机缓存', async () => {
  const cachedToday = { todos: [{ id: 'local-todo', title: '手机缓存待办', status: 'planned' }], history: [] }
  const cachedJournal = { entries: [{ id: 'local-note', journalTitle: '手机缓存笔记' }], favorites: [], hidden: [], history: [] }
  const cachedTasks = [{ id: 'local-task', title: '手机缓存长期任务' }]
  const { api } = loadHybridClient({
    cloudHandler: quota,
    configured: false,
    initial: {
      todayTodos: cachedToday,
      journal: cachedJournal,
      tasks: cachedTasks,
      proposals: [{ id: 'local-proposal', status: 'pending' }]
    }
  })

  const sync = await api.syncNow()
  const journal = await api.call('journal.overview')
  const tasks = await api.call('task.list')
  const bootstrap = await api.bootstrap()

  assert.equal(sync.data.todos[0].id, 'local-todo')
  assert.equal(journal.entries[0].id, 'local-note')
  assert.equal(tasks.tasks[0].id, 'local-task')
  assert.equal(bootstrap.onboardingRequired, false)
  assert.equal(bootstrap.counts.proposals, 1)
  assert.equal(api.getHybridStatus().mode, 'local')
})

test('额度恢复后先回灌家庭服务器期间的操作，再返回云端模式', async () => {
  const calls = []
  const writes = []
  const mirror = [{
    id: 'complete-1:c', requestId: 'complete-1', action: 'todayTodo.complete',
    payload: { todoId: 'todo-2', baseVersion: 1, requestId: 'complete-1' },
    pendingCloud: true, pendingHome: false, attempts: 0
  }]
  const { api, cache, app } = loadHybridClient({
    cloudHandler: ({ data }) => {
      calls.push(data.action)
      if (data.action === 'bootstrap') return success({ onboardingRequired: false, syncChannel: 'channel-1', syncWorkspaceId: 'workspace-1',
        account: { user: { id: 'hybrid-user' }, workspaceId: 'hybrid-workspace' } })
      if (data.action === 'todayTodo.list') return success({ todos: [{ id: 'todo-2', status: 'planned', version: 7 }], history: [] })
      if (data.action === 'todayTodo.complete') {
        writes.push(data.payload)
        return success({ todos: [{ id: 'todo-2', status: 'done', version: 8 }] })
      }
      throw new Error(`unexpected ${data.action}`)
    },
    initial: {
      hybridState: { mode: 'home', quotaBlocked: true, homeReachable: true, cloudProbeAfter: Date.now() + 999999 },
      mirrorQueue: mirror
    }
  })
  const result = await api.maybeRecoverCloud({ force: true })
  assert.equal(result.recovered, true)
  assert.deepEqual(calls, ['bootstrap', 'todayTodo.list', 'todayTodo.complete'])
  assert.equal(writes[0].baseVersion, 7)
  assert.equal(cache.read(cache.KEYS.mirrorQueue, []).length, 0)
  assert.equal(api.getHybridStatus().mode, 'cloud')
  assert.deepEqual(app.realtimeStarts, [{ channel: 'channel-1', workspaceId: 'workspace-1' }])
})
