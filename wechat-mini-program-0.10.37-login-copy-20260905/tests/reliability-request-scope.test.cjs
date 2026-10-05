const test = require('node:test')
const assert = require('node:assert/strict')
const cloud = require('../cloudfunctions/notebookApi/index.js').__test
const principal = { userId: 'real-user', workspaceId: 'A' }

test('new scoped requests cannot be redirected by an intervening workspace or identity change', () => {
  assert.throws(() => cloud.assertRequestScope({ userId: 'real-user', workspaceId: 'B' }, principal), { code: 'WORKSPACE_MISMATCH' })
  assert.throws(() => cloud.assertRequestScope({ userId: 'forged-user', workspaceId: 'A' }, principal), { code: 'WORKSPACE_MISMATCH' })
  assert.throws(() => cloud.assertRequestScope({}, principal), { code: 'WORKSPACE_MISMATCH' })
  assert.doesNotThrow(() => cloud.assertRequestScope({ userId: 'real-user', workspaceId: 'A' }, principal))
})

test('old clients remain accepted without a new scope envelope during staggered rollout', () => {
  assert.doesNotThrow(() => cloud.assertRequestScope(undefined, principal))
})
