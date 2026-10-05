const test = require('node:test')
const assert = require('node:assert/strict')
const { loadClient } = require('./helpers/client.cjs')
const cloud = require('../cloudfunctions/notebookApi/index.js').__test

test('长输入在手机拆分、云端拆分和待办载荷中保留完整尾部', () => {
  const client = loadClient(() => { throw new Error('长输入回归不应调用云端') })
  // No punctuation keeps this as one logical item while exercising the old
  // 4000-character truncation boundary with non-ASCII text.
  const content = `今天记录 ${'中文🙂'.repeat(1800)} 结尾保留标记-raw-tail-20260925`
  const miniItems = client.api.splitTodayTodoInput(content)
  const cloudItems = cloud.splitTodayTodoInput(content)

  assert.deepEqual(miniItems, cloudItems)
  assert.equal(miniItems.length, 1)
  assert.equal(miniItems[0].raw, content)
  assert.match(miniItems[0].raw, /结尾保留标记-raw-tail-20260925$/)
  assert.equal(client.api.prepareTodayTodoPayload(content).content, content)
})

test('评论原文入口不再静默截断', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'cloudfunctions', 'notebookApi', 'index.js'),
    'utf8'
  )
  assert.doesNotMatch(source, /String\(payload\.content \|\| ''\)\.trim\(\)\.slice\(0, 5000\)/)
})
