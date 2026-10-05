const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const captureDir = path.resolve(__dirname, '../miniprogram/pages/capture')
const presenter = require(path.join(captureDir, 'presenter.js'))
const { longBody, longEntry } = require('./fixtures/capture-long-entry.cjs')

test('长标题与正文相同时生成可检索短标题并保留正文', () => {
  const result = presenter.present(longEntry)
  assert.ok(result.displayTitle.length <= 23)
  assert.notEqual(result.displayTitle, longBody)
  assert.equal(result.displaySummary, longBody)
  assert.equal(result.summaryLong, true)
})

test('短标题与短正文完全相同时不重复显示正文', () => {
  const result = presenter.present({
    id: 'short-entry',
    source: 'manual',
    journalTitle: '确认报名时间',
    journalSummary: '确认报名时间',
    content: '确认报名时间'
  })
  assert.equal(result.displayTitle, '确认报名时间')
  assert.equal(result.displaySummary, '')
})

test('Markdown 与旧版 checked 清单会转换成移动端可读结构', () => {
  const result = presenter.present(longEntry)
  assert.equal(result.checklistItems[0].done, true)
  assert.equal(result.checklistItems[1].done, false)
  assert.equal(result.doneCount, 1)
  const nodes = (rows) => rows.flatMap((row) => [row, ...nodes(row.children || [])])
  const all = nodes(presenter.markdownBlocks(result.markdown))
  assert.ok(all.some((row) => row.name === 'h1'))
  assert.ok(all.some((row) => row.attrs && row.attrs.class === 'md-task-done'))
  assert.ok(all.some((row) => row.attrs && row.attrs.class === 'md-task-open'))
})

test('概览保留收藏、今日、历史、隐藏与独立回顾数据', () => {
  const overview = presenter.presentOverview({
    entries: [longEntry],
    favorites: [{ ...longEntry, id: 'favorite', favoritedAt: '2026-08-18T09:00:00.000Z' }],
    history: [{ date: '2026-08-17', entries: [{ ...longEntry, id: 'history', favoritedAt: '2026-08-17T09:00:00.000Z' }] }],
    hidden: [{ ...longEntry, id: 'hidden', hiddenAt: '2026-08-18T10:00:00.000Z' }],
    reviews: [{ id: 'review', date: '2026-08-17', summary: '完成了手机端结构校正', reflection: '继续验证收藏同步' }]
  })
  assert.equal(overview.entries.length, 1)
  assert.equal(overview.favorites.length, 1)
  assert.equal(overview.historyCount, 1)
  assert.equal(overview.history[0].favoriteCount, 1)
  assert.equal(overview.hidden.length, 1)
  assert.equal(overview.reviewCount, 1)
  assert.equal(overview.reviews[0].dateLabel, '8月17日')
})

test('页面分组顺序和日期索引符合网页版信息层级', () => {
  const wxml = fs.readFileSync(path.join(captureDir, 'index.wxml'), 'utf8')
  const favorite = wxml.indexOf('class="record-group favorite-group"')
  const today = wxml.indexOf('今天记下的')
  const history = wxml.indexOf('class="record-group history-group"')
  const hidden = wxml.indexOf('class="record-group muted-group"')
  const reviews = wxml.indexOf('class="record-group review-group"')
  assert.ok(favorite >= 0 && favorite < today)
  assert.ok(today < history && history < hidden && hidden < reviews)
  assert.match(wxml, /data-target="history-day-\{\{item\.date\}\}"/)
  assert.match(wxml, /data-target="review-day-\{\{item\.date\}\}"/)
  assert.match(wxml, /bindtap="jumpToDate"/)
})

test('长文展开、结构化 Markdown 与原有收藏隐藏交互同时存在', () => {
  const wxml = fs.readFileSync(path.join(captureDir, 'index.wxml'), 'utf8')
  assert.match(wxml, /bindtap="toggleBody"/)
  assert.match(wxml, /entry\.bodyNodes/)
  assert.doesNotMatch(wxml, /class="markdown-preview">\{\{entry\.markdown\}\}/)
  assert.match(wxml, /data-action="favorite"/)
  assert.match(wxml, /data-action="hide"/)
  assert.match(wxml, /data-action="restore"/)
})

test('完整移动端样式包含长文、日期索引、Markdown 和回顾层级', () => {
  const wxss = fs.readFileSync(path.join(captureDir, 'index.wxss'), 'utf8')
  assert.ok(Buffer.byteLength(wxss, 'utf8') > 10000)
  for (const selector of [
    '.entry-summary.is-collapsed',
    '.entry-expand',
    '.date-index-item',
    '.markdown-heading',
    '.markdown-check-box',
    '.review-card'
  ]) assert.ok(wxss.includes(selector), `缺少样式 ${selector}`)
})

test('回顾默认收起，现有页面骨架不被改成旧时间线', () => {
  const js = fs.readFileSync(path.join(captureDir, 'index.js'), 'utf8')
  const wxml = fs.readFileSync(path.join(captureDir, 'index.wxml'), 'utf8')
  assert.match(js, /showReviews:\s*false/)
  assert.match(wxml, /wx:if="\{\{showReviews\}\}" class="review-list"/)
  assert.doesNotMatch(wxml, /每日规划|时间线|AI 计划预览/)
})

test('灵光一现先保存原文，再调用 DeepSeek 并把完整 Markdown 写入整理稿', async () => {
  const { cloudRuntime } = require('./helpers/cloud-runtime.cjs')
  const requests = [], raw = '可能并没有完成申请，预算 123.45 元。'
  const markdown = '## 申请进展\n\n' + raw
  const { api, rows } = cloudRuntime([], { generateText: async (request) => {
    requests.push(request)
    return { text: JSON.stringify({ title: '申请进展', summary: '一条摘要', markdown, type: 'note', items: [] }) }
  } })
  await api.createJournalEntry('owner', { id: 'entry', content: raw, deferOrganization: true })
  assert.equal(requests.length, 0)
  assert.equal(rows.get('captures/entry').rawContent, raw)
  await api.organizeJournalStep('owner', { entryId: 'entry' })
  assert.equal(requests[0].model, 'deepseek-v4-flash')
  assert.equal(rows.get('captures/entry').organizedContent, markdown)
  assert.equal(rows.get('captures/entry').rawContent, raw)
  const shown = presenter.present(rows.get('captures/entry'))
  assert.ok(shown.displaySummary.includes(raw))
  assert.equal(shown.originalContent, raw)
  assert.equal(shown.organizerLabel, 'DeepSeek 已整理')
})
