const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const fidelity = require('../cloudfunctions/notebookApi/fidelity')
const { createOrganizationJobs } = require('../cloudfunctions/notebookApi/organization-job')
const { cloudRuntime } = require('./helpers/cloud-runtime.cjs')

test('desktop and cloud use the same checked policy source', () => {
  assert.equal(fs.readFileSync(path.join(__dirname, '../cloudfunctions/notebookApi/fidelity.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '../../personal-task-workbench-4320-wechat-login-test/ai/fidelity.cjs'), 'utf8'))
})

test('formatting, list ordinals, decimal grouping, dates and ordinary Chinese number notation preserve markers', () => {
  for (const [original, output] of [
    ['预算 1234.50 元。没有付款。可能下周完成，时间不确定。', '# 申请\n\n1. 预算 **1,234.5** 元。\n2. 尚未付款。也许下周完成，时间待确认。'],
    ['2026-09-05 有两份材料，费用十二万元。', '- [ ] 2026年9月5日有 2 份材料，费用 120000 元。'],
    ['记录值为 -3.50，比例为 25%。', '记录值为 **-3.5**，比例为 ２５％。'],
    ['规模一万亿元。', '规模 1000000000000 元。'],
    ['I might apply. I am not sure. I have not paid 20 dollars.', 'I may apply. I am uncertain. I have not paid **20** dollars.'],
    ['不仅有收获，不过还需检查。', '有收获，还需检查。']
  ]) assert.equal(fidelity.assertFidelity(original, output).status, 'markers_unchanged', original)
})

test('removed, inserted, sign/percent and multiplicity changes are reviewable; candidates are kept exactly', () => {
  for (const [original, output, kind] of [
    ['费用123元', '费用132元', 'number'], ['费用123元', '费用不详', 'number'],
    ['分别是12元和12元', '只有12元', 'number'], ['比例20%', '比例20', 'number'], ['差额-12元', '差额12元', 'number'],
    ['我并没有报名', '我报名了', 'negation'], ['我报名了', '我没有报名', 'negation'],
    ['我不会报名', '我会报名', 'negation'], ['I did not apply', 'I did apply', 'negation'],
    ['我可能会去', '我会去', 'uncertainty'], ['仍待核实', '已经核实', 'unconfirmed']
  ]) {
    assert.throws(() => fidelity.assertFidelity(original, output), (error) => {
      assert.equal(error.code, 'AI_FIDELITY_REVIEW')
      assert.equal(error.fidelityReview.candidate, output)
      assert.ok(error.fidelityReview.findings.some((item) => item.kind === kind))
      return true
    })
  }
})

test('diary supplements cannot mask meaning changes; literal headings inside fenced code stay in the body', () => {
  const raw = '没有付款123元。'
  const candidate = '## 今日记录\n付款了。\n## 今日补充\n' + raw
  assert.throws(() => fidelity.assertDiaryFidelity([{ content: raw }], candidate), (error) => {
    assert.equal(error.fidelityReview.candidate, candidate)
    assert.equal(error.fidelityReview.checkedScope, 'diary_body')
    return error.code === 'AI_FIDELITY_REVIEW'
  })
  const code = '~~~text\n## 今日补充\n没有付款123元。\n~~~'
  assert.equal(fidelity.assertDiaryFidelity([{ content: code }], '## 今日记录\n' + code + '\n## 今日补充\n完成2条待办').status, 'markers_unchanged')
  assert.equal(fidelity.assertDiaryFidelity([], '## 今日记录\n暂无输入\n## 今日补充\n完成2条待办').status, 'no_original')
})

test('guard states its boundary: unchanged marker counts do not certify subject, amount association or invented causes', () => {
  for (const [raw, changed] of [
    ['甲交了10元，乙交了20元', '甲交了20元，乙交了10元'],
    ['我没有报名，朋友报名了', '我报名了，朋友没有报名'],
    ['今天很累', '今天因为生病很累']
  ]) assert.equal(fidelity.inspectFidelity(raw, changed).status, 'markers_unchanged')
})

test('review payload has bounded diagnostics and excessive output fails without clipping', () => {
  const raw = Array.from({ length: 300 }, (_, i) => String(i)).join(' ')
  assert.throws(() => fidelity.assertFidelity(raw, '全部删除'), (error) => {
    assert.equal(error.fidelityReview.findings[0].changeCount, 300)
    assert.equal(error.fidelityReview.findings[0].changes.length, 64)
    return true
  })
  assert.throws(() => fidelity.assertFidelity('原文', '甲'.repeat(60000)), { code: 'AI_OUTPUT_CAPACITY' })
})

test('manual pause persists past cooldown and process replacement, retains completed segments, and is scoped to the exact input', async () => {
  const runtime = cloudRuntime()
  let now = 1000, calls = 0
  const create = () => createOrganizationJobs({ db: runtime.db, now: () => now })
  const input = { owner: 'a', targetId: 'record', kind: 'journal', promptVersion: fidelity.POLICY, parts: ['已有段落', '没有支付123元'] }
  const first = await create().run({ ...input, generate: async (part) => { calls++; return part } })
  assert.equal(first.job.completed, 1)
  const failed = await create().run({ ...input, generate: async (part) => { calls++; fidelity.assertFidelity(part, '支付132元') } })
  assert.equal(failed.job.automaticRetry, false)
  assert.equal(failed.job.fidelityReview.partIndex, 1)
  assert.ok(failed.job.fidelityReview.inputHash)
  assert.equal(failed.job.fidelityReview.candidate, '支付132元')
  const writes = runtime.metrics.writes
  now += 24 * 60 * 60 * 1000
  await create().run({ ...input, generate: async () => { throw new Error('automatic retry must not start') } })
  assert.equal(runtime.metrics.writes, writes)
  assert.equal(calls, 2)
  const other = await create().run({ ...input, owner: 'b', generate: async (part) => part })
  assert.notEqual(other.job.id, failed.job.id)
  const changed = await create().run({ ...input, parts: ['新原文'], generate: async (part) => part })
  assert.equal(changed.job.status, 'complete')
  const recovered = await create().run({ ...input, retry: true, generate: async (part) => { calls++; fidelity.assertFidelity(part, '**' + part + '**'); return '**' + part + '**' } })
  assert.deepEqual(recovered.outputs, ['已有段落', '**没有支付123元**'])
  assert.equal(calls, 3)
  assert.equal(recovered.job.automaticRetry, true)
})
