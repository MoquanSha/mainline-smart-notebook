const test = require('node:test')
const assert = require('node:assert/strict')
const { parseSequentialChain, localOrganize, chooseToday, reviewDecision } = require('../cloudfunctions/notebookApi/planning')

test('连续活动链按首尾时间连接并标记估算', () => {
  const events = parseSequentialChain('今天一点有剧本杀，要持续三四个小时，之后吃饭，吃完饭之后去 KTV', new Date('2026-08-01T09:00:00+08:00'), 'capture_1')
  assert.equal(events.length, 3)
  assert.equal(events[0].eventTime, '13:00')
  assert.equal(events[0].eventEndTime, '16:30')
  assert.equal(events[1].eventTime, '16:30')
  assert.equal(events[2].eventTime, '17:30')
  assert.equal(events.every((item) => item.needsConfirmation), true)
})

test('规则整理把连续活动输出为 calendar_event 而不是任务原句', () => {
  const result = localOrganize({ id: 'capture_1', occurredAt: '2026-08-01T09:00:00+08:00', content: '今天一点剧本杀三四个小时，之后吃饭，吃完去KTV' }, [])
  assert.equal(result.actions.length, 3)
  assert.equal(result.actions.every((item) => item.type === 'calendar_event'), true)
})

test('产品修改和提问不会进入待确认', () => {
  const capture = { source: 'codex', content: '你把网页的时间线隐藏掉，再改一下按钮，可以吗？' }
  const decision = reviewDecision({
    type: 'task_create', title: '隐藏网页时间线', detail: capture.content,
    confidence: 0.9, usefulness: 0.9, nextAction: '修改页面'
  }, capture)
  assert.equal(decision.suggestedHandling, 'ignore')
  assert.equal(decision.needsConfirmation, false)
})

test('明确的个人长期行动才进入待确认，决定自动记录', () => {
  const capture = { source: 'manual', content: '我这周要完成研究申请材料，并核对提交要求' }
  const task = reviewDecision({
    type: 'task_create', title: '完成研究申请材料', detail: capture.content,
    confidence: 0.9, nextAction: '核对提交要求'
  }, capture)
  assert.equal(task.suggestedHandling, 'ask_user')
  assert.ok(task.usefulness >= 0.65)
  const fact = reviewDecision({ type: 'decision', title: '采用新版清单', detail: '已经决定采用新版清单', confidence: 0.9 }, { source: 'manual', content: '已经决定采用新版清单' })
  assert.equal(fact.suggestedHandling, 'record_only')
})

test('重新规划保留过去、固定、完成和移出今天的时间块', () => {
  const now = new Date('2026-08-01T14:00:00+08:00')
  const sessions = [
    { id: 'past', taskId: 'a', title: '过去', startMinutes: 600, durationMinutes: 30, owner: 'me', status: 'planned' },
    { id: 'fixed', taskId: 'b', title: '固定', startMinutes: 900, durationMinutes: 60, owner: 'me', status: 'planned', fixed: true },
    { id: 'done', taskId: 'c', title: '完成', startMinutes: 960, durationMinutes: 30, owner: 'me', status: 'done' },
    { id: 'removed', taskId: 'd', title: '移出', startMinutes: 1020, durationMinutes: 30, owner: 'me', status: 'skipped' }
  ]
  const tasks = [
    { id: 'a', title: 'A', nextAction: 'A下一步', status: 'active', owner: 'me', priority: 'high', estimatedMinutes: 30 },
    { id: 'd', title: 'D', nextAction: '不应再次出现', status: 'active', owner: 'me', priority: 'high', estimatedMinutes: 30 },
    { id: 'e', title: 'E', nextAction: '新安排', status: 'active', owner: 'me', priority: 'normal', estimatedMinutes: 30 },
    { id: 'ai', title: 'AI', nextAction: '不占用户时间', status: 'active', owner: 'ai', priority: 'high', estimatedMinutes: 30 }
  ]
  const result = chooseToday(tasks, [], sessions, now, 360)
  assert.equal(result.sessions.some((item) => item.id === 'past'), true)
  assert.equal(result.sessions.some((item) => item.id === 'fixed'), true)
  assert.equal(result.sessions.some((item) => item.id === 'done'), true)
  assert.equal(result.sessions.some((item) => item.id === 'removed'), true)
  assert.equal(result.sessions.filter((item) => item.taskId === 'd').length, 1)
  assert.equal(result.sessions.some((item) => item.taskId === 'ai'), false)
  assert.equal(result.sessions.some((item) => item.taskId === 'e'), true)
  assert.equal(result.sessions.filter((item) => item.taskId === 'a').length, 1)
  for (const item of result.sessions.filter((session) => !['past', 'fixed', 'done', 'removed'].includes(session.id))) {
    const overlapsFixed = item.startMinutes < 960 && item.startMinutes + item.durationMinutes > 900
    assert.equal(overlapsFixed, false)
  }
})
test('dayKey uses the Shanghai calendar day at UTC midnight boundaries', () => {
  const { dayKey } = require('../cloudfunctions/notebookApi/planning')
  assert.equal(dayKey(new Date('2026-09-19T16:30:00.000Z')), '2026-09-20')
  assert.equal(dayKey(new Date('2026-09-20T15:59:59.000Z')), '2026-09-20')
  assert.equal(dayKey(new Date('2026-09-20T16:00:00.000Z')), '2026-09-21')
})
