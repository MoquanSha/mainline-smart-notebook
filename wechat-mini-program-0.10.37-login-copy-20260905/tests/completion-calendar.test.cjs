const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const calendarModule = { exports: {} }
const calendarSource = fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'pages', 'home', 'completion-calendar.js'), 'utf8')
new Function('module', 'exports', calendarSource)(calendarModule, calendarModule.exports)
const calendar = calendarModule.exports
const homeMarkup = fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'pages', 'home', 'index.wxml'), 'utf8')
const homeSource = fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'pages', 'home', 'index.js'), 'utf8')
const homeStyles = fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'pages', 'home', 'index.wxss'), 'utf8')

function row(id, completedAt) {
  return { id, title: id, completedAt }
}

test('完成记录默认全部展示，选择日期后只保留当天', () => {
  const rows = [
    row('aug-29-a', '2026-08-29T01:00:00.000Z'),
    row('aug-29-b', '2026-08-29T02:00:00.000Z'),
    row('aug-02', '2026-08-02T03:00:00.000Z')
  ]
  const all = calendar.buildCompletionView(rows, '', '2026-08', '2026-08-29')
  assert.equal(all.completedQueryDate, '')
  assert.equal(all.completedResults.length, 3)
  assert.deepEqual(all.completionDates, ['2026-08-02', '2026-08-29'])

  const filtered = calendar.buildCompletionView(rows, '2026-08-29', '2026-08', '2026-08-29')
  assert.equal(filtered.completedResults.length, 2)
  assert.ok(filtered.completedResults.every((item) => item.id.startsWith('aug-29')))
})

test('只有存在完成记录的日期可选，其余日期显示为禁用', () => {
  const view = calendar.buildCompletionView([
    row('enabled', '2026-08-12T04:00:00.000Z')
  ], '', '2026-08', '2026-08-29')
  const enabled = view.completionCalendar.find((item) => item.date === '2026-08-12')
  const disabled = view.completionCalendar.find((item) => item.date === '2026-08-13')
  assert.equal(enabled.enabled, true)
  assert.equal(disabled.enabled, false)
  assert.equal(view.completedQueryDate, '')

  const invalidSelection = calendar.buildCompletionView(view.completionHistory, '2026-08-13', '2026-08', '2026-08-29')
  assert.equal(invalidSelection.completedQueryDate, '')
  assert.equal(invalidSelection.completedResults.length, 1)
})

test('完成日期跨月时支持在最早和最晚月份之间切换', () => {
  const rows = [
    row('july', '2026-07-10T04:00:00.000Z'),
    row('august', '2026-08-20T04:00:00.000Z')
  ]
  const august = calendar.buildCompletionView(rows, '', '2026-08', '2026-08-29')
  assert.equal(august.completionCanPrevious, true)
  assert.equal(august.completionCanNext, false)
  const july = calendar.buildCompletionView(rows, '', calendar.shiftMonth(august.completionMonth, -1), '2026-08-29')
  assert.equal(july.completionMonth, '2026-07')
  assert.equal(july.completionCanPrevious, false)
  assert.equal(july.completionCanNext, true)
})

test('完成记录直接显示历史照片，展开后保留文字和分组图片', () => {
  assert.match(homeSource, /openCompletionNotes: \{\}/)
  assert.match(homeSource, /toggleCompletionNotes\(event\)/)
  assert.match(homeMarkup, /item\.photoAttachments\.length && !openCompletionNotes\[item\.id\]/)
  assert.match(homeMarkup, /class="completion-photo-preview"/)
  assert.match(homeMarkup, /class="completion-note-toggle"[\s\S]*?bindtap="toggleCompletionNotes"/)
  assert.match(homeMarkup, /item\.comments\.length && openCompletionNotes\[item\.id\]/)
  assert.match(homeMarkup, /wx:for="\{\{item\.comments\}\}" wx:for-item="note"/)
  assert.match(homeMarkup, /class="completion-note-content"/)
  assert.match(homeMarkup, /<photo-gallery[^>]*todo-id="\{\{item\.id\}\}"[^>]*attachments="\{\{note\.attachments\}\}"[^>]*scope="\{\{photoScope\}\}"/)
  assert.match(homeStyles, /\.completion-note-content\{[^}]*white-space:pre-wrap/)
})

test('过去 14 天的历史记录可以直接看照片并展开只读笔记', () => {
  assert.match(homeSource, /openHistoryNotes: \{\}/)
  assert.match(homeSource, /toggleHistoryNotes\(event\)/)
  assert.match(homeMarkup, /todo\.photoAttachments\.length && !openHistoryNotes\[todo\.id\]/)
  assert.match(homeMarkup, /bindtap="toggleHistoryNotes"/)
  assert.match(homeMarkup, /todo\.comments\.length && openHistoryNotes\[todo\.id\]/)
})

test('日期面板默认收起，完成记录固定高度滚动显示', () => {
  assert.match(homeSource, /completionCalendarOpen: false/)
  assert.match(homeSource, /toggleCompletionCalendar\(\)/)
  assert.match(homeMarkup, /wx:if="\{\{completionCalendarOpen\}\}" class="completion-calendar"/)
  assert.match(homeMarkup, /<scroll-view[^>]*scroll-y[^>]*class="completion-results"/)
  assert.match(homeStyles, /\.completion-results\{[^}]*height:720rpx/)
})

test('旧顺延记录的提出日期会使用可追溯到的最早日期', () => {
  assert.match(homeSource, /function proposedDateFor\(todo = \{\}\)/)
  assert.match(homeSource, /addDate\(todo\.proposedAt\)[\s\S]*addDate\(todo\.date\)/)
  assert.match(homeSource, /planRationale[\s\S]*match\(\/\\d\{4\}-\\d\{2\}-\\d\{2\}\/[\s\S]*rationaleMatch \? rationaleMatch\[0\]/)
})
