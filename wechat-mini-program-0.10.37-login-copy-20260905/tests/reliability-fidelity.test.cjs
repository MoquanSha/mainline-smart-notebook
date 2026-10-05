const test = require('node:test')
const assert = require('node:assert/strict')
const { cloudRuntime } = require('./helpers/cloud-runtime.cjs')
const { journalBody } = require('../miniprogram/utils/markdown')
const examples = [
  ['number', '申请费是 123.45 元。', '申请费是 132.45 元。'],
  ['negation', '我没有完成申请。', '我完成了申请。'],
  ['uncertainty', '我可能会报名，时间尚不确定。', '我会报名，时间已经确定。']
]
for (const [kind, raw, changed] of examples) {
  test(`cloud journal pauses changed ${kind}; server blocks automatic replay even from an older client`, async () => {
    let calls = 0, output = changed
    const runtime = cloudRuntime([], { generateText: async () => { calls++; return { text: JSON.stringify({ title: '原文', markdown: output, items: [] }) } } })
    await runtime.api.createJournalEntry('owner', { id: kind, content: raw, deferOrganization: true })
    const result = await runtime.api.organizeJournalStep('owner', { entryId: kind })
    assert.equal(result.organizationJob.status, 'failed')
    assert.equal(result.organizationJob.automaticRetry, false)
    assert.equal(result.entry.rawContent, raw); assert.equal(journalBody(result.entry), raw)
    await runtime.reload().organizeJournalStep('owner', { entryId: kind })
    assert.equal(calls, 1)
    output = '**' + raw + '**'
    const retried = await runtime.api.organizeJournalStep('owner', { entryId: kind, retry: true })
    assert.equal(calls, 2); assert.equal(retried.organizationJob.status, 'complete')
  })
  test(`cloud diary detects changed ${kind}, keeps the original and refuses automatic repeat`, async () => {
    let calls = 0
    const runtime = cloudRuntime([], { generateText: async () => { calls++; return { text: JSON.stringify({ summary: '## 今日记录\n\n' + changed + '\n\n## 今日补充\n\n' + raw }) } } })
    await runtime.api.appendDailyDiary('owner', { date: '2026-09-25', inputId: kind, content: raw })
    const result = await runtime.api.refreshDailyDiary('owner', { date: '2026-09-25' }, { retry: false })
    assert.equal(result.organizationJob.status, 'failed'); assert.equal(result.organizationJob.automaticRetry, false)
    assert.equal(result.day.manualInputs[0].content, raw)
    assert.ok(!result.day.summary.includes(changed))
    await runtime.api.refreshDailyDiary('owner', { date: '2026-09-25' }, { retry: false })
    assert.equal(calls, 1)
  })
}
