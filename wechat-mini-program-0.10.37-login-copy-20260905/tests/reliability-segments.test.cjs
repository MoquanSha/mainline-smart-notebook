const test = require('node:test')
const assert = require('node:assert/strict')
const { cloudRuntime } = require('./helpers/cloud-runtime.cjs')
const fs = require('node:fs')
const path = require('node:path')
const segments = require('../cloudfunctions/notebookApi/text-segments')
const { createOrganizationJobs } = require('../cloudfunctions/notebookApi/organization-job')
const fidelity = require('../cloudfunctions/notebookApi/fidelity')
for (const [name, raw] of [
  ['amount', '甲'.repeat(2998) + '123.45元。'],
  ['uncertain', '甲'.repeat(2999) + '不确定。'],
  ['fence', '说明。\n\n```js\n' + 'const amount = 123.45; // 没有付款\n'.repeat(220) + '```\n\n结尾可能会调整。']
]) {
  test(`cloud ${name} survives echo organization without artificial seams in journal and diary`, async () => {
    const runtime = cloudRuntime([], { generateText: async ({ messages }) => {
      const input = JSON.parse(messages[1].content)
      return { text: JSON.stringify(input.manualInputs ? { summary: '## 今日记录\n\n' + input.manualInputs[0].content }
        : { title: '原文', markdown: input.content, items: [] }) }
    } })
    await runtime.api.createJournalEntry('owner', { id: name, content: raw, deferOrganization: true })
    const journal = await runtime.api.organizeJournalStep('owner', { entryId: name }, { maxParts: 32 })
    assert.equal(journal.entry.organizedContent, raw)
    await runtime.api.appendDailyDiary('owner', { date: '2026-09-25', inputId: name, content: raw })
    const diary = await runtime.api.refreshDailyDiary('owner', { date: '2026-09-25' }, { maxParts: 32 })
    assert.equal(diary.day.summary, '## 今日记录\n\n' + raw)
  })
}

test('desktop/cloud segmentation and vendored Markdown source are identical', () => {
  for (const file of ['text-segments.js', 'vendor/markdown-it.js', 'vendor/markdown-it.LICENSE', 'vendor/markdown-it.provenance.json']) {
    assert.deepEqual(fs.readFileSync(path.join(__dirname, '../cloudfunctions/notebookApi', file)),
      fs.readFileSync(path.join(__dirname, '../../personal-task-workbench-4320-wechat-login-test/shared', file)))
  }
})

test('amounts, qualifier phrases and joined emoji remain intact at boundaries; no original code units are dropped', () => {
  for (const ending of ['123.45元。', '不确定。', '可能明天。', '👩‍👩‍👧‍👦完成。', 'e\u0301记录。', '-12.50%']) {
    const raw = '甲'.repeat(2999) + ending
    const parts = segments.splitText(raw)
    assert.equal(parts.map((part) => part.content).join(''), raw)
    const token = ending.startsWith('👩') ? '👩‍👩‍👧‍👦' : ending.startsWith('e\u0301') ? 'e\u0301' : ending
    assert.ok(parts.some((part) => part.content.includes(token)))
    assert.equal(segments.joinText(parts, parts.map((part) => part.content)), raw)
  }
})

test('fenced code, nested fenced code and tables keep exact whitespace without model calls', async () => {
  for (const raw of [
    '```md\r\n' + '## 今日补充\r\n  123.45 没有支付\r\n'.repeat(160) + '```\r\n',
    '> ```js\n' + '> const amount = 123.45;\n'.repeat(180) + '> ```\n',
    '| 费用 | 状态 |\n| --- | --- |\n' + '| 123.45 | 没有支付 |\n'.repeat(240)
  ]) {
    const runtime = cloudRuntime([], { generateText: async () => { throw new Error('literal syntax must not invoke the model') } })
    await runtime.api.createJournalEntry('owner', { id: 'literal', content: raw, deferOrganization: true })
    const result = await runtime.api.organizeJournalStep('owner', { entryId: 'literal' }, { maxParts: 32 })
    assert.equal(result.organizationJob.status, 'complete')
    assert.equal(result.entry.organizedContent, raw)
    assert.equal(result.entry.organizedBy, 'rules')
    await runtime.api.appendDailyDiary('another-owner', { date: '2026-09-25', inputId: 'literal', content: raw })
    const diary = await runtime.api.refreshDailyDiary('another-owner', { date: '2026-09-25' }, { maxParts: 32 })
    assert.equal(diary.organizationJob.status, 'complete')
    assert.equal(diary.day.summary, '## 今日记录\n\n' + raw)
    assert.equal(diary.quota.aiCalls, 0)
  }
})

test('literal-only diary still appends task facts once, and multiple user inputs keep their own boundaries', async () => {
  const raw = '```js\n' + 'const x = 12;\n'.repeat(260) + '```\n'
  let calls = 0
  const runtime = cloudRuntime([], { generateText: async ({ messages }) => {
    calls++
    const context = JSON.parse(messages[1].content)
    assert.equal(context.manualInputs.length, 0)
    return { text: JSON.stringify({ summary: '## 今日记录\n\n## 今日补充\n\n完成2条待办。' }) }
  } })
  const date = '2026-09-25'
  runtime.rows.set('daily_tasks/fact', { id: 'fact', ownerOpenId: 'owner', date, entryKind: 'today_todo', deletedAt: '', status: 'done', title: '任务', completedAt: date + 'T01:00:00Z', updatedAt: date + 'T01:00:00Z' })
  await runtime.api.appendDailyDiary('owner', { date, inputId: 'literal', content: raw })
  const result = await runtime.api.refreshDailyDiary('owner', { date }, { maxParts: 32 })
  assert.equal(calls, 1)
  assert.equal(result.day.summary, '## 今日记录\n\n' + raw + '\n\n## 今日补充\n\n完成2条待办。')
  const inputs = [{ id: 'a', content: '甲'.repeat(3100) }, { id: 'b', content: '第二条原文，不确定。' }]
  const fragments = segments.splitInputs(inputs).map((part) => ({ manualInputs: [part] }))
  assert.equal(segments.joinDiary(fragments, fragments.map((part) => '## 今日记录\n\n' + part.manualInputs[0].content)),
    '## 今日记录\n\n' + inputs.map((part) => part.content).join('\n\n'))
})

test('an assembly-only fidelity failure cannot commit a final receipt; explicit retry starts a new generation and preserves the review', async () => {
  const raw = '甲'.repeat(2999) + '。2元'
  let safe = false, calls = 0
  const runtime = cloudRuntime([], { generateText: async ({ messages }) => {
    calls++
    const part = JSON.parse(messages[1].content)
    return { text: JSON.stringify({ title: '原文', markdown: part.content + (!safe && part.index === 0 ? '\n\n1. ' : ''), items: [] }) }
  } })
  await runtime.api.createJournalEntry('owner', { id: 'seam', content: raw, deferOrganization: true })
  const failed = await runtime.api.organizeJournalStep('owner', { entryId: 'seam' }, { maxParts: 32 })
  assert.equal(failed.organizationJob.status, 'failed'); assert.equal(failed.organizationJob.automaticRetry, false)
  assert.equal(failed.entry.rawContent, raw)
  const manifest = runtime.rows.get('ai_runs/' + failed.organizationJob.id)
  assert.equal(manifest.failureStage, 'assembly'); assert.equal(manifest.completed, 1)
  assert.equal(manifest.fidelityReview.checkedScope, 'assembled')
  assert.equal(runtime.rows.has('ai_runs/' + manifest.id + '_part_1'), false)
  const reviews = [...runtime.rows.values()].filter((row) => row.taskType === 'organization_review')
  assert.equal(reviews.length, 1); assert.equal(reviews[0].review.candidate, '2元')
  await runtime.reload().organizeJournalStep('owner', { entryId: 'seam' })
  assert.equal(calls, 2)
  safe = true
  const retried = await runtime.api.organizeJournalStep('owner', { entryId: 'seam', retry: true }, { maxParts: 32 })
  assert.equal(retried.organizationJob.status, 'complete'); assert.equal(retried.organizationJob.generation, 1)
  assert.equal(calls, 4); assert.equal(retried.entry.organizedContent, raw)
  assert.ok(runtime.rows.has('ai_runs/' + manifest.id + '_part_0'))
  assert.ok(runtime.rows.has('ai_runs/' + manifest.id + '_g_1_part_0'))
  assert.equal([...runtime.rows.values()].filter((row) => row.taskType === 'organization_review').length, 1)
})

test('assembled checks allow large originals and store only a bounded final candidate plus receipt references', async () => {
  const raw = '原文。'.repeat(22000) + '没有完成123元。'
  assert.equal(fidelity.assertFidelity(raw, raw, { aggregate: true, candidateForReview: '最后一段' }).status, 'markers_unchanged')
  const runtime = cloudRuntime()
  const jobs = createOrganizationJobs(runtime)
  const result = await jobs.run({ owner: 'owner', targetId: 'literal', kind: 'journal', promptVersion: segments.POLICY,
    parts: [{ content: '123', literal: true }], countsAsAiCall: (part) => !part.literal,
    generate: async (part) => part.content, validateOutput: (outputs) => assert.equal(outputs[0], '123') })
  assert.equal(result.aiCalls, 0)
})
