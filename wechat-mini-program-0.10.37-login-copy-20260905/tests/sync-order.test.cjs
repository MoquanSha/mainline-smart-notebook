const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const MINI_ROOT = path.join(__dirname, '..', 'miniprogram')

function shanghaiDateKey(offsetDays = 0) {
  const date = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000 + 8 * 60 * 60 * 1000)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

function compileCommonJs(file, dependencyMap = {}) {
  const source = require('node:fs').readFileSync(file, 'utf8')
  const module = { exports: {} }
  const localRequire = (request) => {
    if (Object.prototype.hasOwnProperty.call(dependencyMap, request)) return dependencyMap[request]
    return require('node:module').createRequire(file)(request)
  }
  const factory = new Function('require', 'module', 'exports', '__filename', '__dirname', source)
  factory(localRequire, module, module.exports, file, path.dirname(file))
  return module.exports
}

function loadClient(initialQueue, handler, configOverrides = {}) {
  let queue = initialQueue
  let requestSequence = 0
  const storage = new Map()
  global.wx = {
    cloud: { callFunction: handler }
  }
  global.getApp = () => ({ startRealtimeSync() {} })
  const cache = {
    KEYS: {
      queue: 'queue', bootstrap: 'bootstrap', todayTodos: 'todayTodos',
      journal: 'journal', journalArchive: 'journalArchive', trash: 'trash',
      proposals: 'proposals', tasks: 'tasks', diaryDays: 'diaryDays', mirrorQueue: 'mirrorQueue',
      homeConnection: 'homeConnection', hybridState: 'hybridState',
      syncRevision: 'syncRevision', syncSnapshotDate: 'syncSnapshotDate', syncSnapshotReady: 'syncSnapshotReady',
      syncSnapshotScopeVersion: 'syncSnapshotScopeVersion', syncSnapshotScopeProbeVersion: 'syncSnapshotScopeProbeVersion',
      syncReceiptRepairVersion: 'syncReceiptRepairVersion',
      confirmedSnapshot: 'confirmedSnapshot'
    },
    read(key, fallback) { return key === 'queue' ? queue : (storage.has(key) ? storage.get(key) : fallback) },
    write(key, value) { if (key === 'queue') queue = value; else storage.set(key, value); return value },
    requestId(prefix = 'req') { requestSequence += 1; return `${prefix}_test_${requestSequence}` },
    enqueue(action, payload, options = {}) {
      const id = options.id || payload.requestId || `${action}_queued`
      const existing = queue.find((item) => item.id === id)
      if (existing) return existing
      const item = { id, action, payload, attempts: 0, createdAt: '2026-08-11T01:00:00.000Z' }
      queue = [...queue, item]
      return item
    },
    dequeue(id) {
      queue = queue.filter((item) => item.id !== id)
      return queue
    },
    readConnection() { return storage.get('homeConnection') || { serverBaseUrl: '', token: '' } },
    writeConnection(value) { storage.set('homeConnection', value); return value },
    readHybridState() {
      return storage.get('hybridState') || {
        mode: 'cloud', quotaBlocked: false, homeReachable: null,
        lastCloudError: '', lastCloudSuccessAt: '', lastHomeSuccessAt: '', cloudProbeAfter: 0
      }
    },
    writeHybridState(patch) {
      const next = { ...this.readHybridState(), ...patch }
      storage.set('hybridState', next)
      return next
    },
    enqueueMirror(action, payload, destinations, options = {}) {
      const rows = storage.get('mirrorQueue') || []
      const item = { id: options.id || payload.requestId, requestId: options.id || payload.requestId, action, payload, pendingCloud: Boolean(destinations.cloud), pendingHome: Boolean(destinations.home) }
      if (!rows.some((row) => row.id === item.id)) rows.push(item)
      storage.set('mirrorQueue', rows)
      return item
    }
  }
  const policy = compileCommonJs(path.join(MINI_ROOT, 'utils/sync-policy.js'))
  const hybrid = compileCommonJs(path.join(MINI_ROOT, 'utils/hybrid-policy.js'))
  const home = {
    configured() { return false },
    connection() { return { serverBaseUrl: '', token: '' } },
    rpc() { return Promise.reject(new Error('home unavailable')) },
    testConnection() { return Promise.reject(new Error('home unavailable')) },
    uploadImage() { return Promise.reject(new Error('home unavailable')) }
  }
  const api = compileCommonJs(path.join(MINI_ROOT, 'utils/api.js'), {
    '../config/env': { apiFunction: 'notebookApi', clientVersion: 'test', cloudSyncEnabled: true, ...configOverrides },
    './cache': cache,
    './home-transport': home,
    './hybrid-policy': hybrid,
    './sync-policy': policy
  })
  return {
    api,
    queue: () => queue,
    storage
  }
}

test('省额度模式下修改先进入本地队列，手动同步可立即补传', async () => {
  const calls = []
  const client = loadClient([], ({ data }) => {
    calls.push(data.action)
    if (data.action === 'sync.push') {
      assert.equal(data.payload.operations.length, 1)
      assert.equal(data.payload.operations[0].action, 'todayTodo.setPin')
      assert.equal(data.payload.operations[0].payload.baseVersion, 3)
      return success({ results: [{ requestId: data.payload.operations[0].requestId, ok: true, data: { todos: [{ id: 'todo_manual', status: 'planned', pinned: true, version: 4 }], history: [] } }], changed: true })
    }
    if (data.action === 'todayTodo.list') {
      return success({ todos: [{ id: 'todo_manual', status: 'planned', pinned: true, version: 4 }], history: [] })
    }
    throw new Error(`unexpected ${data.action}`)
  }, { syncMode: 'cloud-manual', manualSyncOnly: true })

  const queued = await client.api.mutateTodayTodo('todayTodo.setPin', {
    todoId: 'todo_manual', pinned: true, baseVersion: 3
  })

  assert.equal(queued.queued, true)
  assert.deepEqual(calls, [])
  assert.equal(client.queue().length, 1)

  await client.api.syncNow({ includeBootstrap: false })
  assert.deepEqual(calls, ['sync.push', 'todayTodo.list'])
  assert.equal(client.queue().length, 0)
})

test('日常增量上传不等待快照，手机新增待办直接批量上云', async () => {
  const calls = []
  const client = loadClient([], ({ data }) => {
    calls.push(data.action)
    assert.equal(data.action, 'sync.push')
    const operation = data.payload.operations[0]
    return success({
      changed: true,
      results: [{
        requestId: operation.requestId,
        ok: true,
        data: { todos: [{ id: operation.payload.clientItems[0].id, title: '超时后仍上传', status: 'planned', version: 1 }], history: [] }
      }]
    })
  }, { syncMode: 'cloud-manual', manualSyncOnly: true, cloudRpcTimeoutMs: 5 })

  const queued = await client.api.mutateTodayTodo('todayTodo.add', { content: '超时后仍上传' })
  assert.equal(queued.queued, true)

  const result = await client.api.flushDirtyQueueNow({ reason: 'timeout-upload-test' })
  assert.equal(result.flush.sent, 1)
  assert.equal(result.flush.remaining, 0)
  assert.deepEqual(calls, ['sync.push'])
  assert.equal(client.queue().length, 0)
})

test('今日待办、灵光一现与长期计划连续三次写入只触发一次批量增量上传', async () => {
  const calls = []
  const pushedBatches = []
  const client = loadClient([], ({ data }) => {
    calls.push(data)
    if (data.action === 'sync.snapshot') {
      return success({
        notModified: false, revision: 'before-batch',
        bootstrap: { onboardingRequired: false },
        data: { todos: [], history: [] }, tasks: [{ id: 'task-batch', version: 3 }],
        journal: { entries: [], favorites: [], hidden: [], history: [] }, journalArchive: []
      })
    }
    assert.equal(data.action, 'sync.push')
    pushedBatches.push(data.payload.operations.map((operation) => operation.action))
    return success({
      changed: true,
      results: data.payload.operations.map((operation) => ({
        requestId: operation.requestId,
        action: operation.action,
        ok: true,
        data: operation.action === 'todayTodo.add'
          ? { todos: [{ id: 'today-batch', status: 'planned', title: '批量待办', version: 1 }], history: [] }
          : operation.action === 'journal.create'
            ? { id: 'journal-batch', journalTitle: '批量灵光', version: 1 }
            : { id: 'task-batch', title: '批量长期计划', version: 2 }
      }))
    })
  }, { syncMode: 'cloud-manual', manualSyncOnly: true })

  await client.api.call('todayTodo.add', { content: '批量待办' })
  await client.api.call('journal.create', { id: 'journal-batch', content: '批量灵光' })
  await client.api.call('task.update', { id: 'task-batch', patch: { progress: 20 }, baseVersion: 1 })

  assert.equal(calls.length, 0)
  await new Promise((resolve) => setTimeout(resolve, 950))

  assert.equal(calls.filter((call) => call.action === 'sync.snapshot').length, 0)
  const push = calls.find((call) => call.action === 'sync.push')
  assert.ok(push)
  assert.deepEqual(pushedBatches, [[
    'todayTodo.add', 'journal.create', 'task.update'
  ]])
  assert.equal(client.queue().length, 0)
})

test('手机置顶请求继承用户关闭自动优先置顶的设置', () => {
  const client = loadClient([], () => { throw new Error('不应调用云端') }, {
    syncMode: 'cloud-manual', manualSyncOnly: true
  })
  client.storage.set('bootstrap', { settings: { autoPinHighPriorityTodos: false } })

  const payload = client.api.__test.normalizeClientPayload('todayTodo.setPin', {
    todoId: 'high-priority', pinned: true
  })

  assert.equal(payload.autoPinHighPriorityTodos, false)
})

test('同一状态的重复本地修改只保留最后一条增量，不上传未变化的整份记录', () => {
  const storage = new Map()
  global.wx = {
    getStorageSync(key) { return storage.has(key) ? storage.get(key) : '' },
    setStorageSync(key, value) { storage.set(key, value) }
  }
  const durableCache = compileCommonJs(path.join(MINI_ROOT, 'utils/cache.js'))

  durableCache.adoptScope({ account: { user: { id: 'test-user' }, workspaceId: 'test-space' } })

  durableCache.enqueue('todayTodo.setPin', { todoId: 'todo-1', pinned: true }, {
    id: 'pin-1', coalesceKey: 'todayTodo.setPin:todo-1'
  })
  durableCache.enqueue('todayTodo.setPin', { todoId: 'todo-1', pinned: false }, {
    id: 'pin-2', coalesceKey: 'todayTodo.setPin:todo-1'
  })

  const queued = durableCache.read(durableCache.KEYS.queue, [])
  assert.equal(queued.length, 1)
  assert.equal(queued[0].id, 'pin-2')
  assert.equal(queued[0].payload.pinned, false)
})

test('连续调整同一长期计划进度只保留最后一次增量', () => {
  const storage = new Map()
  const client = loadClient([], () => { throw new Error('不应调用云端') }, {
    syncMode: 'cloud-manual', manualSyncOnly: true
  })
  global.wx = {
    getStorageSync(key) { return storage.has(key) ? storage.get(key) : '' },
    setStorageSync(key, value) { storage.set(key, value) }
  }
  const durableCache = compileCommonJs(path.join(MINI_ROOT, 'utils/cache.js'))

  durableCache.adoptScope({ account: { user: { id: 'test-user' }, workspaceId: 'test-space' } })

  for (const progress of [20, 45, 70]) {
    const payload = { id: 'task-progress', patch: { progress } }
    durableCache.enqueue('task.update', payload, {
      id: `progress-${progress}`,
      coalesceKey: client.api.__test.queueCoalesceKey('task.update', payload)
    })
  }

  const queued = durableCache.read(durableCache.KEYS.queue, [])
  assert.equal(queued.length, 1)
  assert.equal(queued[0].payload.patch.progress, 70)
})

test('三大功能的常规写操作合并成一次批量上传', async () => {
  const calls = []
  const expectedActions = [
    'todayTodo.add', 'todayTodo.complete', 'todayTodo.defer', 'todayTodo.delete',
    'todayTodo.setPin', 'todayTodo.reorder', 'todayTodo.commentAdd', 'todayTodo.commentDelete',
    'journal.create', 'journal.toggleItem', 'journal.append',
    'capture.setFavorite', 'capture.hide', 'capture.restoreHidden',
    'task.update', 'task.completeStep', 'task.archive'
  ]
  const todos = [
    'complete', 'defer', 'delete', 'pin', 'order-a', 'order-b', 'comment-add', 'comment-delete'
  ].map((id, index) => ({
    id: `todo-${id}`, status: 'planned', pinned: false, version: 3,
    sortRank: 100 - index, comments: id === 'comment-delete' ? [{ id: 'comment-existing' }] : []
  }))
  const journalRows = [
    { id: 'journal-toggle', version: 5, checklistItems: [{ id: 'check-1', done: false }] },
    { id: 'journal-append', version: 5 },
    { id: 'journal-favorite', version: 5 },
    { id: 'journal-hide', version: 5 },
    { id: 'journal-restore', version: 5, hiddenAt: '2026-08-20T00:00:00.000Z' }
  ]
  const tasks = [
    { id: 'task-update', version: 4, progress: 10 },
    { id: 'task-step', version: 4, steps: [{ id: 'step-1', status: 'current' }] },
    { id: 'task-archive', version: 4, status: 'active' }
  ]
  const client = loadClient([], ({ data }) => {
    calls.push(data)
    if (data.action === 'sync.snapshot') {
      return success({
        notModified: false,
        revision: 'mobile-upload-matrix',
        bootstrap: { onboardingRequired: false },
        data: { todos, history: [] },
        tasks,
        journal: { entries: journalRows, favorites: [], hidden: [], history: [] },
        journalArchive: []
      })
    }
    assert.equal(data.action, 'sync.push')
    return success({
      changed: true,
      results: data.payload.operations.map((operation) => ({
        requestId: operation.requestId,
        action: operation.action,
        ok: true,
        data: operation.action.startsWith('todayTodo.')
          ? { todos, history: [] }
          : operation.action.startsWith('task.')
            ? { id: operation.payload.id || operation.payload.taskId, version: 5 }
            : { id: operation.payload.id || operation.payload.entryId, version: 6 }
      }))
    })
  }, { syncMode: 'cloud-manual', manualSyncOnly: true })

  const operations = [
    ['todayTodo.add', { content: '新增待办' }],
    ['todayTodo.complete', { todoId: 'todo-complete', baseVersion: 3 }],
    ['todayTodo.defer', { todoId: 'todo-defer', baseVersion: 3 }],
    ['todayTodo.delete', { todoId: 'todo-delete', baseVersion: 3 }],
    ['todayTodo.setPin', { todoId: 'todo-pin', pinned: true, baseVersion: 3 }],
    ['todayTodo.reorder', { orderedIds: ['todo-order-b', 'todo-order-a'], versions: { 'todo-order-a': 3, 'todo-order-b': 3 } }],
    ['todayTodo.commentAdd', { todoId: 'todo-comment-add', commentId: 'comment-new', content: '补充', attachments: [], baseVersion: 3 }],
    ['todayTodo.commentDelete', { todoId: 'todo-comment-delete', commentId: 'comment-existing', baseVersion: 3 }],
    ['journal.create', { id: 'journal-create', content: '新增灵光' }],
    ['journal.toggleItem', { entryId: 'journal-toggle', itemId: 'check-1', done: true, baseVersion: 5 }],
    ['journal.append', { entryId: 'journal-append', content: '补充内容', baseVersion: 5 }],
    ['capture.setFavorite', { id: 'journal-favorite', favorited: true, baseVersion: 5 }],
    ['capture.hide', { id: 'journal-hide', baseVersion: 5 }],
    ['capture.restoreHidden', { id: 'journal-restore', baseVersion: 5 }],
    ['task.update', { id: 'task-update', patch: { progress: 35 }, baseVersion: 4 }],
    ['task.completeStep', { taskId: 'task-step', stepId: 'step-1', baseVersion: 4 }],
    ['task.archive', { id: 'task-archive', baseVersion: 4 }]
  ]

  for (const [action, payload] of operations) await client.api.call(action, payload, { queueOnFailure: true })
  assert.equal(calls.length, 0)

  await client.api.flushDirtyQueueNow({ reason: 'test-matrix' })

  const pushes = calls.filter((call) => call.action === 'sync.push')
  assert.equal(pushes.length, 1)
  assert.deepEqual(pushes[0].payload.operations.map((operation) => operation.action), expectedActions)
  assert.equal(client.queue().length, 0)
})

test('需要云端计算的待确认与AI复核操作断网时不伪装成已排队', async () => {
  const remoteActions = [
    ['proposal.apply', { id: 'proposal-1', baseVersion: 1 }],
    ['proposal.applyAll', {}],
    ['proposal.reject', { id: 'proposal-2', baseVersion: 1 }],
    ['proposal.delete', { id: 'proposal-3', baseVersion: 1 }],
    ['proposal.update', { id: 'proposal-4', patch: { title: '更新' }, baseVersion: 1 }],
    ['proposal.defer', { id: 'proposal-5', baseVersion: 1 }],
    ['proposal.restore', { id: 'proposal-6', baseVersion: 1 }],
    ['task.reanalyze', { id: 'task-1' }]
  ]
  const client = loadClient([], () => Promise.reject(new Error('offline')), {
    syncMode: 'cloud-manual', manualSyncOnly: true
  })

  for (const [action, payload] of remoteActions) {
    assert.equal(client.api.__test.remoteRequiredMutation(action), true)
    await assert.rejects(client.api.call(action, payload, { queueOnFailure: true }), /offline/)
  }
  assert.equal(client.queue().length, 0)
})

test('待办图片在批量上传前转换成云文件标识', async () => {
  const client = loadClient([], () => { throw new Error('不应调用云函数') }, {
    syncMode: 'cloud-manual', manualSyncOnly: true
  })
  client.storage.set('bootstrap', { storagePrefix: 'users/test/todo-comments' })
  const uploads = []
  global.wx.cloud.uploadFile = async (options) => {
    uploads.push(options)
    return { fileID: `cloud://${options.cloudPath}` }
  }

  const payload = await client.api.__test.preparePayloadForCloud('todayTodo.commentAdd', {
    todoId: 'todo-image',
    attachments: [{
      id: 'image-1', fileName: 'image.jpg', mimeType: 'image/jpeg', size: 1024,
      localFilePath: 'wxfile://saved-image.jpg'
    }]
  })

  assert.equal(uploads.length, 1)
  assert.equal(uploads[0].filePath, 'wxfile://saved-image.jpg')
  assert.match(payload.attachments[0].cloudPath, /users\/test\/todo-comments\/todo-image\/image-1\.jpg$/)
  assert.match(payload.attachments[0].fileID, /^cloud:\/\//)
})

function success(data) {
  return Promise.resolve({ result: { ok: true, data } })
}

function conflict(latest) {
  return Promise.resolve({
    result: { ok: false, error: { code: 'CONFLICT', message: '记录已更新', latest } }
  })
}

test('手动同步严格先上传，再接收云端最新待办', async () => {
  const calls = []
  const initial = [{
    id: 'offline_1',
    action: 'todayTodo.setPin',
    payload: { todoId: 'todo_1', pinned: true, baseVersion: 1, requestId: 'pin_1' },
    createdAt: '2026-08-11T01:00:00.000Z',
    attempts: 0
  }]
  const { api, queue } = loadClient(initial, ({ data }) => {
    calls.push({ action: data.action, payload: data.payload })
    if (data.action === 'sync.push') {
      const operation = data.payload.operations[0]
      assert.equal(operation.action, 'todayTodo.setPin')
      assert.equal(operation.payload.baseVersion, 1)
      return success({ results: [{ requestId: operation.requestId, ok: true, data: { todos: [{ id: 'todo_1', status: 'planned', pinned: true, version: 6 }], history: [] } }], changed: true })
    }
    if (data.action === 'todayTodo.list') {
      return success({ todos: [{ id: 'todo_1', status: 'planned', pinned: true, version: 6 }], history: [] })
    }
    throw new Error(`unexpected ${data.action}`)
  })

  const result = await api.syncNow({ includeBootstrap: false })

  assert.deepEqual(calls.map((entry) => entry.action), [
    'sync.push',
    'todayTodo.list'
  ])
  assert.equal(result.data.todos[0].pinned, true)
  assert.equal(queue().length, 0)
})

test('云端已经完成的待办不会被手机旧队列重复提交', async () => {
  const calls = []
  const initial = [{
    id: 'offline_2',
    action: 'todayTodo.complete',
    payload: { todoId: 'todo_2', baseVersion: 2, requestId: 'complete_1' },
    createdAt: '2026-08-11T01:00:00.000Z',
    attempts: 0
  }]
  const client = loadClient(initial, ({ data }) => {
    calls.push(data.action)
    return success({ todos: [{ id: 'todo_2', status: 'done', pinned: false, version: 9 }], history: [] })
  })
  client.storage.set('confirmedSnapshot', {
    revision: 'confirmed-done', confirmedAt: '2026-08-11T02:00:00.000Z',
    todayTodos: [{ id: 'todo_2', status: 'done', pinned: false, version: 9 }],
    todayHistory: [], tasks: [], journal: { entries: [], favorites: [], hidden: [], history: [] }, journalArchive: []
  })

  await client.api.syncNow({ includeBootstrap: false })

  assert.deepEqual(calls, ['todayTodo.list'])
  assert.equal(client.queue().length, 0)
})

test('在线点击完成依靠版本冲突保护，收到最新实体后再重试', async () => {
  const calls = []
  const { api } = loadClient([], ({ data }) => {
    calls.push({ action: data.action, payload: data.payload })
    assert.equal(data.action, 'todayTodo.complete')
    if (calls.length === 1) {
      assert.equal(data.payload.baseVersion, 2)
      return conflict({ id: 'todo_online', status: 'planned', pinned: true, version: 8 })
    }
    assert.equal(data.payload.baseVersion, 8)
    return success({ todos: [{ id: 'todo_online', status: 'done', pinned: false, version: 9 }], history: [] })
  })

  const result = await api.mutateTodayTodo('todayTodo.complete', {
    todoId: 'todo_online',
    baseVersion: 2
  }, { queueOnFailure: true })

  assert.deepEqual(calls.map((entry) => entry.action), ['todayTodo.complete', 'todayTodo.complete'])
  assert.equal(result.todos[0].status, 'done')
})

test('冲突实体已被另一端完成时只在冲突后刷新完整列表', async () => {
  const calls = []
  const { api } = loadClient([], ({ data }) => {
    calls.push(data.action)
    if (data.action === 'todayTodo.complete') {
      return conflict({ id: 'todo_done', status: 'done', pinned: false, version: 4 })
    }
    return success({
      todos: [
        { id: 'todo_done', status: 'done', pinned: false, version: 4 },
        { id: 'todo_other', status: 'planned', pinned: false, version: 2 }
      ],
      history: []
    })
  })

  const result = await api.mutateTodayTodo('todayTodo.complete', {
    todoId: 'todo_done',
    baseVersion: 2
  }, { queueOnFailure: true })

  assert.deepEqual(calls, ['todayTodo.complete', 'todayTodo.list'])
  assert.equal(result.todos.length, 2)
  assert.equal(result.satisfied, true)
})

test('手机操作在发起网络请求前先进入持久队列，云端成功后再移除', async () => {
  let queueReader = () => []
  const client = loadClient([], ({ data }) => {
    assert.equal(data.action, 'journal.create')
    assert.equal(queueReader().length, 1)
    return success({ id: 'journal_1', version: 1 })
  })
  queueReader = client.queue

  const result = await client.api.call('journal.create', { id: 'journal_1', content: '测试' }, { queueOnFailure: true })

  assert.equal(result.id, 'journal_1')
  assert.equal(client.queue().length, 0)
})

test('网络中断时手机持久队列保留操作，重开小程序后仍可补传', async () => {
  const { api, queue } = loadClient([], () => Promise.reject(new Error('offline')))

  const result = await api.call('journal.create', { id: 'journal_offline', content: '离线记录' }, { queueOnFailure: true })

  assert.equal(result.queued, true)
  assert.equal(queue().length, 1)
  assert.equal(queue()[0].action, 'journal.create')
})

test('灵光一现离线修改先上传，版本冲突时用云端实体有界重试一次', async () => {
  const actions = []
  const initial = [{
    id: 'journal_toggle_1',
    action: 'journal.toggleItem',
    payload: { entryId: 'entry_1', itemId: 'check_1', done: true, baseVersion: 1, requestId: 'journal_toggle_1' },
    createdAt: '2026-08-11T01:00:00.000Z', attempts: 0
  }]
  const { api, queue } = loadClient(initial, ({ data }) => {
    actions.push(data.action)
    if (data.action === 'sync.push') {
      const operation = data.payload.operations[0]
      assert.equal(operation.action, 'journal.toggleItem')
      if (actions.filter((action) => action === 'sync.push').length === 1) {
        assert.equal(operation.payload.baseVersion, 1)
        return success({
          results: [{ requestId: operation.requestId, ok: false, error: { code: 'CONFLICT', message: '记录已更新', latest: { id: 'entry_1', version: 7 } } }],
          changed: false
        })
      }
      assert.equal(operation.payload.baseVersion, 7)
      return success({ results: [{ requestId: operation.requestId, ok: true, data: { id: 'entry_1', version: 8 } }], changed: true })
    }
    if (data.action === 'sync.snapshot') return success({
      notModified: false,
      revision: 'journal-after-push',
      bootstrap: { onboardingRequired: false },
      data: { todos: [], history: [] },
      tasks: [],
      journal: { entries: [{ id: 'entry_1', version: 8 }], favorites: [], hidden: [], history: [] },
      journalArchive: []
    })
    throw new Error(`unexpected ${data.action}`)
  })

  await api.syncNow({ includeBootstrap: true })

  assert.deepEqual(actions, ['sync.push', 'sync.push', 'sync.snapshot'])
  assert.equal(queue().length, 0)
})

test('云端修订号未变化时只读取一个同步信号并复用三类本地缓存', async () => {
  const calls = []
  const today = shanghaiDateKey()
  const client = loadClient([], ({ data }) => {
    calls.push(data)
    assert.equal(data.action, 'sync.snapshot')
    assert.deepEqual(data.payload, { includeHistory: false, knownRevision: 'revision-1', knownDate: today, cacheReady: true, historyProtocol: 2 })
    return success({ notModified: true, revision: 'revision-1', date: today })
  }, { syncMode: 'cloud-manual', manualSyncOnly: true })
  client.storage.set('syncRevision', 'revision-1')
  client.storage.set('syncSnapshotDate', today)
  client.storage.set('syncSnapshotReady', true)
  client.storage.set('syncSnapshotScopeVersion', 3)
  client.storage.set('syncSnapshotScopeProbeVersion', 3)
  client.storage.set('syncReceiptRepairVersion', 1)
  client.storage.set('bootstrap', { onboardingRequired: false, counts: { todayTodos: 1, tasks: 1 } })
  client.storage.set('todayTodos', { todos: [{ id: 'today-1', title: '今日待办' }], history: [] })
  client.storage.set('tasks', [{ id: 'task-1', title: '长期计划' }])
  client.storage.set('journal', { entries: [{ id: 'journal-1', journalTitle: '灵光一现' }], favorites: [], hidden: [], history: [] })
  client.storage.set('confirmedSnapshot', {
    revision: 'revision-1', date: today, confirmedAt: '2026-08-20T01:00:00.000Z', bootstrap: { onboardingRequired: false },
    todayTodos: [{ id: 'today-1', title: '今日待办' }], todayHistory: [],
    tasks: [{ id: 'task-1', title: '长期计划' }],
    journal: { entries: [{ id: 'journal-1', journalTitle: '灵光一现' }], favorites: [], hidden: [], history: [] },
    journalArchive: []
  })

  const result = await client.api.syncNow({ includeBootstrap: true })

  assert.equal(calls.length, 1)
  assert.equal(result.data.todos[0].title, '今日待办')
  assert.equal(result.views.tasks.tasks[0].title, '长期计划')
  assert.equal(result.views.journal.entries[0].journalTitle, '灵光一现')
  assert.equal(result.remoteFresh, true)
  assert.equal(result.remoteData.todos[0].title, '今日待办')
})

test('旧版上传回执造成的同修订号旧缓存会一次性强制刷新', async () => {
  const calls = []
  const today = shanghaiDateKey()
  const client = loadClient([], ({ data }) => {
    calls.push(data)
    assert.equal(data.action, 'sync.snapshot')
    if (calls.length === 1) {
      assert.equal(data.payload.knownRevision, 'revision-after-old-push')
      assert.equal(data.payload.cacheReady, false)
      return success({
        notModified: false,
        revision: 'revision-after-old-push',
        date: today,
        bootstrap: { onboardingRequired: false },
        data: { todos: [], history: [] },
        tasks: [],
        diaryDays: [{ date: today, summary: '修复后收到的最新小记' }],
        journal: { entries: [], favorites: [], hidden: [], history: [] },
        journalArchive: []
      })
    }
    assert.equal(data.payload.cacheReady, true)
    return success({ notModified: true, revision: 'revision-after-old-push', date: today })
  }, { syncMode: 'cloud-manual', manualSyncOnly: true })
  client.storage.set('syncRevision', 'revision-after-old-push')
  client.storage.set('syncSnapshotDate', today)
  client.storage.set('syncSnapshotReady', true)
  client.storage.set('syncSnapshotScopeVersion', 1)
  client.storage.set('syncSnapshotScopeProbeVersion', 1)
  client.storage.set('confirmedSnapshot', {
    revision: 'revision-after-old-push', date: today, confirmedAt: '2026-08-30T00:10:00+08:00',
    bootstrap: { onboardingRequired: false }, todayTodos: [], todayHistory: [], tasks: [],
    diaryDays: [{ date: today, summary: '旧小记' }],
    journal: { entries: [], favorites: [], hidden: [], history: [] }, journalArchive: []
  })

  const repaired = await client.api.syncNow({ includeBootstrap: true })
  assert.equal(repaired.views.diaryDays[0].summary, '修复后收到的最新小记')
  assert.equal(client.storage.get('syncReceiptRepairVersion'), 1)

  const unchanged = await client.api.syncNow({ includeBootstrap: true })
  assert.equal(unchanged.views.diaryDays[0].summary, '修复后收到的最新小记')
  assert.equal(calls.length, 2)
})

test('旧手机缺少完整历史范围标记时只补取一次完整快照', async () => {
  const calls = []
  const today = shanghaiDateKey()
  const client = loadClient([], ({ data }) => {
    calls.push(data)
    assert.equal(data.action, 'sync.snapshot')
    if (calls.length === 1) {
      assert.equal(data.payload.knownRevision, 'same-revision')
      assert.equal(data.payload.cacheReady, false)
      return success({
        notModified: false,
        revision: 'same-revision',
        date: today,
        includedScopes: ['today_todos', 'journal_entries', 'long_term_tasks', 'daily_diary'],
        bootstrap: { onboardingRequired: false },
        data: { todos: [], history: [] },
        tasks: [],
        diaryDays: [{ date: today, summary: '从电脑端补取的今日小记' }],
        journal: { entries: [], favorites: [], hidden: [], history: [] },
        journalArchive: []
      })
    }
    assert.equal(data.payload.cacheReady, true)
    return success({ notModified: true, revision: 'same-revision', date: today })
  }, { syncMode: 'cloud-manual', manualSyncOnly: true })
  client.storage.set('syncRevision', 'same-revision')
  client.storage.set('syncSnapshotDate', today)
  client.storage.set('syncSnapshotReady', true)
  client.storage.set('syncReceiptRepairVersion', 1)
  client.storage.set('confirmedSnapshot', {
    revision: 'same-revision', date: today, confirmedAt: '2026-08-31T01:00:00.000Z',
    bootstrap: { onboardingRequired: false }, todayTodos: [], todayHistory: [], tasks: [],
    diaryDays: [], journal: { entries: [], favorites: [], hidden: [], history: [] }, journalArchive: []
  })

  const repaired = await client.api.syncNow({ includeBootstrap: true })
  assert.equal(repaired.views.diaryDays[0].summary, '从电脑端补取的今日小记')
  assert.equal(client.storage.get('syncSnapshotScopeVersion'), 3)
  assert.equal(client.storage.get('syncSnapshotScopeProbeVersion'), 3)

  const unchanged = await client.api.syncNow({ includeBootstrap: true })
  assert.equal(unchanged.views.diaryDays[0].summary, '从电脑端补取的今日小记')
  assert.equal(calls.length, 2)
})

test('上海日期变化时即使修订号相同也只强制一次完整快照', async () => {
  const today = shanghaiDateKey()
  const yesterday = shanghaiDateKey(-1)
  const calls = []
  const client = loadClient([], ({ data }) => {
    calls.push(data)
    assert.equal(data.action, 'sync.snapshot')
    assert.equal(data.payload.knownRevision, 'same-revision')
    assert.equal(data.payload.knownDate, yesterday)
    assert.equal(data.payload.cacheReady, false)
    return success({
      notModified: false,
      revision: 'same-revision',
      date: today,
      bootstrap: { onboardingRequired: false },
      data: { todos: [{ id: 'carried-todo', title: '跨天保留', status: 'planned' }], history: [] },
      tasks: [],
      journal: { entries: [], favorites: [], hidden: [], history: [] },
      journalArchive: []
    })
  }, { syncMode: 'cloud-manual', manualSyncOnly: true })
  client.storage.set('syncRevision', 'same-revision')
  client.storage.set('syncSnapshotDate', yesterday)
  client.storage.set('syncSnapshotReady', true)
  client.storage.set('confirmedSnapshot', {
    revision: 'same-revision', date: yesterday, confirmedAt: '2026-08-24T01:00:00.000Z',
    bootstrap: { onboardingRequired: false }, todayTodos: [], todayHistory: [], tasks: [],
    journal: { entries: [], favorites: [], hidden: [], history: [] }, journalArchive: []
  })

  const result = await client.api.syncNow({ includeBootstrap: true })

  assert.equal(calls.length, 1)
  assert.equal(result.data.todos[0].id, 'carried-todo')
  assert.equal(client.storage.get('syncSnapshotDate'), today)
  assert.equal(client.storage.get('confirmedSnapshot').date, today)
})

test('旧版本只有修订号而没有确认快照时只强制一次完整迁移快照', async () => {
  const calls = []
  const client = loadClient([], ({ data }) => {
    calls.push(data)
    assert.equal(data.action, 'sync.snapshot')
    assert.equal(data.payload.knownRevision, 'legacy-revision')
    assert.equal(data.payload.cacheReady, false)
    return success({
      notModified: false,
      revision: 'migration-revision',
      bootstrap: { onboardingRequired: false },
      data: { todos: [{ id: 'cloud-todo', title: '云端确认待办', status: 'planned', version: 2 }], history: [] },
      tasks: [{ id: 'cloud-task', title: '云端确认计划', version: 3 }],
      journal: { entries: [{ id: 'cloud-journal', journalTitle: '云端确认灵光', version: 4 }], favorites: [], hidden: [], history: [] },
      journalArchive: []
    })
  }, { syncMode: 'cloud-manual', manualSyncOnly: true })
  client.storage.set('syncRevision', 'legacy-revision')
  client.storage.set('syncSnapshotReady', true)

  await client.api.syncNow({ includeBootstrap: true })

  assert.equal(calls.length, 1)
  assert.equal(client.storage.get('confirmedSnapshot').revision, 'migration-revision')
  assert.equal(client.storage.get('confirmedSnapshot').todayTodos[0].id, 'cloud-todo')
})

test('本地上传后仍用上传前修订号接收其他设备的最新变化', async () => {
  const calls = []
  const client = loadClient([], ({ data }) => {
    calls.push(data.action)
    if (data.action === 'sync.push') {
      const operation = data.payload.operations[0]
      assert.equal(operation.action, 'todayTodo.add')
      return success({
        changed: true,
        syncReceipt: { revision: 'revision-after-push' },
        results: [{
          requestId: operation.requestId,
          action: operation.action,
          ok: true,
          data: {
            todos: [{ id: operation.payload.clientItems[0].id, title: '真实上传测试', status: 'planned', version: 1 }],
            history: []
          }
        }]
      })
    }
    assert.equal(data.action, 'sync.snapshot')
    assert.equal(data.payload.knownRevision, 'revision-before-push')
    return success({
      notModified: false,
      revision: 'revision-after-push',
      date: shanghaiDateKey(),
      bootstrap: { onboardingRequired: false },
      data: { todos: [{ id: 'cloud-other', title: '电脑端最新待办', status: 'planned' }], history: [] },
      tasks: [],
      diaryDays: [{ date: shanghaiDateKey(), summary: '电脑端刚更新的今日小记', updatedAt: '2026-08-30T00:30:00+08:00' }],
      journal: { entries: [], favorites: [], hidden: [], history: [] },
      journalArchive: []
    })
  }, { syncMode: 'cloud-manual', manualSyncOnly: true })
  client.storage.set('syncRevision', 'revision-before-push')
  client.storage.set('syncSnapshotReady', true)
  client.storage.set('confirmedSnapshot', {
    revision: 'revision-before-push', confirmedAt: '2026-08-20T01:00:00.000Z',
    bootstrap: { onboardingRequired: false }, todayTodos: [], todayHistory: [], tasks: [],
    journal: { entries: [], favorites: [], hidden: [], history: [] }, journalArchive: []
  })

  const queued = await client.api.call('todayTodo.add', { content: '真实上传测试' }, { queueOnFailure: true })
  assert.equal(queued.queued, true)
  assert.equal(client.storage.get('todayTodos').todos[0].title, '真实上传测试')
  assert.equal(client.queue().length, 1)

  const result = await client.api.syncNow({ includeBootstrap: true })

  assert.deepEqual(calls, ['sync.push', 'sync.snapshot'])
  assert.equal(result.flush.sent, 1)
  assert.equal(client.queue().length, 0)
  assert.equal(client.storage.get('confirmedSnapshot').todayTodos[0].title, '电脑端最新待办')
  assert.equal(client.storage.get('confirmedSnapshot').diaryDays[0].summary, '电脑端刚更新的今日小记')
  assert.equal(result.views.diaryDays[0].summary, '电脑端刚更新的今日小记')
})

test('当前版本没有定时轮询，离线队列由启动、手动或退出补传', () => {
  const fs = require('node:fs')
  const appSource = fs.readFileSync(path.join(MINI_ROOT, 'app.js'), 'utf8')
  const desktopSource = fs.readFileSync(path.join(__dirname, '..', '..', 'personal-task-workbench-4320-wechat-login-test', 'electron', 'main.cjs'), 'utf8')
  assert.match(appSource, /if \(this\.startupSyncDone\) return/)
  assert.doesNotMatch(appSource, /setInterval\(/)
  assert.match(appSource, /channelId\.startsWith\('sync_head_'\)/)
  assert.doesNotMatch(appSource, /onLaunch\(\)[\s\S]{0,400}api\.flushQueue\(/)
  const captureSource = fs.readFileSync(path.join(MINI_ROOT, 'pages/capture/index.js'), 'utf8')
  assert.doesNotMatch(captureSource, /onShow\(\)[\s\S]{0,700}api\.flushQueue\(/)
  assert.doesNotMatch(captureSource, /requestSync\('journal-show'\)/)
  assert.doesNotMatch(desktopSource, /cloudSyncFallbackTimer = setInterval/)
  assert.doesNotMatch(desktopSource, /startEventSync\(userData\);/)
})
