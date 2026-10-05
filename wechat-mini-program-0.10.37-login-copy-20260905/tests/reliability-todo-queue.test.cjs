const test = require('node:test')
const assert = require('node:assert/strict')
const { rebaseTodoQueueItem, overlayQueuedTodoIntents } = require('../miniprogram/utils/sync-policy')
test('one acknowledged item cannot acknowledge a multi-item add', () => {
  const operation = { action: 'todayTodo.add', payload: { clientItems: [{ id: 'a' }, { id: 'b' }] } }
  assert.equal(rebaseTodoQueueItem(operation, [{ id: 'a' }]).satisfied, false)
  assert.equal(rebaseTodoQueueItem(operation, [{ id: 'a' }, { id: 'b' }]).satisfied, true)
})
test('absence from a partial snapshot cannot discard an unconfirmed operation', () => {
  const operation = { action: 'todayTodo.commentAdd', payload: { todoId: 'off-page', content: '保留' } }
  assert.equal(rebaseTodoQueueItem(operation, []).discarded, false)
  assert.equal(rebaseTodoQueueItem(operation, []).satisfied, false)
})
test('an offline completion cannot make a deleted todo visible again', () => {
  const deleted = { id: 'a', status: 'removed', trashedAt: '2026-09-24T01:00:00Z' }
  const operation = { action: 'todayTodo.complete', payload: { todoId: 'a' } }
  assert.equal(rebaseTodoQueueItem(operation, [deleted]).discarded, true)
  assert.equal(overlayQueuedTodoIntents({ todos: [deleted] }, [operation]).todos[0].status, 'removed')
})
test('an unsent comment on a deleted record is retained for explicit recovery', () => {
  const operation = { action: 'todayTodo.commentAdd', payload: { todoId: 'a', content: '不能丢掉的文字' } }
  const result = rebaseTodoQueueItem(operation, [{ id: 'a', deletedAt: '2026-09-24T01:00:00Z' }])
  assert.equal(result.discarded, false)
  assert.equal(result.satisfied, false)
  assert.equal(result.item.payload.content, operation.payload.content)
})
