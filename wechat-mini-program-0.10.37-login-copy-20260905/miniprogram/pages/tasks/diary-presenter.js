const { parseMarkdown } = require('../../utils/markdown')
function shanghaiDateKey(value = Date.now()) {
  const date = new Date(Number(value) + 8 * 60 * 60 * 1000)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

function recordDate(value) {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? shanghaiDateKey(parsed) : ''
}

function dateParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''))
  if (!match) return { full: String(value || ''), monthDay: String(value || ''), week: '' }
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00+08:00`)
  const weeks = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
  return {
    full: `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日`,
    monthDay: `${Number(match[2])}月${Number(match[3])}日`,
    week: weeks[date.getDay()] || ''
  }
}

function timeLabel(value) {
  const parsed = new Date(value)
  if (isNaN(parsed.getTime())) return ''
  const shanghai = new Date(parsed.getTime() + 8 * 60 * 60 * 1000)
  const twoDigits = (number) => String(number).length < 2 ? `0${number}` : String(number)
  return `${twoDigits(shanghai.getUTCHours())}:${twoDigits(shanghai.getUTCMinutes())}`
}

function uniqueRows(rows) {
  const byId = new Map()
  for (const row of rows || []) {
    if (!row) continue
    const id = String(row.id || row._id || `${row.date || ''}:${row.title || ''}`)
    const existing = byId.get(id)
    const currentTime = Date.parse(row.updatedAt || row.completedAt || row.createdAt || 0) || 0
    const existingTime = Date.parse(existing && (existing.updatedAt || existing.completedAt || existing.createdAt) || 0) || 0
    if (!existing || currentTime >= existingTime) byId.set(id, row)
  }
  return [...byId.values()]
}

function flattenJournal(journal = {}) {
  return uniqueRows([
    ...(journal.entries || []),
    ...(journal.favorites || []),
    ...(journal.hidden || []),
    ...(journal.history || []).flatMap((group) => group.entries || [])
  ])
}

function diarySource(day) {
  if (day && day.organizationStatus === 'pending') return '原文已保存，待整理'
  if (day && day.organizationStatus === 'failed') return '原文已保存，整理待重试'
  if (day && day.organizedBy === 'deepseek') return 'DeepSeek 已整理'
  if (day && (day.synthesisSource === 'llm' || day.organizationStatus === 'organized')) return 'AI 已整理'
  return '基础整理'
}

function compactTitles(values, limit = 3) {
  const unique = [...new Set((values || []).map((item) => String(item || '').trim()).filter(Boolean))]
  if (!unique.length) return ''
  const shown = unique.slice(0, limit).join('、')
  return unique.length > limit ? `${shown}等 ${unique.length} 件事` : shown
}

function localDiarySummary(completed, added, notes, journals, manualInputs = [], periods = []) {
  const sections = []
  const manualText = (manualInputs || []).map((item) => String(item && item.content || '')).filter((content) => content.trim())
  if (manualText.length) sections.push(`## 今日记录\n\n${manualText.join('\n\n')}`)
  const supplements = []
  const completedText = compactTitles(completed.map((item) => item.title))
  const addedText = compactTitles(added.map((item) => item.title))
  if (completedText) supplements.push(`- 今日待办完成：${completedText}`)
  if (addedText) supplements.push(`- 新增待办：${addedText}`)
  if (notes.length) {
    const names = compactTitles(notes.map((item) => item.todoTitle), 2)
    supplements.push(`- 待办补充：${names ? `给${names}` : '给待办'}补充了 ${notes.length} 条笔记`)
  }
  if (journals.length) {
    const names = compactTitles(journals.map((item) => item.journalTitle || item.title), 2)
    supplements.push(`- 灵光一现：${names || `${journals.length} 条内容`}`)
  }
  for (const period of (periods || []).slice(0, 8)) {
    const title = String(period && period.title || '').trim()
    if (title) supplements.push(`- 电脑端工作记录：**${title}**`)
  }
  if (!manualText.length) sections.push('## 今日记录\n\n今天暂未手动补写日记或感悟。')
  if (supplements.length) sections.push(`## 今日补充\n\n${supplements.join('\n')}`)
  if (sections.length) return sections.join('\n\n')
  return '## 今日记录\n\n今天暂未手动补写日记或感悟。\n\n## 今日补充\n\n今天没有可补充的待办变化。'
}

const markdownBlocks = parseMarkdown

function normalizeDiaryDays(rows) {
  const byDate = new Map()
  for (const row of rows || []) {
    if (!row || !/^\d{4}-\d{2}-\d{2}$/.test(String(row.date || '')) || !String(row.summary || '').trim()) continue
    const existing = byDate.get(row.date)
    const rowTime = Date.parse(row.updatedAt || row.synthesisUpdatedAt || 0) || 0
    const existingTime = Date.parse(existing && (existing.updatedAt || existing.synthesisUpdatedAt) || 0) || 0
    if (!existing || rowTime >= existingTime) byDate.set(row.date, row)
  }
  return [...byDate.values()].sort((left, right) => String(right.date).localeCompare(String(left.date)))
}

function mergeDiaryDay(rows, updated) {
  if (!updated || !updated.date) return normalizeDiaryDays(rows)
  return normalizeDiaryDays([...(rows || []).filter((item) => item && item.date !== updated.date), updated])
}

function buildDiaryView(options = {}) {
  const todayDate = options.todayDate || shanghaiDateKey()
  const diaryDays = normalizeDiaryDays(options.days || [])
  const todayState = options.todayState && typeof options.todayState === 'object' ? options.todayState : {}
  const allTodos = uniqueRows([
    ...(todayState.todos || []),
    ...(todayState.scheduled || []),
    ...(todayState.completedHistory || [])
  ]).filter((item) => item && !item.deletedAt && !item.trashedAt && item.status !== 'removed')
  const newTodos = allTodos.filter((item) => (
    item.source !== 'carry_over'
    && !item.carriedFromId
    && recordDate(item.proposedAt || item.createdAt) === todayDate
  ))
  const completed = allTodos.filter((item) => item.status === 'done' && recordDate(item.completedAt) === todayDate)
  const todoNotes = allTodos.flatMap((todo) => (todo.comments || [])
    .filter((comment) => (
      comment
      && !comment.deletedAt
      && recordDate(comment.createdAt || comment.updatedAt) === todayDate
      && (String(comment.content || comment.rawContent || '').trim() || (comment.attachments || []).some((attachment) => attachment && !attachment.deletedAt))
    ))
    .map((comment) => ({
      id: String(comment.id || `${todo.id}-note`),
      todoTitle: String(todo.title || '待办'),
      content: String(comment.content || comment.rawContent || '').trim() || ((comment.attachments || []).length ? '添加了图片笔记' : ''),
      time: timeLabel(comment.createdAt || comment.updatedAt)
    })).filter((comment) => comment.content))
  const journals = flattenJournal(options.journal || {}).filter((entry) => (
    String(entry.journalDate || '').slice(0, 10) === todayDate || recordDate(entry.occurredAt || entry.createdAt) === todayDate
  ))
  const today = diaryDays.find((item) => item.date === todayDate)
  const localSummary = localDiarySummary(completed, newTodos, todoNotes, journals, today && today.manualInputs || [], today && today.periods || [])
  const storedSummary = String(today && today.summary || '').trim()
  const summary = storedSummary.startsWith('## 今日记录') ? storedSummary : localSummary
  const parts = dateParts(todayDate)
  const periods = (today && today.periods || []).map((period) => ({
    ...period,
    statusLabel: period.status === 'blocked' ? '有阻塞' : period.status === 'in_progress' ? '推进中' : '已完成',
    timeRange: period.startTime && period.endTime ? `${period.startTime}–${period.endTime}` : ''
  }))
  const manualInputs = (today && today.manualInputs || []).slice().reverse().map((item) => ({
    id: String(item.id || ''),
    content: String(item.content || ''),
    pending: item.pending === true,
    time: timeLabel(item.createdAt),
    createdAt: item.createdAt || ''
  })).filter((item) => item.content)
  return {
    todayDate,
    todayDateLabel: `${parts.full} · ${parts.week}`,
    summary,
    summaryNodes: parseMarkdown(summary),
    sourceLabel: diarySource(today),
    updatedLabel: timeLabel(today && (today.synthesisUpdatedAt || today.updatedAt)) || '手机本地整理',
    periods,
    manualInputs,
    newTodos: newTodos.map((item) => ({ id: item.id, title: item.title })),
    completed: completed.map((item) => ({ id: item.id, title: item.title, time: timeLabel(item.completedAt) })),
    todoNotes,
    journals: journals.map((item) => ({ id: item.id, title: item.journalTitle || item.title || '灵光一现' })),
    stats: {
      newTodos: newTodos.length,
      completed: completed.length,
      notes: todoNotes.length,
      journals: journals.length
    },
    pastDiaryDays: diaryDays.filter((item) => item.date < todayDate).map((item) => {
      const historyDate = dateParts(item.date)
      return {
        ...item,
        dateLabel: historyDate.monthDay,
        weekLabel: historyDate.week,
        sourceLabel: diarySource(item)
      }
    })
  }
}

module.exports = {
  shanghaiDateKey,
  recordDate,
  dateParts,
  timeLabel,
  normalizeDiaryDays,
  mergeDiaryDay,
  buildDiaryView,
  markdownBlocks
}
