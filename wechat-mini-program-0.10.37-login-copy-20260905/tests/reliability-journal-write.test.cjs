const test = require('node:test')
const assert = require('node:assert/strict')
const { cloudRuntime } = require('./helpers/cloud-runtime.cjs')

function journal(patch = {}) {
  return { id: 'journal-1', ownerOpenId: 'space-A', workspaceId: 'space-A', source: 'manual',
    entryKind: 'journal_entry', kind: 'journal_entry', status: 'processed',
    rawContent: '原文', content: '原文', journalTitle: '主题', journalSummary: '摘要',
    markdown: '## 主题\n\n原有 **Markdown** 正文', journalDate: '2026-09-24',
    journalSupplements: [], version: 1, deletedAt: '', ...patch }
}
function seeded(entry = journal()) {
  const runtime = cloudRuntime()
  runtime.rows.set('captures/' + entry.id, entry)
  return runtime
}

test('concurrent generic writes compare versions inside the committing transaction', async () => {
  const { api, rows } = seeded()
  const results = await Promise.allSettled([
    api.updateDoc('captures', 'journal-1', { journalTitle: 'first' }, 1),
    api.updateDoc('captures', 'journal-1', { journalTitle: 'second' }, 1)
  ])
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1)
  assert.equal(results.find((item) => item.status === 'rejected').reason.code, 'CONFLICT')
  assert.equal(rows.get('captures/journal-1').version, 2)
})

test('a previously read document cannot bypass the transactional version check', async () => {
  const stale = journal()
  const { api, rows } = seeded(journal({ journalTitle: 'new title', version: 2 }))
  await assert.rejects(api.updateDoc('captures', 'journal-1', { journalTitle: 'old title' }, 1, stale), { code: 'CONFLICT' })
  assert.equal(rows.get('captures/journal-1').journalTitle, 'new title')
})

test('two concurrent supplements both survive and retain distinct stable identities', async () => {
  const { api, rows } = seeded()
  const first = { entryId: 'journal-1', content: 'A 补充', supplementId: 'supplement-A', baseVersion: 1 }
  const second = { entryId: 'journal-1', content: 'B 补充', supplementId: 'supplement-B', baseVersion: 1 }
  await Promise.all([api.appendJournalEntry('space-A', first), api.appendJournalEntry('space-A', second)])
  const saved = rows.get('captures/journal-1')
  assert.deepEqual(saved.journalSupplements.map((item) => item.id).sort(), ['supplement-A', 'supplement-B'])
  assert.equal(saved.version, 3)
  assert.ok(saved.markdown.includes('原有 **Markdown** 正文'))
})

test('duplicate supplement requests do not add another item or advance the revision', async () => {
  const { api, rows } = seeded()
  const payload = { entryId: 'journal-1', content: '同一段补充', supplementId: 'same', baseVersion: 1 }
  await Promise.all([api.appendJournalEntry('space-A', payload), api.appendJournalEntry('space-A', payload)])
  await api.appendJournalEntry('space-A', payload)
  assert.equal(rows.get('captures/journal-1').journalSupplements.length, 1)
  assert.equal(rows.get('captures/journal-1').version, 2)
})

test('same supplement ID with different text is rejected without replacing original input', async () => {
  const { api, rows } = seeded()
  await api.appendJournalEntry('space-A', { entryId: 'journal-1', content: '原有', supplementId: 'same' })
  await assert.rejects(api.appendJournalEntry('space-A', { entryId: 'journal-1', content: '不同', supplementId: 'same' }),
    { code: 'INPUT_ID_CONFLICT' })
  assert.deepEqual(rows.get('captures/journal-1').journalSupplements.map((item) => item.content), ['原有'])
})

test('the 51st supplement and a long Markdown supplement retain every character', async () => {
  const previous = Array.from({ length: 50 }, (_, index) => ({ id: 'old-' + index, content: '旧补充-' + index }))
  const { api, rows } = seeded(journal({ journalSupplements: previous }))
  const content = '  ## 长补充\n\n' + '中文🙂'.repeat(4000) + '\n结尾\n'
  await api.appendJournalEntry('space-A', { entryId: 'journal-1', content, supplementId: 'long' })
  const saved = rows.get('captures/journal-1')
  assert.equal(saved.journalSupplements.length, 51)
  assert.equal(saved.journalSupplements.at(-1).content, content)
  assert.ok(saved.markdown.includes(content))
  assert.ok(saved.markdown.includes('旧补充-0'))
})

test('mobile journal serializer preserves long raw input and desktop roundtrip fidelity', () => {
  const { api, desktop } = seeded()
  const content = '原文🙂\n'.repeat(5000)
  const entry = journal({ rawContent: content, content })
  const serialized = api.journalSyncEntry(entry)
  assert.equal(serialized.rawContent, content)
  assert.equal(serialized.content, content)
  assert.equal(desktop.sanitizeJournalDocument(entry).rawContent, content)
})

test('capture creation preserves long original, whitespace and replay identity', async () => {
  const { api, rows } = cloudRuntime()
  const content = '\n  原文 ' + '保留🙂'.repeat(4000) + '\n'
  const payload = { id: 'capture-long', content, source: 'manual' }
  await Promise.all([api.createCapture('space-A', payload), api.createCapture('space-A', payload)])
  assert.equal(rows.get('captures/capture-long').content, content)
  assert.equal(rows.get('captures/capture-long').version, 1)
  await assert.rejects(api.createCapture('space-A', { ...payload, content: 'different' }), { code: 'INPUT_ID_CONFLICT' })
  await assert.rejects(api.createCapture('space-B', payload), { code: 'FORBIDDEN' })
})

test('capacity failure is explicit and never acknowledges a truncated supplement', async () => {
  const { api, rows } = seeded()
  await assert.rejects(api.appendJournalEntry('space-A', {
    entryId: 'journal-1', content: '超长原文'.repeat(100000), supplementId: 'oversized'
  }), { code: 'RECORD_CAPACITY' })
  assert.equal(rows.get('captures/journal-1').journalSupplements.length, 0)
})

const principal = { userId: 'user-A', workspaceId: 'space-A', role: 'owner' }
function taskRuntime(hooks = {}) {
  const runtime = cloudRuntime([], hooks)
  runtime.rows.set('tasks/task-1', { id: 'task-1', title: 'Original', ownerOpenId: 'space-A',
    workspaceId: 'space-A', version: 1, deletedAt: '', steps: [] })
  return runtime
}
const taskPayload = { id: 'task-1', patch: { title: 'Changed' }, baseVersion: 1 }

test('concurrent duplicate task requests atomically share one durable receipt', async () => {
  const { api, rows, metrics } = taskRuntime()
  const results = await Promise.all([
    api.executeMutation('space-A', 'task.update', taskPayload, principal, 'same-request'),
    api.executeMutation('space-A', 'task.update', taskPayload, principal, 'same-request')
  ])
  assert.equal(rows.get('tasks/task-1').version, 2)
  assert.equal(results.filter((item) => item.replayed).length, 1)
  assert.deepEqual(results[0].data, results[1].data)
  assert.equal([...rows.keys()].filter((key) => key.startsWith('sync_state/operation_v2_')).length, 1)
  const writes = metrics.writes
  await api.executeMutation('space-A', 'task.update', taskPayload, principal, 'same-request')
  assert.equal(metrics.writes, writes)
  const receipt = await api.requestReplay('space-A', 'same-request', 'task.update', taskPayload, principal)
  assert.equal(receipt.result.version, 2)
})

test('failure while saving receipt rolls business record and sequence back together', async () => {
  let failReceipt = true
  const { api, rows } = taskRuntime({ beforeSet(name) {
    if (name === 'sync_state' && failReceipt) throw new Error('receipt storage unavailable')
  } })
  await assert.rejects(api.executeMutation('space-A', 'task.update', taskPayload, principal, 'receipt-retry'), /receipt storage/)
  assert.equal(rows.get('tasks/task-1').version, 1)
  assert.equal([...rows.keys()].filter((key) => key.startsWith('sync_signals/')).length, 0)
  failReceipt = false
  await api.executeMutation('space-A', 'task.update', taskPayload, principal, 'receipt-retry')
  assert.equal(rows.get('tasks/task-1').version, 2)
})

test('request identity binds actor, workspace, action and actual content', async () => {
  const { api, rows } = taskRuntime()
  await api.executeMutation('space-A', 'task.update', taskPayload, principal, 'same-request')
  await assert.rejects(api.executeMutation('space-A', 'task.update', { ...taskPayload, patch: { title: 'Other' } }, principal, 'same-request'), { code: 'INPUT_ID_CONFLICT' })
  await assert.rejects(api.executeMutation('space-A', 'task.archive', { id: 'task-1', baseVersion: 2 }, principal, 'same-request'), { code: 'INPUT_ID_CONFLICT' })
  assert.equal(await api.requestReplay('another-space-A', 'same-request', 'task.update', taskPayload, { ...principal, workspaceId: 'another-space-A' }), null)
  assert.equal(await api.requestReplay('space-A', 'same-request', 'task.update', taskPayload, { ...principal, userId: 'user-B' }), null)
  assert.equal(rows.get('tasks/task-1').title, 'Changed')
})

test('unverified foreign record and ownership patches cannot cross the workspace boundary', async () => {
  const { api, rows } = taskRuntime()
  const other = { ...principal, userId: 'user-B', workspaceId: 'space-B' }
  await assert.rejects(api.executeMutation('space-B', 'task.update', taskPayload, other, 'foreign'), { code: 'FORBIDDEN' })
  await assert.rejects(api.executeMutation('space-A', 'task.update', {
    ...taskPayload, patch: { ownerOpenId: 'space-B' }
  }, principal, 'move-owner'), { code: 'VALIDATION' })
  assert.equal(rows.get('tasks/task-1').version, 1)
})

test('batch checks every operation scope and does not truncate long request IDs', async () => {
  const { api, rows } = seeded()
  const prefix = 'request-'.repeat(30)
  const operations = ['A', 'B'].map((suffix) => ({
    action: 'journal.append', requestId: prefix + suffix, scope: { userId: 'user-A', workspaceId: 'space-A' },
    payload: { entryId: 'journal-1', content: suffix, baseVersion: 1 }
  }))
  operations.push({ action: 'journal.append', requestId: 'foreign',
    scope: { userId: 'user-B', workspaceId: 'space-B' }, payload: { entryId: 'journal-1', content: 'foreign' } })
  const result = await api.pushMutations('space-A', operations, principal)
  assert.deepEqual(result.results.map((item) => item.ok), [true, true, false])
  assert.equal(result.results[2].error.code, 'WORKSPACE_MISMATCH')
  assert.equal(result.results[0].requestId, prefix + 'A')
  assert.deepEqual(rows.get('captures/journal-1').journalSupplements.map((item) => item.content), ['A', 'B'])
  const repeated = await api.pushMutations('space-A', operations.slice(0, 2), principal)
  assert.equal(repeated.changed, false)
  assert.equal(rows.get('captures/journal-1').version, 3)
})

test('deleted records reject later generic edits and later supplement creation', async () => {
  const { api, rows } = seeded(journal({ deletedAt: '2026-09-25T00:00:00.000Z' }))
  await assert.rejects(api.updateDoc('captures', 'journal-1', { markdown: 'revived', deletedAt: '' }, 1), { code: 'RECORD_DELETED' })
  await assert.rejects(api.appendJournalEntry('space-A', { entryId: 'journal-1', content: 'new', supplementId: 'after-delete' }), { code: 'RECORD_DELETED' })
  assert.equal(rows.get('captures/journal-1').journalSupplements.length, 0)
})

test('a repeated delete acknowledges its saved receipt even after the record is no longer readable as active', async () => {
  const { api, rows, metrics } = seeded()
  const payload = { entryId: 'journal-1', baseVersion: 1 }
  const first = await api.executeMutation('space-A', 'journal.delete', payload, principal, 'delete-once')
  assert.ok(first.data.trashedAt)
  const writes = metrics.writes
  const second = await api.executeMutation('space-A', 'journal.delete', payload, principal, 'delete-once')
  assert.deepEqual(second.data, first.data)
  assert.equal(second.replayed, true)
  assert.equal(metrics.writes, writes)
  assert.equal(rows.get('captures/journal-1').version, 2)
})
