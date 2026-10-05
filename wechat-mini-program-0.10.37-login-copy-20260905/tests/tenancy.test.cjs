const test = require('node:test')
const assert = require('node:assert/strict')
const { __test } = require('../cloudfunctions/notebookApi/index.js')

test('the same logical day is stored under different workspace document ids', () => {
  const a = __test.scopedDayId('workspace_a', '2026-08-06')
  const b = __test.scopedDayId('workspace_b', '2026-08-06')
  assert.notEqual(a, b)
  assert.match(a, /_day_records_2026-08-06$/)
})

test('membership ids are stable and isolated by workspace', () => {
  assert.equal(__test.membershipId('workspace_a', 'user_1'), __test.membershipId('workspace_a', 'user_1'))
  assert.notEqual(__test.membershipId('workspace_a', 'user_1'), __test.membershipId('workspace_b', 'user_1'))
})

test('invitation codes are normalized without ambiguous separators', () => {
  assert.equal(__test.normalizeInviteCode(' ab-cd 2345 '), 'ABCD2345')
  assert.equal(__test.roleAllowed('admin', ['owner', 'admin']), true)
  assert.equal(__test.roleAllowed('member', ['owner', 'admin']), false)
})

test('beta workspaces stop issuing seats after five active members', () => {
  assert.equal(__test.betaSeatsRemaining(0), 5)
  assert.equal(__test.betaSeatsRemaining(4), 1)
  assert.equal(__test.betaSeatsRemaining(5), 0)
  assert.equal(__test.betaSeatsRemaining(12), 0)
})

test('mini and official account identities use different provider namespaces', () => {
  assert.notEqual(__test.identityId('wechat_mini', 'same-open-id'), __test.identityId('wechat_mp', 'same-open-id'))
})

test('mini identity ignores caller supplied userInfo', () => {
  assert.notEqual(
    __test.ownerFrom({ userInfo: { openId: 'forged-open-id' } }, {}),
    'forged-open-id'
  )
})
