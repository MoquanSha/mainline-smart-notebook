const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')

const MINI_ROOT = path.join(__dirname, '..', 'miniprogram')

function compileCommonJs(file, dependencyMap = {}) {
  const source = fs.readFileSync(file, 'utf8')
  const module = { exports: {} }
  const localRequire = (request) => Object.prototype.hasOwnProperty.call(dependencyMap, request)
    ? dependencyMap[request]
    : require('node:module').createRequire(file)(request)
  const factory = new Function('require', 'module', 'exports', '__filename', '__dirname', source)
  factory(localRequire, module, module.exports, file, path.dirname(file))
  return module.exports
}

function success(data) {
  return Promise.resolve({ result: { ok: true, data } })
}

function baseSnapshot(overrides = {}) {
  const data = { todos: [], scheduled: [], history: [], ...(overrides.data || {}) }
  return {
    notModified: false,
    revision: overrides.revision || 'matrix-revision',
    bootstrap: { onboardingRequired: false, storagePrefix: 'users/test/todo-comments' },
    data,
    tasks: [],
    journal: { entries: [], favorites: [], hidden: [], history: [] },
    journalArchive: [],
    diaryDays: [],
    ...overrides,
    data
  }
}

function loadClient(handler) {
  let queue = []
  let requestSequence = 0
  const storage = new Map()
  global.wx = { cloud: { callFunction: handler } }
  global.getApp = () => ({ startRealtimeSync() {}, notifySyncListeners() {} })
  const cache = {
    KEYS: {
      queue: 'queue', bootstrap: 'bootstrap', todayTodos: 'todayTodos',
      journal: 'journal', journalArchive: 'journalArchive', trash: 'trash',
      proposals: 'proposals', tasks: 'tasks', mirrorQueue: 'mirrorQueue',
      diaryDays: 'diaryDays',
      homeConnection: 'homeConnection', hybridState: 'hybridState',
      syncRevision: 'syncRevision', syncSnapshotReady: 'syncSnapshotReady',
      confirmedSnapshot: 'confirmedSnapshot'
    },
    read(key, fallback) { return key === 'queue' ? queue : (storage.has(key) ? storage.get(key) : fallback) },
    write(key, value) { if (key === 'queue') queue = value; else storage.set(key, value); return value },
    requestId(prefix = 'req') { requestSequence += 1; return `${prefix}_matrix_${requestSequence}` },
    enqueue(action, payload, options = {}) {
      const id = options.id || payload.requestId || `${action}_queued`
      const existing = queue.find((item) => item.id === id)
      if (existing) return existing
      const coalesceKey = String(options.coalesceKey || '')
      const item = { id, action, payload, coalesceKey, attempts: 0, createdAt: '2026-08-20T01:00:00.000Z' }
      queue = coalesceKey
        ? [...queue.filter((queued) => queued.coalesceKey !== coalesceKey), item]
        : [...queue, item]
      return item
    },
    dequeue(id) { queue = queue.filter((item) => item.id !== id); return queue },
    readConnection() { return { serverBaseUrl: '', token: '' } },
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
    enqueueMirror() { throw new Error('manual sync must not enqueue mirror work') }
  }
  const syncPolicy = compileCommonJs(path.join(MINI_ROOT, 'utils', 'sync-policy.js'))
  const hybridPolicy = compileCommonJs(path.join(MINI_ROOT, 'utils', 'hybrid-policy.js'))
  const home = {
    configured() { return false },
    connection() { return { serverBaseUrl: '', token: '' } },
    rpc() { return Promise.reject(new Error('home unavailable')) },
    testConnection() { return Promise.reject(new Error('home unavailable')) },
    uploadImage() { return Promise.reject(new Error('home unavailable')) }
  }
  const api = compileCommonJs(path.join(MINI_ROOT, 'utils', 'api.js'), {
    '../config/env': {
      apiFunction: 'notebookApi', clientVersion: 'matrix-test', cloudSyncEnabled: true,
      syncMode: 'cloud-manual', manualSyncOnly: true
    },
    './cache': cache,
    './home-transport': home,
    './hybrid-policy': hybridPolicy,
    './sync-policy': syncPolicy
  })
  return { api, queue: () => queue, storage }
}

function uploadCases() {
  const todo = (id, extra = {}) => ({
    id, status: 'planned', pinned: false, priorityPinned: false, version: 3,
    sortRank: 10, comments: [], ...extra
  })
  const journal = (id, extra = {}) => ({ id, version: 5, journalDate: '2026-08-20', ...extra })
  const taskRow = (id, extra = {}) => ({ id, version: 4, status: 'active', progress: 10, ...extra })
  return [
    {
      name: '今日待办新增', action: 'todayTodo.add', payload: { content: '同步矩阵新增待办' },
      snapshot: baseSnapshot(),
      verify(payload) { assert.equal(payload.content, '同步矩阵新增待办'); assert.equal(payload.clientItems.length, 1) }
    },
    {
      name: '今日待办完成', action: 'todayTodo.complete', payload: { todoId: 'todo-complete', baseVersion: 1 },
      snapshot: baseSnapshot({ data: { todos: [todo('todo-complete')], history: [] } }),
      verify(payload) { assert.equal(payload.todoId, 'todo-complete'); assert.equal(payload.baseVersion, 3) }
    },
    {
      name: '今日待办撤回完成', action: 'todayTodo.reopen', payload: { todoId: 'todo-reopen', baseVersion: 1 },
      snapshot: baseSnapshot({ data: { todos: [todo('todo-reopen', { status: 'done', completedAt: '2026-08-20T02:00:00.000Z' })], history: [] } }),
      verify(payload) { assert.equal(payload.todoId, 'todo-reopen'); assert.equal(payload.baseVersion, 3) }
    },
    {
      name: '今日待办顺延', action: 'todayTodo.defer', payload: { todoId: 'todo-defer', baseVersion: 1 },
      snapshot: baseSnapshot({ data: { todos: [todo('todo-defer')], history: [] } }),
      verify(payload) { assert.equal(payload.todoId, 'todo-defer'); assert.equal(payload.baseVersion, 3) }
    },
    {
      name: '今日待办移出', action: 'todayTodo.delete', payload: { todoId: 'todo-delete', baseVersion: 1 },
      snapshot: baseSnapshot({ data: { todos: [todo('todo-delete')], history: [] } }),
      verify(payload) { assert.equal(payload.todoId, 'todo-delete'); assert.equal(payload.baseVersion, 3) }
    },
    {
      name: '今日待办置顶状态', action: 'todayTodo.setPin', payload: { todoId: 'todo-pin', pinned: true, baseVersion: 1 },
      snapshot: baseSnapshot({ data: { todos: [todo('todo-pin')], history: [] } }),
      verify(payload) { assert.equal(payload.pinned, true); assert.equal(payload.baseVersion, 3) }
    },
    {
      name: '今日待办手动排序', action: 'todayTodo.reorder',
      payload: { orderedIds: ['todo-order-a', 'todo-order-b'], versions: { 'todo-order-a': 1, 'todo-order-b': 1 } },
      snapshot: baseSnapshot({ data: { todos: [todo('todo-order-a', { sortRank: 1 }), todo('todo-order-b', { sortRank: 2 })], history: [] } }),
      verify(payload) { assert.deepEqual(payload.orderedIds.slice(0, 2), ['todo-order-a', 'todo-order-b']) }
    },
    {
      name: '今日待办新增文字或图片笔记', action: 'todayTodo.commentAdd',
      payload: { todoId: 'todo-comment-add', commentId: 'comment-new', content: '同步笔记', attachments: [], baseVersion: 1 },
      snapshot: baseSnapshot({ data: { todos: [todo('todo-comment-add')], history: [] } }),
      verify(payload) { assert.equal(payload.commentId, 'comment-new'); assert.equal(payload.content, '同步笔记') }
    },
    {
      name: '今日待办删除笔记', action: 'todayTodo.commentDelete',
      payload: { todoId: 'todo-comment-delete', commentId: 'comment-existing', baseVersion: 1 },
      snapshot: baseSnapshot({ data: { todos: [todo('todo-comment-delete', { comments: [{ id: 'comment-existing' }] })], history: [] } }),
      verify(payload) { assert.equal(payload.commentId, 'comment-existing'); assert.equal(payload.baseVersion, 3) }
    },
    {
      name: '灵光一现新增', action: 'journal.create', payload: { id: 'journal-create', content: '同步矩阵灵光' },
      snapshot: baseSnapshot(),
      verify(payload) { assert.equal(payload.id, 'journal-create'); assert.equal(payload.content, '同步矩阵灵光') }
    },
    {
      name: '灵光一现勾选清单', action: 'journal.toggleItem',
      payload: { entryId: 'journal-toggle', itemId: 'check-1', done: true, baseVersion: 1 },
      snapshot: baseSnapshot({ journal: { entries: [journal('journal-toggle', { checklistItems: [{ id: 'check-1', done: false }] })], favorites: [], hidden: [], history: [] } }),
      verify(payload) { assert.equal(payload.done, true); assert.equal(payload.baseVersion, 5) }
    },
    {
      name: '灵光一现补充内容', action: 'journal.append',
      payload: { entryId: 'journal-append', content: '追加同步内容', baseVersion: 1 },
      snapshot: baseSnapshot({ journal: { entries: [journal('journal-append')], favorites: [], hidden: [], history: [] } }),
      verify(payload) { assert.equal(payload.content, '追加同步内容'); assert.equal(payload.baseVersion, 5) }
    },
    {
      name: '灵光一现收藏状态', action: 'capture.setFavorite',
      payload: { id: 'journal-favorite', favorited: true, baseVersion: 1 },
      snapshot: baseSnapshot({ journal: { entries: [journal('journal-favorite')], favorites: [], hidden: [], history: [] } }),
      verify(payload) { assert.equal(payload.favorited, true); assert.equal(payload.baseVersion, 5) }
    },
    {
      name: '灵光一现隐藏', action: 'capture.hide', payload: { id: 'journal-hide', baseVersion: 1 },
      snapshot: baseSnapshot({ journal: { entries: [journal('journal-hide')], favorites: [], hidden: [], history: [] } }),
      verify(payload) { assert.equal(payload.id, 'journal-hide'); assert.equal(payload.baseVersion, 5) }
    },
    {
      name: '灵光一现恢复隐藏', action: 'capture.restoreHidden', payload: { id: 'journal-restore', baseVersion: 1 },
      snapshot: baseSnapshot({ journal: { entries: [], favorites: [], hidden: [journal('journal-restore', { hiddenAt: '2026-08-20T01:00:00.000Z' })], history: [] } }),
      verify(payload) { assert.equal(payload.id, 'journal-restore'); assert.equal(payload.baseVersion, 5) }
    },
    {
      name: '长期计划更新进度', action: 'task.update', payload: { id: 'task-update', patch: { progress: 45 }, baseVersion: 1 },
      snapshot: baseSnapshot({ tasks: [taskRow('task-update')] }),
      // Absolute patches keep their original precondition. A newer record must
      // be reviewed rather than silently overwritten during queue preparation.
      verify(payload) { assert.equal(payload.patch.progress, 45); assert.equal(payload.baseVersion, 1) }
    },
    {
      name: '长期计划完成步骤', action: 'task.completeStep',
      payload: { taskId: 'task-step', stepId: 'step-1', baseVersion: 1 },
      snapshot: baseSnapshot({ tasks: [taskRow('task-step', { steps: [{ id: 'step-1', status: 'current' }] })] }),
      verify(payload) { assert.equal(payload.stepId, 'step-1'); assert.equal(payload.baseVersion, 4) }
    },
    {
      name: '长期计划归档或删除', action: 'task.archive',
      payload: { id: 'task-archive', deletePermanently: false, baseVersion: 1 },
      snapshot: baseSnapshot({ tasks: [taskRow('task-archive')] }),
      verify(payload) { assert.equal(payload.deletePermanently, false); assert.equal(payload.baseVersion, 4) }
    }
  ]
}

function mutationResult(action, payload, snapshot) {
  if (action.startsWith('todayTodo.')) return { todos: snapshot.data.todos, history: [] }
  if (action.startsWith('task.')) return { id: payload.id || payload.taskId, version: 5 }
  return { id: payload.id || payload.entryId, version: 6 }
}

test('18类手机写入逐项形成正确上传操作', async (t) => {
  for (const item of uploadCases()) {
    await t.test(item.name, async () => {
      const calls = []
      const client = loadClient(({ data }) => {
        calls.push(data)
        if (data.action === 'sync.snapshot') return success(item.snapshot)
        assert.equal(data.action, 'sync.push')
        const operation = data.payload.operations[0]
        return success({
          changed: true,
          results: [{
            requestId: operation.requestId,
            action: operation.action,
            ok: true,
            data: mutationResult(operation.action, operation.payload, item.snapshot)
          }]
        })
      })
      client.storage.set('confirmedSnapshot', {
        revision: item.snapshot.revision,
        confirmedAt: '2026-08-20T00:59:00.000Z',
        bootstrap: item.snapshot.bootstrap || {},
        todayTodos: item.snapshot.data && item.snapshot.data.todos || [],
        todayHistory: item.snapshot.data && item.snapshot.data.history || [],
        tasks: item.snapshot.tasks || [],
        journal: item.snapshot.journal || { entries: [], favorites: [], hidden: [], history: [] },
        journalArchive: item.snapshot.journalArchive || []
      })

      await client.api.call(item.action, item.payload, { queueOnFailure: true })
      assert.equal(client.queue().length, 1)
      assert.equal(client.queue()[0].action, item.action)
      await client.api.flushDirtyQueueNow({ reason: 'matrix-upload' })

      const pushes = calls.filter((call) => call.action === 'sync.push')
      assert.equal(pushes.length, 1)
      assert.equal(pushes[0].payload.operations.length, 1)
      const operation = pushes[0].payload.operations[0]
      assert.equal(operation.action, item.action)
      item.verify(operation.payload)
      assert.equal(client.queue().length, 0)
    })
  }
})

function receiveCases() {
  const todo = (id, extra = {}) => ({ id, title: id, status: 'planned', version: 2, ...extra })
  const entry = (id, extra = {}) => ({
    id, journalTitle: id, content: id, rawContent: id, journalDate: '2026-08-20', version: 2, ...extra
  })
  const taskRow = (id, extra = {}) => ({ id, title: id, status: 'active', progress: 10, version: 2, ...extra })
  return [
    ['接收新增今日待办', baseSnapshot({ data: { todos: [todo('todo-new')], history: [] } }), (result) => assert.equal(result.data.todos[0].id, 'todo-new')],
    ['接收预约待办', baseSnapshot({ data: { todos: [], scheduled: [todo('todo-scheduled', { date: '2026-08-31', source: 'scheduled' })], history: [] } }), (result) => assert.equal(result.data.scheduled[0].source, 'scheduled')],
    ['接收今日待办完成', baseSnapshot({ data: { todos: [todo('todo-done', { status: 'done', completedAt: '2026-08-20T02:00:00.000Z' })], history: [] } }), (result) => assert.equal(result.data.todos[0].status, 'done')],
    ['接收今日待办顺延', baseSnapshot({ data: { todos: [todo('todo-deferred', { status: 'postponed', deferredTo: 'tomorrow' })], history: [] } }), (result) => assert.equal(result.data.todos[0].deferredTo, 'tomorrow')],
    ['接收今日待办移出', baseSnapshot({ data: { todos: [todo('todo-removed', { status: 'removed', trashedAt: '2026-08-20T02:00:00.000Z' })], history: [] } }), (result) => assert.equal(result.data.todos[0].status, 'removed')],
    ['接收今日待办置顶', baseSnapshot({ data: { todos: [todo('todo-pinned', { pinned: true, priorityPinned: true })], history: [] } }), (result) => assert.equal(result.data.todos[0].priorityPinned, true)],
    ['接收今日待办排序', baseSnapshot({ data: { todos: [todo('todo-first', { sortRank: 20 }), todo('todo-second', { sortRank: 10 })], history: [] } }), (result) => assert.deepEqual(result.data.todos.map((row) => row.id), ['todo-first', 'todo-second'])],
    ['接收今日待办新增笔记和图片', baseSnapshot({ data: { todos: [todo('todo-comment', { comments: [{ id: 'comment-1', content: '笔记', attachments: [{ id: 'image-1', fileID: 'cloud://image', previewUrl: 'https://example.test/image' }] }] })], history: [] } }), (result) => assert.equal(result.data.todos[0].comments[0].attachments[0].fileID, 'cloud://image')],
    ['接收今日待办删除笔记', baseSnapshot({ data: { todos: [todo('todo-comment-deleted', { comments: [{ id: 'comment-1', deletedAt: '2026-08-20T02:00:00.000Z' }] })], history: [] } }), (result) => assert.ok(result.data.todos[0].comments[0].deletedAt)],
    ['接收新增灵光一现', baseSnapshot({ journal: { entries: [entry('journal-new')], favorites: [], hidden: [], history: [] } }), (result) => assert.equal(result.views.journal.entries[0].id, 'journal-new')],
    ['接收灵光一现清单状态', baseSnapshot({ journal: { entries: [entry('journal-check', { checklistItems: [{ id: 'check-1', done: true }] })], favorites: [], hidden: [], history: [] } }), (result) => assert.equal(result.views.journal.entries[0].checklistItems[0].done, true)],
    ['接收灵光一现补充内容', baseSnapshot({ journal: { entries: [entry('journal-append', { journalSupplements: [{ id: 'supplement-1', content: '补充' }] })], favorites: [], hidden: [], history: [] } }), (result) => assert.equal(result.views.journal.entries[0].journalSupplements[0].content, '补充')],
    ['接收灵光一现收藏状态', baseSnapshot({ journal: { entries: [entry('journal-favorite', { favoritedAt: '2026-08-20T02:00:00.000Z' })], favorites: [entry('journal-favorite', { favoritedAt: '2026-08-20T02:00:00.000Z' })], hidden: [], history: [] } }), (result) => assert.equal(result.views.journal.favorites[0].id, 'journal-favorite')],
    ['接收灵光一现隐藏状态', baseSnapshot({ journal: { entries: [], favorites: [], hidden: [entry('journal-hidden', { hiddenAt: '2026-08-20T02:00:00.000Z' })], history: [] } }), (result) => assert.equal(result.views.journal.hidden[0].id, 'journal-hidden')],
    ['接收灵光一现恢复状态', baseSnapshot({ journal: { entries: [entry('journal-restored', { hiddenAt: '' })], favorites: [], hidden: [], history: [] } }), (result) => assert.equal(result.views.journal.entries[0].hiddenAt, '')],
    ['接收电脑端今日小记', baseSnapshot({ diaryDays: [{ id: 'day_records_2026-08-20', date: '2026-08-20', summary: '完成了同步兼容验证。', synthesisUpdatedAt: '2026-08-20T03:00:00.000Z' }] }), (result) => assert.equal(result.views.diaryDays[0].summary, '完成了同步兼容验证。')],
    ['接收长期计划进度', baseSnapshot({ tasks: [taskRow('task-progress', { progress: 65 })] }), (result) => assert.equal(result.views.tasks.tasks[0].progress, 65)],
    ['接收长期计划步骤状态', baseSnapshot({ tasks: [taskRow('task-step', { steps: [{ id: 'step-1', status: 'done' }, { id: 'step-2', status: 'current' }], currentStepId: 'step-2' })] }), (result) => assert.equal(result.views.tasks.tasks[0].currentStepId, 'step-2')],
    ['接收长期计划归档状态', baseSnapshot({ tasks: [taskRow('task-archived', { status: 'archived' })] }), (result) => assert.equal(result.views.tasks.tasks[0].status, 'archived')]
  ]
}

test('19类远端变化逐项进入手机四类缓存', async (t) => {
  for (const [name, snapshot, verify] of receiveCases()) {
    await t.test(name, async () => {
      const client = loadClient(({ data }) => {
        assert.equal(data.action, 'sync.snapshot')
        return success(snapshot)
      })
      const result = await client.api.syncNow({ includeBootstrap: true })
      verify(result)
      assert.deepEqual(client.storage.get('todayTodos'), snapshot.data)
      assert.deepEqual(client.storage.get('tasks'), snapshot.tasks)
      assert.deepEqual(client.storage.get('journal'), snapshot.journal)
      assert.deepEqual(client.storage.get('diaryDays'), snapshot.diaryDays)
    })
  }
})

test('新版小程序读取旧云函数快照时保留已有小记且其他缓存照常更新', async () => {
  const oldSnapshot = baseSnapshot({
    data: { todos: [{ id: 'old-cloud-todo', title: '旧云端待办', status: 'planned', version: 1 }], history: [] },
    tasks: [{ id: 'old-cloud-task', title: '旧云端长期计划', status: 'active', version: 1 }]
  })
  delete oldSnapshot.diaryDays
  const client = loadClient(({ data }) => {
    assert.equal(data.action, 'sync.snapshot')
    return success(oldSnapshot)
  })
  const cachedDiary = [{ id: 'day_records_2026-08-19', date: '2026-08-19', summary: '手机原有小记。' }]
  client.storage.set('diaryDays', cachedDiary)
  const result = await client.api.syncNow({ includeBootstrap: true })
  assert.equal(result.data.todos[0].id, 'old-cloud-todo')
  assert.equal(result.views.tasks.tasks[0].id, 'old-cloud-task')
  assert.deepEqual(result.views.diaryDays, cachedDiary)
  assert.deepEqual(client.storage.get('diaryDays'), cachedDiary)
})

test('批量上传部分失败时只保留失败操作等待重试', async () => {
  const snapshot = baseSnapshot({
    data: { todos: [{ id: 'todo-ok', status: 'planned', version: 2 }], history: [] },
    tasks: [{ id: 'task-fail', status: 'active', progress: 10, version: 2 }]
  })
  const client = loadClient(({ data }) => {
    if (data.action === 'sync.snapshot') return success(snapshot)
    assert.equal(data.action, 'sync.push')
    return success({
      changed: true,
      results: data.payload.operations.map((operation) => operation.action === 'todayTodo.setPin'
        ? { requestId: operation.requestId, action: operation.action, ok: true, data: { todos: snapshot.data.todos } }
        : { requestId: operation.requestId, action: operation.action, ok: false, error: { code: 'TEMPORARY', message: '稍后重试' } })
    })
  })

  await client.api.call('todayTodo.setPin', { todoId: 'todo-ok', pinned: true, baseVersion: 2 })
  await client.api.call('task.update', { id: 'task-fail', patch: { progress: 30 }, baseVersion: 2 })
  await client.api.flushDirtyQueueNow({ reason: 'partial-failure' })

  assert.equal(client.queue().length, 1)
  assert.equal(client.queue()[0].action, 'task.update')
  assert.equal(client.queue()[0].attempts, 1)
})

test('手机与云端使用同一套今日待办拆分规则且只生成所需ID', () => {
  const client = loadClient(() => { throw new Error('不应调用云端') })
  const cloud = require('../cloudfunctions/notebookApi/index.js').__test
  const samples = [
    '给导师发邮件',
    '给导师发邮件；整理申请材料；检查成绩单',
    '1. 给导师发邮件 2. 整理申请材料，然后检查成绩单',
    '整理材料。另外给导师发邮件。还有确认报名时间'
  ]
  for (const content of samples) {
    const miniItems = client.api.splitTodayTodoInput(content)
    const cloudItems = cloud.splitTodayTodoInput(content)
    assert.deepEqual(miniItems, cloudItems)
    const payload = client.api.prepareTodayTodoPayload(content)
    assert.equal(payload.clientItems.length, cloudItems.length)
  }
})
