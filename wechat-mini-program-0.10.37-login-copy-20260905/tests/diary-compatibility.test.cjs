const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
function loadCommonJs(file) {
  const source = fs.readFileSync(file, 'utf8')
  const module = { exports: {} }
  const factory = new Function('require', 'module', 'exports', '__filename', '__dirname', source)
  factory(require('node:module').createRequire(file), module, module.exports, file, path.dirname(file))
  return module.exports
}
const presenter = loadCommonJs(path.join(ROOT, 'miniprogram/pages/tasks/diary-presenter.js'))
const cloud = require('../cloudfunctions/notebookApi/index.js').__test
const desktopCloud = require('../cloudfunctions/desktopSync/index.js').__test

test('手机今日小记按实际日期统计并只把短摘要放进往日记录', () => {
  const view = presenter.buildDiaryView({
    todayDate: '2026-08-29',
    days: [
      { date: '2026-08-29', summary: '## 今日记录\n\n今天完成了兼容同步。', organizedBy: 'deepseek', synthesisUpdatedAt: '2026-08-29T14:20:00.000Z' },
      { date: '2026-08-28', summary: '昨天完成了界面检查。', synthesisSource: 'rules' }
    ],
    todayState: {
      todos: [
        { id: 'todo-new', title: '新增任务', status: 'planned', proposedAt: '2026-08-29T01:00:00.000Z' },
        { id: 'todo-carried', title: '昨天顺延', status: 'planned', source: 'carry_over', carriedFromId: 'old-source', createdAt: '2026-08-29T01:30:00.000Z' },
        { id: 'todo-done', title: '完成任务', status: 'done', createdAt: '2026-08-20T01:00:00.000Z', completedAt: '2026-08-29T05:00:00.000Z', comments: [
          { id: 'note-1', content: '解决了问题', createdAt: '2026-08-29T06:00:00.000Z' },
          { id: 'empty-note', content: '', attachments: [], createdAt: '2026-08-29T06:10:00.000Z' }
        ] }
      ],
      completedHistory: []
    },
    journal: { entries: [{ id: 'journal-1', journalDate: '2026-08-29', journalTitle: '新想法' }], favorites: [], hidden: [], history: [] }
  })
  assert.equal(view.summary, '## 今日记录\n\n今天完成了兼容同步。')
  assert.deepEqual(view.stats, { newTodos: 1, completed: 1, notes: 1, journals: 1 })
  assert.equal(view.sourceLabel, 'DeepSeek 已整理')
  assert.equal(view.pastDiaryDays.length, 1)
  assert.equal(view.pastDiaryDays[0].summary, '昨天完成了界面检查。')
  assert.equal(view.pastDiaryDays[0].dateLabel, '8月28日')
})

test('云端小记事实同样排除顺延待办和空白评论', () => {
  const facts = cloud.diaryFacts('2026-08-29', [
    { id: 'fresh', title: '今天新增', status: 'planned', proposedAt: '2026-08-29T01:00:00.000Z' },
    { id: 'carried', title: '昨天顺延', status: 'planned', source: 'carry_over', carriedFromId: 'old', createdAt: '2026-08-29T01:30:00.000Z' },
    { id: 'noted', title: '带笔记', status: 'done', completedAt: '2026-08-29T02:00:00.000Z', comments: [
      { id: 'blank', content: '', attachments: [], createdAt: '2026-08-29T03:00:00.000Z' },
      { id: 'image', content: '', attachments: [{ fileID: 'cloud://image' }], createdAt: '2026-08-29T03:10:00.000Z' }
    ] }
  ], [])
  assert.deepEqual(facts.newTodos, ['今天新增'])
  assert.equal(facts.notes.length, 1)
  assert.equal(facts.notes[0].content, '添加了图片笔记')
})

test('手机没有 day_records 时只从现有缓存形成基础小记', () => {
  const view = presenter.buildDiaryView({
    todayDate: '2026-08-29',
    days: [],
    todayState: {
      todos: [{ id: 'done', title: '验证旧版本', status: 'done', completedAt: '2026-08-29T02:00:00.000Z' }]
    },
    journal: {}
  })
  assert.match(view.summary, /## 今日补充[\s\S]*今日待办完成：验证旧版本/)
  assert.equal(view.sourceLabel, '基础整理')
})

test('两端直接写入的今日小记原文按 id 保存并在手机端可展开查看', () => {
  const inputs = cloud.normalizeDailyManualInputs([
    { id: 'desktop-input', content: '电脑端补写的事实', createdAt: '2026-08-29T03:00:00.000Z', source: 'desktop' },
    { id: 'phone-input', content: '手机端补写的事实', createdAt: '2026-08-29T04:00:00.000Z', source: 'wechat' },
    { id: 'phone-input', content: '手机端补写的事实', createdAt: '2026-08-29T04:00:00.000Z', source: 'wechat' }
  ])
  assert.deepEqual(inputs.map((item) => item.id), ['desktop-input', 'phone-input'])
  const view = presenter.buildDiaryView({
    todayDate: '2026-08-29',
    days: [{ date: '2026-08-29', summary: '已经整理。', manualInputs: inputs }],
    todayState: {}, journal: {}
  })
  assert.deepEqual(view.manualInputs.map((item) => item.id), ['phone-input', 'desktop-input'])
  assert.equal(view.manualInputs[0].content, '手机端补写的事实')
})

test('云端每日小记白名单不包含 Codex 原文、会话和任务关系', () => {
  const visible = cloud.dayRecordForClient({
    id: 'day_records_2026-08-29', date: '2026-08-29', headline: '今日小记', summary: '短摘要',
    periods: [{ id: 'p1', title: '完成同步', summary: '测试通过', status: 'completed', outcomes: ['通过'], sourceCaptureIds: ['private'] }],
    manualInputs: [{ id: 'input-1', content: '用户直接写下的原文', createdAt: '2026-08-29T02:00:00.000Z', source: 'wechat' }],
    sessions: [{ transcript: 'private transcript' }], taskIds: ['private-task'], sourceLinks: ['private-source'],
    synthesisSource: 'llm', synthesisUpdatedAt: '2026-08-29T03:00:00.000Z'
  })
  assert.equal(visible.summary, '短摘要')
  assert.equal(visible.periods[0].sourceCaptureIds, undefined)
  assert.equal(visible.sessions, undefined)
  assert.equal(visible.taskIds, undefined)
  assert.equal(visible.sourceLinks, undefined)
  assert.equal(visible.manualInputs[0].content, '用户直接写下的原文')

  const desktopVisible = desktopCloud.sanitizeDayRecordDocument({
    ...visible, sessions: [{ transcript: 'private' }], taskIds: ['private-task']
  })
  assert.equal(desktopVisible.sessions, undefined)
  assert.equal(desktopVisible.taskIds, undefined)
})

test('云端快照按日期消重并保留两端直接补写的原文', () => {
  const rows = cloud.diaryDaysForSnapshot([
    {
      id: 'legacy_workspace_day_2026-08-29', date: '2026-08-29', summary: '旧云端副本', version: 9,
      synthesisUpdatedAt: '2026-08-29T05:00:00.000Z',
      manualInputs: [{ id: 'phone-input', content: '手机补写', createdAt: '2026-08-29T05:10:00.000Z', source: 'wechat' }]
    },
    {
      id: 'day_records_2026-08-29', date: '2026-08-29', summary: '电脑本地正式小记', version: 11,
      synthesisUpdatedAt: '2026-08-29T04:00:00.000Z',
      manualInputs: [{ id: 'desktop-input', content: '电脑补写', createdAt: '2026-08-29T04:10:00.000Z', source: 'desktop' }]
    }
  ])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].summary, '电脑本地正式小记')
  assert.deepEqual(rows[0].manualInputs.map((item) => item.id), ['desktop-input', 'phone-input'])
})

test('DeepSeek 失败时规则小记严格区分新建、完成、笔记和灵光一现', () => {
  const summary = cloud.ruleDailyDiarySummary({
    newTodos: ['准备材料'], completed: ['提交申请'],
    notes: [{ todo: '提交申请', content: '已收到确认' }],
    journals: [{ title: '同步方案', summary: '只传短摘要' }],
    manualInputs: [{ content: '今天还补写了弱网恢复要继续验证' }]
  })
  assert.match(summary, /^## 今日记录/)
  assert.match(summary, /今日待办完成：提交申请/)
  assert.match(summary, /新增待办：准备材料/)
  assert.match(summary, /待办补充：给提交申请补充了 1 条笔记/)
  assert.match(summary, /灵光一现：同步方案/)
  assert.match(summary, /弱网恢复要继续验证/)
})

test('第三个标签保留原 tasks 路径，长期计划只是默认收起而没有删除', () => {
  const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'miniprogram/app.json'), 'utf8'))
  const tab = app.tabBar.list[2]
  assert.equal(tab.pagePath, 'pages/tasks/index')
  assert.equal(tab.text, '今日小记')
  const page = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/tasks/index.wxml'), 'utf8')
  const source = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/tasks/index.js'), 'utf8')
  assert.match(page, /往日小记/)
  assert.match(page, /scroll-y class="diary-history-scroll"/)
  assert.match(page, /旧的长期计划/)
  assert.match(page, /保存原文并整理/)
  assert.match(page, /今天直接输入的原文/)
  assert.match(source, /showLegacyTasks: false/)
  assert.match(source, /api\.call\('diary\.appendInput'/)
  assert.match(source, /api\.organizePendingDiaries\(/)
  assert.match(source, /acceptedInputId !== inputId/)
  assert.match(source, /api\.call\('task\.list'\)/)
})

test('新云端只在旧快照结构上追加 diaryDays，旧字段仍保持原名', () => {
  const source = fs.readFileSync(path.join(ROOT, 'cloudfunctions/notebookApi/index.js'), 'utf8')
  const snapshot = source.slice(source.indexOf('async function syncSnapshot'), source.indexOf('function polishTodayTodoTitle'))
  for (const field of ['bootstrap:', 'data:', 'tasks,', 'journal,', 'journalArchive,']) assert.match(snapshot, new RegExp(field))
  assert.match(snapshot, /diaryDays:/)
  assert.match(snapshot, /includedScopes: \['today_todos', 'journal_entries', 'long_term_tasks', 'daily_diary'\]/)
})
