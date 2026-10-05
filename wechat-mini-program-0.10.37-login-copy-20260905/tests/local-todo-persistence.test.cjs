const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const modulePath = path.join(__dirname, '..', 'miniprogram', 'utils', 'local-todo-state.js')
const loaded = { exports: {} }
new Function('module', 'exports', fs.readFileSync(modulePath, 'utf8'))(loaded, loaded.exports)
const state = loaded.exports

test('离线完成和置顶后的可见状态可以写入手机快照并在重开后恢复', () => {
  const cached = {
    history: [{ date: '2026-08-14', todos: [{ id: 'old-1' }] }],
    todos: [{ id: 'todo-1', status: 'planned', pinned: false }]
  }
  const active = [{ id: 'todo-2', status: 'planned', pinned: true }]
  const completed = [{ id: 'todo-1', status: 'done', pinned: false }]

  const next = state.mergeVisibleState(cached, active, completed)

  assert.deepEqual(next.todos, [...active, ...completed])
  assert.deepEqual(next.history, cached.history)
})

test('离线顺延或移出今天时，本地快照不会重新带回已经移除的待办', () => {
  const cached = { todos: [{ id: 'todo-1' }, { id: 'todo-2' }], history: [] }
  const next = state.mergeVisibleState(cached, [{ id: 'todo-2', status: 'planned' }], [])

  assert.deepEqual(next.todos.map((todo) => todo.id), ['todo-2'])
})
