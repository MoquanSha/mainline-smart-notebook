const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { cloudRuntime } = require('./helpers/cloud-runtime.cjs')
const { createTodoStore } = require('../cloudfunctions/notebookApi/todo-store')
const { todayTodoCarryId } = require('../cloudfunctions/notebookApi/todo-lineage')
const owner = 'space-a', date = '2026-09-24'
const row = (id, patch = {}) => ({ id, ownerOpenId: owner, workspaceId: owner, date: '2026-09-23', entryKind: 'today_todo', status: 'planned', title: '同名待办', rawInput: '同名待办', relatedTaskId: 'same-task', source: 'manual', version: 1, deletedAt: '', comments: [], ...patch })
function runtime(...rows) {
  const cloud = cloudRuntime(rows)
  const store = createTodoStore({ db: cloud.db, buildCarried: cloud.api.buildCarriedTodayTodo })
  return { ...cloud, store, get: (id) => cloud.rows.get(`daily_tasks/${id}`) }
}

test('simultaneous and replayed cloud rollover creates one target without overwriting later edits', async () => {
  const cloud = runtime(row('original'))
  const results = await Promise.all([cloud.store.carry(owner, 'original', date, 1), cloud.store.carry(owner, 'original', date, 1)])
  const id = todayTodoCarryId('original', date)
  assert.equal(results.filter((item) => item.carried).length, 1)
  const edited = { ...cloud.get(id), comments: [{ id: 'c', content: '另一个设备已写入' }], version: 2 }
  cloud.rows.set(`daily_tasks/${id}`, edited)
  await cloud.store.carry(owner, 'original', date, 1)
  assert.deepEqual(cloud.get(id), edited)
  assert.equal(cloud.get('original').status, 'postponed')
})

test('cloud rollover respects a tombstone and legacy completed descendants', async () => {
  for (const patch of [{ deletedAt: '2026-09-23T12:00:00Z' }, { status: 'removed', trashedAt: '2026-09-23T12:00:00Z' }, { status: 'done' }]) {
    const cloud = runtime(row('root', { date: '2026-09-20' }), row('middle', { date: '2026-09-21', carriedFromId: 'root', status: 'postponed' }), row('leaf', { carriedFromId: 'middle', ...patch }))
    const result = await cloud.store.carry(owner, 'root', date, 1, { automatic: true })
    assert.equal(result.carried, false)
    assert.equal(cloud.get(todayTodoCarryId('root', date)), undefined)
    assert.deepEqual(cloud.get('leaf'), row('leaf', { carriedFromId: 'middle', ...patch }))
  }
})

test('real daily rollover handler carries independent dates and marks its completed check', async () => {
  const cloud = runtime(row('a', { date: '2026-09-20' }), row('b'))
  const result = await cloud.api.ensureDailyTodayTodoRollover(owner, null, date)
  assert.equal(result.carried, 2)
  assert.equal(cloud.get(todayTodoCarryId('a', date)).lineageId, 'a')
  assert.equal(cloud.get(todayTodoCarryId('b', date)).lineageId, 'b')
  const before = { ...cloud.metrics }
  const replay = await cloud.api.ensureDailyTodayTodoRollover(owner, result.signal, date)
  assert.equal(replay.checked, false)
  assert.deepEqual(cloud.metrics, before)
})

test('atomic creation preserves distinct same-title IDs, detects ID reuse and refuses another workspace', async () => {
  const cloud = runtime()
  await Promise.all([cloud.store.create(owner, row('a')), cloud.store.create(owner, row('b')), cloud.store.create(owner, row('a'))])
  assert.equal(cloud.rows.size, 2)
  await assert.rejects(cloud.store.create(owner, row('a', { title: '另一个意思' })), { code: 'INPUT_ID_CONFLICT' })
  await assert.rejects(cloud.store.create('space-b', row('a')), { code: 'FORBIDDEN' })
  await assert.rejects(cloud.store.carry('space-b', 'a', date, 1), { code: 'NOT_FOUND' })
})

test('explicit defer and automatic rollover share an ID and cannot reopen a deleted target', async () => {
  const id = todayTodoCarryId('original', date)
  const tombstone = row(id, { lineageId: 'original', date, status: 'removed', deletedAt: '2026-09-24T01:00:00Z' })
  const cloud = runtime(row('original'), tombstone)
  const result = await cloud.store.carry(owner, 'original', date, 1)
  assert.equal(result.carried, false)
  assert.deepEqual(cloud.get(id), tombstone)
})

test('independently packaged lineage modules stay byte-identical', () => {
  const mobile = fs.readFileSync(path.join(__dirname, '../cloudfunctions/notebookApi/todo-lineage.js'), 'utf8')
  const desktop = fs.readFileSync(path.join(__dirname, '../../personal-task-workbench-4320-wechat-login-test/electron/todo-lineage.cjs'), 'utf8')
  assert.equal(desktop, mobile)
})

test('a deleted descendant arriving after discovery is rechecked inside the transaction', async () => {
  const cloud = runtime(row('root', { date: '2026-09-21' }), row('leaf', { carriedFromId: 'root' }))
  const transact = cloud.db.runTransaction
  cloud.db.runTransaction = (callback) => {
    cloud.rows.set('daily_tasks/leaf', { ...cloud.get('leaf'), status: 'removed', trashedAt: '2026-09-24T01:00:00Z', version: 2 })
    return transact.call(cloud.db, callback)
  }
  const result = await cloud.store.carry(owner, 'root', date, 1, { automatic: true })
  assert.equal(result.carried, false)
  assert.equal(cloud.get(todayTodoCarryId('root', date)), undefined)
  assert.equal(cloud.get('leaf').status, 'removed')
})

test('concurrent delete/completion use fresh versions and stale completion cannot restore the record', async () => {
  const cloud = runtime(row('a'))
  const results = await Promise.allSettled([
    cloud.store.patch(owner, 'a', { status: 'removed', trashedAt: '2026-09-24T01:00:00Z' }, 1),
    cloud.store.patch(owner, 'a', { status: 'done' }, 1)
  ])
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].reason.code, 'RECORD_DELETED')
  assert.equal(cloud.get('a').status, 'removed')
  await assert.rejects(cloud.api.mutateTodayTodo(owner, 'todayTodo.complete', { todoId: 'a', baseVersion: 1 }), { code: 'RECORD_DELETED' })
})

test('detail handlers block comments and pins on recycled todos before invoking AI', async () => {
  const cloud = runtime(row('a', { status: 'removed', trashedAt: '2026-09-24T01:00:00Z' }))
  for (const action of ['todayTodo.commentAdd', 'todayTodo.setPin', 'todayTodo.commentDelete']) {
    await assert.rejects(cloud.api.mutateTodayTodoDetail(owner, action, { todoId: 'a', commentId: 'todo_comment_client_123_abc', content: '保留原文' }), { code: 'RECORD_DELETED' })
  }
  assert.equal(cloud.metrics.writes, 0)
})

test('a repeated comment ID is acknowledged without generating duplicate text or AI calls', async () => {
  const comment = { id: 'todo_comment_client_123_abc', rawContent: '一段原文', content: '一段原文' }
  const cloud = runtime(row('a', { comments: [comment] }))
  await cloud.api.mutateTodayTodoDetail(owner, 'todayTodo.commentAdd', { todoId: 'a', commentId: comment.id, content: comment.rawContent })
  assert.deepEqual(cloud.get('a').comments, [comment])
  assert.equal(cloud.metrics.writes, 0)
})
