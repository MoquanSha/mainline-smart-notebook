const test = require('node:test'), assert = require('node:assert/strict')
const { cloudRuntime } = require('./helpers/cloud-runtime.cjs')
const { createOrganizationJobs } = require('../cloudfunctions/notebookApi/organization-job')
const fidelity = require('../cloudfunctions/notebookApi/fidelity')
async function failed() {
  const runtime = cloudRuntime(), jobs = createOrganizationJobs(runtime)
  const input = { owner: 'owner', targetId: 'entry', kind: 'journal_entry', promptVersion: 'review-test',
    parts: [{ content: '第一段。' }, { content: '没有支付123元。' }, { content: '还没整理到。' }], maxParts: 32,
    generate: async (part, i) => { const content = i === 1 ? '支付132元。' : part.content; fidelity.assertFidelity(part.content, content); return { content } } }
  const result = await jobs.run(input)
  return { ...runtime, jobs, input, job: result.job, query: { owner: 'owner', targetId: 'entry', kind: 'journal_entry', jobId: result.job.id } }
}
test('review pages return immutable original/candidate snapshots only on explicit read, without writes or model calls', async () => {
  const r = await failed(), before = { ...r.metrics }
  const first = await r.jobs.reviewPage({ ...r.query, index: 0 })
  assert.equal(first.original, '第一段。'); assert.equal(first.candidate, '第一段。')
  assert.equal(first.availableParts, 2); assert.equal(first.totalParts, 3)
  const second = await r.jobs.reviewPage({ ...r.query, index: 1, expectedReviewId: first.reviewId })
  assert.equal(second.original, '没有支付123元。'); assert.equal(second.candidate, '支付132元。')
  assert.equal(second.findings.some((finding) => finding.kind === 'number'), true)
  assert.equal(r.metrics.writes, before.writes); assert.equal(r.metrics.transactions, before.transactions)
  assert.equal(r.metrics.reads - before.reads, 5)
  assert.equal(JSON.stringify(second).includes('leaseToken'), false)
})
test('review pages reject foreign owners, wrong target/type, unavailable parts and replaced review sessions', async () => {
  const r = await failed()
  for (const patch of [{ owner: 'other' }, { targetId: 'other' }, { kind: 'daily_diary' }]) {
    await assert.rejects(r.jobs.reviewPage({ ...r.query, ...patch }), { code: 'FORBIDDEN' })
  }
  for (const index of [-1, 1.5, 2, NaN]) await assert.rejects(r.jobs.reviewPage({ ...r.query, index }), { code: 'VALIDATION' })
  await assert.rejects(r.jobs.reviewPage({ ...r.query, expectedReviewId: 'old' }), { code: 'REVIEW_CHANGED' })
  await r.jobs.run({ ...r.input, retry: true, generate: async (part) => ({ content: part.content }) })
  await assert.rejects(r.jobs.reviewPage(r.query), { code: 'REVIEW_UNAVAILABLE' })
  assert.equal([...r.rows.values()].filter((row) => row.taskType === 'organization_review').length, 1)
})
test('cloud review dispatcher checks active record ownership and refuses deleted records before revealing candidates', async () => {
  const runtime = cloudRuntime([], { generateText: async () => ({ text: JSON.stringify({ markdown: '支付132元。', title: '记录', items: [] }) }) })
  await runtime.api.createJournalEntry('owner', { id: 'entry', content: '没有支付123元。', deferOrganization: true })
  const result = await runtime.api.organizeJournalStep('owner', { entryId: 'entry' })
  assert.equal(result.organizationJob.reviewHost, 'cloud')
  const page = await runtime.api.organizationReview('owner', { kind: 'journal_entry', entryId: 'entry' })
  assert.equal(page.original, '没有支付123元。')
  await assert.rejects(runtime.api.organizationReview('other', { kind: 'journal_entry', entryId: 'entry' }))
  runtime.rows.get('captures/entry').deletedAt = new Date().toISOString()
  await assert.rejects(runtime.api.organizationReview('owner', { kind: 'journal_entry', entryId: 'entry' }))
})

test('diary review is restored with the saved day and explicit failed retry replaces its review pointer', async () => {
  const runtime = cloudRuntime([], { generateText: async () => ({ text: JSON.stringify({ summary: '## 今日记录\n\n支付132元。' }) }) })
  const date = '2026-09-25'
  await runtime.api.appendDailyDiary('owner', { date, inputId: 'original', content: '没有支付123元。' })
  const first = await runtime.api.refreshDailyDiary('owner', { date })
  assert.equal(first.day.organizationJob.reviewId, first.organizationJob.reviewId)
  const page = await runtime.reload().organizationReview('owner', { kind: 'daily_diary', date })
  assert.equal(page.original, '没有支付123元。'); assert.equal(page.candidate, '## 今日记录\n\n支付132元。')
  const second = await runtime.api.refreshDailyDiary('owner', { date })
  assert.notEqual(second.organizationJob.reviewId, first.organizationJob.reviewId)
  assert.equal(second.day.organizationJob.reviewId, second.organizationJob.reviewId)
  await assert.rejects(runtime.api.organizationReview('owner', { kind: 'daily_diary', date, expectedReviewId: page.reviewId }), { code: 'REVIEW_CHANGED' })
})
