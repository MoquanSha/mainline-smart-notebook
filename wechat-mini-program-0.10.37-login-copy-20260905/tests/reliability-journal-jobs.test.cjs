const test = require('node:test')
const assert = require('node:assert/strict')
const { cloudRuntime } = require('./helpers/cloud-runtime.cjs')
const owner = 'space-A'
const principal = { userId: 'user-A', workspaceId: owner }
const payload = { id: 'journal-job', content: '  原文可能并没有完成，预算 123.45 元。\n', source: 'manual', favorite: true, deferOrganization: true }
const answer = (content) => ({ text: JSON.stringify({ title: '申请记录', summary: content, markdown: content, type: 'note', items: [] }) })

test('deferred journal creation confirms the complete original and favorite without invoking AI', async () => {
  let calls = 0
  const { api, rows } = cloudRuntime([], { generateText: async () => { calls++; return answer('整理稿') } })
  const result = await api.executeMutation(owner, 'journal.create', payload, principal, 'create-1')
  assert.equal(calls, 0)
  assert.equal(result.data.rawContent, payload.content)
  assert.equal(rows.get('captures/' + payload.id).content, payload.content)
  assert.ok(result.data.favoritedAt)
  assert.equal(result.data.organizationStatus, 'pending')
});

test('cloud serializer retains desktop organization ownership and a direct cloud retry cannot duplicate the worker', async () => {
  let calls = 0
  const runtime = cloudRuntime([], { generateText: async () => { calls++; return answer('must not run') } })
  await runtime.api.createJournalEntry(owner, payload)
  runtime.rows.get('captures/' + payload.id).organizationHost = 'desktop'
  await assert.rejects(runtime.api.organizeJournalStep(owner, { entryId: payload.id, retry: true }), { code: 'ORGANIZATION_DESKTOP' })
  assert.equal(calls, 0)
  const row = runtime.rows.get('captures/' + payload.id)
  assert.equal(row.rawContent, payload.content)
})

test('creation and replay receipt commit together, including concurrent identical requests', async () => {
  const { api, rows, metrics } = cloudRuntime()
  await Promise.all([api.executeMutation(owner, 'journal.create', payload, principal, 'same'), api.executeMutation(owner, 'journal.create', payload, principal, 'same')])
  assert.equal(rows.get('captures/' + payload.id).version, 1)
  const writes = metrics.writes
  const replay = await api.executeMutation(owner, 'journal.create', payload, principal, 'same')
  assert.equal(replay.replayed, true)
  assert.equal(metrics.writes, writes)
})

test('long Unicode journal resumes after runtime replacement and reuses completed receipts', async () => {
  const sent = []
  const runtime = cloudRuntime([], { generateText: async ({ messages }) => { const part = JSON.parse(messages[1].content); sent.push(part.content); return answer(part.content) } })
  const content = '🙂甲'.repeat(3200) + '原文结尾，不确定。'
  await runtime.api.createJournalEntry(owner, { ...payload, content })
  let result = await runtime.api.organizeJournalStep(owner, { entryId: payload.id })
  assert.equal(result.organizationJob.completed, 1)
  result = await runtime.reload().organizeJournalStep(owner, { entryId: payload.id })
  result = await runtime.reload().organizeJournalStep(owner, { entryId: payload.id })
  assert.equal(result.organizationJob.status, 'complete')
  assert.equal(sent.join(''), content)
  assert.ok(result.entry.markdown.endsWith('原文结尾，不确定。'))
  const count = sent.length, writes = runtime.metrics.writes
  await runtime.api.organizeJournalStep(owner, { entryId: payload.id })
  assert.equal(sent.length, count)
  assert.equal(runtime.metrics.writes, writes)
})

test('concurrent journal steps do not duplicate a model call, metadata and supplements survive completion', async () => {
  let calls = 0, enter, release, armed = false
  const started = new Promise((resolve) => { enter = resolve }), waiting = new Promise((resolve) => { release = resolve })
  const runtime = cloudRuntime([], { generateText: async () => { calls++; if (armed) { enter(); await waiting }; return answer('**' + payload.content.trim() + '**') } })
  await runtime.api.createJournalEntry(owner, payload)
  armed = true
  const pending = runtime.api.organizeJournalStep(owner, { entryId: payload.id })
  await started
  const busy = await runtime.reload().organizeJournalStep(owner, { entryId: payload.id })
  assert.equal(busy.organizationJob.status, 'running')
  await runtime.api.appendJournalEntry(owner, { entryId: payload.id, supplementId: 'note-1', content: '后加补充' })
  release()
  const complete = await pending
  assert.equal(calls, 1)
  assert.equal(complete.organizationJob.status, 'complete')
  assert.equal(complete.entry.journalSupplements[0].content, '后加补充')
  assert.ok(complete.entry.markdown.includes('后加补充'))
  assert.ok(complete.entry.favoritedAt)
})

test('deleted or changed source cannot be overwritten by late journal organization', async () => {
  for (const edit of [{ deletedAt: '2026-09-25T00:00:00Z' }, { rawContent: '新的原文', content: '新的原文' }]) {
    let enter, release, armed = false
    const started = new Promise((resolve) => { enter = resolve }), waiting = new Promise((resolve) => { release = resolve })
    const candidate = '**' + payload.content.trim() + '**'
    const runtime = cloudRuntime([], { generateText: async () => { if (armed) { enter(); await waiting }; return answer(candidate) } })
    await runtime.api.createJournalEntry(owner, payload)
    armed = true
    const pending = runtime.api.organizeJournalStep(owner, { entryId: payload.id })
    await started
    Object.assign(runtime.rows.get('captures/' + payload.id), edit)
    release()
    const result = await pending
    assert.equal(result.stale, true)
    assert.equal(result.changed, false)
    assert.notEqual(runtime.rows.get('captures/' + payload.id).organizedContent, candidate)
  }
})

test('a model error keeps the original and bounded retry resumes without recreating the record', async () => {
  let calls = 0
  const runtime = cloudRuntime([], { generateText: async () => { if (++calls === 1) throw new Error('provider unavailable'); return answer('**' + payload.content.trim() + '**') } })
  await runtime.api.createJournalEntry(owner, payload)
  const failed = await runtime.api.organizeJournalStep(owner, { entryId: payload.id })
  assert.equal(failed.entry.organizationStatus, 'failed')
  assert.equal(failed.entry.rawContent, payload.content)
  await runtime.api.organizeJournalStep(owner, { entryId: payload.id })
  assert.equal(calls, 1)
  const result = await runtime.api.organizeJournalStep(owner, { entryId: payload.id, retry: true })
  assert.equal(result.entry.organizationStatus, 'organized')
  assert.equal(calls, 2)
})

test('checking a generated item preserves full Markdown, supplements and code examples', async () => {
  const body = '# 申请\r\n\r\n可能需要联系，尚未承诺。\r\n\r\n- [ ] 发邮件\r\n\r\n```md\r\n- [ ] 发邮件\r\n```\r\n\r\n' + '原文细节。'.repeat(2600) + '\r\n结尾预算 123.45 元。'
  const runtime = cloudRuntime([], { generateText: async () => ({ text: JSON.stringify({ title: '申请', summary: '摘要',
    markdown: body, type: 'checklist', items: [{ text: '发邮件', done: false }] }) }) })
  await runtime.api.createJournalEntry(owner, payload)
  const organized = await runtime.api.organizeJournalStep(owner, { entryId: payload.id })
  await runtime.api.appendJournalEntry(owner, { entryId: payload.id, supplementId: 'later', content: '新的补充' })
  const toggled = await runtime.api.toggleJournalItem(owner, { entryId: payload.id, itemId: organized.entry.checklistItems[0].id, done: true })
  const expected = body.replace('- [ ] 发邮件', '- [x] 发邮件')
  assert.equal(toggled.markdown, expected + '\n\n### 补充\n\n- 新的补充')
  assert.equal(toggled.organizedContent, expected)
  assert.equal(toggled.rawContent, payload.content)
})

test('completed job replay cannot undo subsequent checklist or manual body edits', async () => {
  let calls = 0
  const runtime = cloudRuntime([], { generateText: async () => { calls++; return { text: JSON.stringify({ title: '申请',
    summary: '摘要', markdown: payload.content + '\n\n- [ ] 发邮件', type: 'checklist', items: ['发邮件'] }) } } })
  await runtime.api.createJournalEntry(owner, payload)
  const first = await runtime.api.organizeJournalStep(owner, { entryId: payload.id })
  await runtime.api.toggleJournalItem(owner, { entryId: payload.id, itemId: first.entry.checklistItems[0].id, done: true })
  const stored = runtime.rows.get('captures/' + payload.id)
  stored.markdown += '\n\n用户手动修订的正文'
  const before = structuredClone(stored), writes = runtime.metrics.writes
  await runtime.reload().organizeJournalStep(owner, { entryId: payload.id, retry: true })
  assert.deepEqual(runtime.rows.get('captures/' + payload.id), before)
  assert.equal(calls, 1)
  assert.equal(runtime.metrics.writes, writes)
})

test('creation receipt failure rolls back the original and a retry can safely create it', async () => {
  let fail = true
  const runtime = cloudRuntime([], { beforeSet: (_collection, id) => {
    if (fail && String(id).startsWith('operation_v2_')) throw new Error('receipt storage failed')
  } })
  await assert.rejects(runtime.api.executeMutation(owner, 'journal.create', payload, principal, 'rollback'), /receipt storage failed/)
  assert.equal(runtime.rows.has('captures/' + payload.id), false)
  fail = false
  await runtime.api.executeMutation(owner, 'journal.create', payload, principal, 'rollback')
  assert.equal(runtime.rows.get('captures/' + payload.id).rawContent, payload.content)
})

test('foreign workspace and invalid model output cannot replace or expose an original', async () => {
  let calls = 0
  const runtime = cloudRuntime([], { generateText: async () => { calls++; return { text: JSON.stringify({ summary: '仅有摘要' }) } } })
  await runtime.api.createJournalEntry(owner, payload)
  await assert.rejects(runtime.api.organizeJournalStep('space-B', { entryId: payload.id }), { code: 'NOT_FOUND' })
  assert.equal(calls, 0)
  const failed = await runtime.api.organizeJournalStep(owner, { entryId: payload.id })
  assert.equal(failed.entry.organizationStatus, 'failed')
  assert.equal(failed.entry.rawContent, payload.content)
  assert.equal(failed.entry.markdown, payload.content)
  assert.match(failed.entry.aiError, /Markdown/)
})
