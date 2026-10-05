const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const policyPath = path.join(__dirname, '..', 'miniprogram', 'utils', 'sync-policy.js')
const loaded = { exports: {} }
new Function('module', 'exports', fs.readFileSync(policyPath, 'utf8'))(loaded, loaded.exports)
const order = loaded.exports
const policy = loaded.exports
const fixture = require('./fixtures/today-todo-order.json')

function row(id, overrides = {}) {
  return {
    id,
    status: 'planned',
    priority: 'normal',
    pinned: false,
    priorityPinned: false,
    sortRank: 1,
    createdAt: '2026-08-18T08:00:00.000Z',
    version: 1,
    ...overrides
  }
}

test('今日待办统一按状态、优先置顶、普通置顶、排序值、创建时间和 ID 排列', () => {
  assert.deepEqual(order.sortTodayTodos(fixture.rows).map((todo) => todo.id), fixture.expected)
})

test('缺失状态与混合排序值严格遵守桌面端排序契约', () => {
  const rows = [
    row('done-priority', { status: 'done', pinned: true, priorityPinned: true, sortRank: 999999 }),
    row('missing-status', { status: undefined, pinned: true, priorityPinned: true, sortRank: 999998 }),
    row('planned-priority', { pinned: true, priorityPinned: true, sortRank: 1 }),
    row('planned-pin-created', { pinned: true, sortRank: '', createdAt: '2026-08-18T12:00:00.000Z' }),
    row('planned-pin-invalid', { pinned: true, sortRank: 'not-a-number', createdAt: '2026-08-18T11:00:00.000Z' }),
    row('planned-open-newer', { sortRank: null, createdAt: '2026-08-18T10:00:00.000Z' }),
    row('planned-open-explicit', { sortRank: 2, createdAt: '2026-08-18T13:00:00.000Z' }),
    row('planned-open-tie-b', { sortRank: 1, createdAt: '2026-08-18T08:00:00.000Z' }),
    row('planned-open-tie-a', { sortRank: 1, createdAt: '2026-08-18T08:00:00.000Z' })
  ]

  assert.deepEqual(order.sortTodayTodos(rows).map((todo) => todo.id), [
    'planned-priority',
    'planned-pin-created', 'planned-pin-invalid',
    'planned-open-newer', 'planned-open-explicit', 'planned-open-tie-a', 'planned-open-tie-b',
    'done-priority', 'missing-status'
  ])
})

test('置顶离线意图会设置或清除优先置顶，并立即回到统一顺序', () => {
  const rows = [
    row('regular-pin', { pinned: true, sortRank: 500 }),
    row('high-target', { priority: 'high', sortRank: 100 })
  ]
  const pinned = policy.overlayQueuedTodoIntents({ todos: rows }, [{
    action: 'todayTodo.setPin',
    payload: { todoId: 'high-target', pinned: true },
    createdAt: '2026-08-18T10:00:00.000Z'
  }])
  assert.deepEqual(pinned.todos.map((todo) => todo.id), ['high-target', 'regular-pin'])
  assert.equal(pinned.todos[0].priorityPinned, true)

  const unpinned = policy.overlayQueuedTodoIntents(pinned, [{
    action: 'todayTodo.setPin',
    payload: { todoId: 'high-target', pinned: false },
    createdAt: '2026-08-18T10:05:00.000Z'
  }])
  const target = unpinned.todos.find((todo) => todo.id === 'high-target')
  assert.equal(target.pinned, false)
  assert.equal(target.priorityPinned, false)
  assert.equal(unpinned.todos[0].id, 'regular-pin')
})

test('关闭自动优先置顶后，高优先级待办只进入普通置顶层', () => {
  const rows = [
    row('regular-pin', { pinned: true, sortRank: 500 }),
    row('high-target', { priority: 'high', sortRank: 100 })
  ]
  const pinned = policy.overlayQueuedTodoIntents({ todos: rows }, [{
    action: 'todayTodo.setPin',
    payload: { todoId: 'high-target', pinned: true, autoPinHighPriorityTodos: false },
    createdAt: '2026-08-18T10:00:00.000Z'
  }])

  assert.equal(pinned.todos.find((todo) => todo.id === 'high-target').priorityPinned, false)
  assert.deepEqual(pinned.todos.map((todo) => todo.id), ['high-target', 'regular-pin'])
})

test('拖动排序不能跨越优先置顶、普通置顶和未置顶三个层级', () => {
  const rows = [
    row('priority-a', { priority: 'high', pinned: true, priorityPinned: true, sortRank: 100 }),
    row('pin-a', { pinned: true, sortRank: 90 }),
    row('pin-b', { pinned: true, sortRank: 80 }),
    row('open-a', { sortRank: 70 }),
    row('open-b', { sortRank: 60 })
  ]
  const reordered = order.sortTodayTodos(order.applyOrderedIds(rows, [
    'open-b', 'priority-a', 'pin-b', 'open-a', 'pin-a'
  ]))
  assert.deepEqual(reordered.map((todo) => todo.id), [
    'priority-a', 'pin-b', 'pin-a', 'open-b', 'open-a'
  ])
})

test('离线拖动与云端新任务合并时保留新任务位置，只重排原来可见的同层任务', () => {
  const latest = [
    row('priority-a', { priority: 'high', pinned: true, priorityPinned: true, sortRank: 1000, version: 4 }),
    row('pin-new-cloud', { pinned: true, sortRank: 950, version: 2 }),
    row('pin-a', { pinned: true, sortRank: 900, version: 3 }),
    row('pin-b', { pinned: true, sortRank: 800, version: 5 }),
    row('open-new-cloud', { sortRank: 750, version: 2 }),
    row('open-a', { sortRank: 700, version: 3 }),
    row('open-b', { sortRank: 600, version: 6 })
  ]
  const rebased = policy.rebaseTodoQueueItem({
    action: 'todayTodo.reorder',
    payload: {
      orderedIds: ['open-b', 'priority-a', 'pin-b', 'pin-a', 'open-a'],
      versions: {}
    }
  }, latest)

  assert.equal(rebased.satisfied, false)
  assert.deepEqual(rebased.item.payload.orderedIds, [
    'priority-a',
    'pin-new-cloud', 'pin-b', 'pin-a',
    'open-new-cloud', 'open-b', 'open-a'
  ])
  assert.deepEqual(rebased.item.payload.versions, Object.fromEntries(latest.map((todo) => [todo.id, todo.version])))
})

test('离线队列重放完成后会再次统一排序，完成项不会压到未完成项前面', () => {
  const rows = [
    row('todo-a', { pinned: true, sortRank: 20 }),
    row('todo-b', { priority: 'high', pinned: true, priorityPinned: true, sortRank: 10 })
  ]
  const overlaid = policy.overlayQueuedTodoIntents({ todos: rows }, [{
    action: 'todayTodo.complete',
    payload: { todoId: 'todo-b' },
    createdAt: '2026-08-18T11:00:00.000Z'
  }])
  assert.deepEqual(overlaid.todos.map((todo) => todo.id), ['todo-a', 'todo-b'])
  assert.equal(overlaid.todos[1].priorityPinned, false)
})
