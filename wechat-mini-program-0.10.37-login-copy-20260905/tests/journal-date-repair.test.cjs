const test = require('node:test')
const assert = require('node:assert/strict')
const { dateFromValue, planForRows, verifyPlan, backupForRows } = require('../cloudfunctions/notebookApi/tools/journal-date-repair.cjs')

test('journal date repair previews only missing dates using Shanghai time', () => {
  const rows = [
    { id: 'legacy', ownerOpenId: 'space-a', entryKind: 'journal_entry', journalDate: '', occurredAt: '2026-09-19T16:30:00.000Z', content: '保留' },
    { id: 'explicit', ownerOpenId: 'space-a', entryKind: 'journal_entry', journalDate: '2026-09-18', occurredAt: '2026-09-19T16:30:00.000Z' },
    { id: 'other-space', ownerOpenId: 'space-b', entryKind: 'journal_entry', journalDate: '', occurredAt: '2026-09-19T16:30:00.000Z' },
  ]
  const plan = planForRows(rows, 'space-a')
  assert.equal(dateFromValue('2026-09-19T16:30:00.000Z'), '2026-09-20')
  assert.deepEqual(plan.candidates.map((item) => [item.id, item.after.journalDate]), [['legacy', '2026-09-20']])
  assert.equal(plan.digest.length, 64)
  assert.doesNotThrow(() => verifyPlan(plan, 'space-a'))
  assert.throws(() => verifyPlan({ ...plan, ownerOpenId: 'space-b' }, 'space-a'), /摘要不匹配/)
})

test('repair backup contains the complete original rows before writes', () => {
  const rows = [{ _id: 'legacy', id: 'legacy', ownerOpenId: 'space-a', entryKind: 'journal_entry', journalDate: '', occurredAt: '2026-09-19T16:30:00.000Z', rawContent: '原文🙂' }]
  const plan = planForRows(rows, 'space-a')
  const backup = backupForRows(rows, plan)
  assert.equal(backup.planDigest, plan.digest)
  assert.deepEqual(backup.rows, rows)
})
