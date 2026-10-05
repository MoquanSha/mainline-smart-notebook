const test = require('node:test')
const assert = require('node:assert/strict')
const { __test } = require('../cloudfunctions/desktopSync/index.js')

test('desktop devices prefer the explicit workspace id', () => {
  assert.equal(__test.deviceWorkspaceId({ workspaceId: 'workspace_new', ownerOpenId: 'legacy' }), 'workspace_new')
  assert.equal(__test.deviceWorkspaceId({ ownerOpenId: 'workspace_legacy' }), 'workspace_legacy')
})

test('deterministic desktop documents are scoped by workspace', () => {
  assert.notEqual(
    __test.cloudDocumentId('workspace_a', 'day_records', 'day_2026-08-06'),
    __test.cloudDocumentId('workspace_b', 'day_records', 'day_2026-08-06')
  )
  assert.equal(__test.cloudDocumentId('workspace_a', 'tasks', 'task_random'), 'task_random')
})

test('desktop sync removes secret fields before upload', () => {
  const cleaned = __test.sanitize({ title: 'task', token: 'secret', nested: { password: 'hidden', value: 1 } })
  assert.deepEqual(cleaned, { title: 'task', nested: { value: 1 } })
})

test('desktop realtime users are deterministic without exposing device ids', () => {
  const first = __test.realtimeCustomUserId('device_secret_123')
  const second = __test.realtimeCustomUserId('device_secret_123')
  assert.equal(first, second)
  assert.match(first, /^device_[a-f0-9]{24}$/)
  assert.equal(first.includes('secret'), false)
})
