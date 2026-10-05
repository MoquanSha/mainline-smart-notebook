const { sortTodayTodos } = require('./sync-policy')
const TYPES = ['tasks', 'daily_tasks', 'captures', 'day_records']

function originals(...lists) {
  const rows = new Map()
  for (const item of lists.flat()) {
    if (!item || !String(item.content || '').trim()) continue
    const key = JSON.stringify([item.conflictOf || item.id, item.content])
    if (!rows.has(key)) rows.set(key, { ...item })
  }
  return [...rows.values()].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)) || String(a.content).localeCompare(String(b.content)))
}
function isDeleted(row) { return Boolean(row && (row.deletedAt || row.trashedAt || row.permanentlyPurgedAt || row.status === 'removed')) }
function pad2(value) { return value < 10 ? `0${value}` : String(value) }
function shanghaiDateFromValue(value) {
  const explicit = String(value || '')
  if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit
  const timestamp = Date.parse(explicit)
  if (!Number.isFinite(timestamp)) return ''
  // Do not use Intl.DateTimeFormat here. Older WeChat base libraries can
  // expose Date but omit Intl, which previously made both journal pages fail
  // while projecting the cloud history.
  const shanghai = new Date(timestamp + 8 * 60 * 60 * 1000)
  return `${shanghai.getUTCFullYear()}-${pad2(shanghai.getUTCMonth() + 1)}-${pad2(shanghai.getUTCDate())}`
}
function recordKey(item, type) {
  if (!item) return ''
  return String(type === 'day_records' ? item.date || item.id || item._id || '' : item.id || item._id || '')
}
function mergeRows(previous = [], incoming = [], type = '') {
  const rows = new Map()
  for (const item of [...previous, ...incoming]) {
    const key = recordKey(item, type)
    if (!key) continue
    const old = rows.get(key)
    if (!old) { rows.set(key, { ...item }); continue }
    const oldVersion = Number(old.version || 0), version = Number(item.version || 0)
    let winner = version < oldVersion ? old : item
    // Local backup transport has its own committed record sequence. It also
    // covers legacy desktop writers that did not increment business versions.
    if (old._homeEpoch && old._homeEpoch === item._homeEpoch &&
        Number.isSafeInteger(old._homeSequence) && Number.isSafeInteger(item._homeSequence)) {
      winner = item._homeSequence < old._homeSequence ? old : item
    }
    if (old.permanentlyPurgedAt && !item.permanentlyPurgedAt) winner = old
    else if (item.permanentlyPurgedAt && !old.permanentlyPurgedAt) winner = item
    else if (old.deletedAt && !item.deletedAt) winner = old
    else if (isDeleted(old) && !isDeleted(item) && !(old.deletionId && item.restoreOf === old.deletionId && item.restoreId)) winner = old
    else if (isDeleted(item) && !isDeleted(old) && old.restoreOf === item.deletionId && old.restoreId) winner = old
    const merged = { ...(winner === old ? item : old), ...winner }
    if (!winner._homeEpoch) { delete merged._homeEpoch; delete merged._homeSequence }
    if (Array.isArray(old.manualInputs) || Array.isArray(item.manualInputs)) {
      merged.manualInputs = originals(old.manualInputs || [], item.manualInputs || [])
      const keys = (inputs) => JSON.stringify((inputs || []).map((x) => [x.id, x.content]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
      if (keys(merged.manualInputs) !== keys(winner.manualInputs)) {
        merged.summary = `## 今日记录\n\n${merged.manualInputs.map((x) => x.content).join('\n\n')}`
        merged.organizationStatus = 'pending'
        merged.organizationRevision = ''
        merged.inputRevision = ''
      }
    }
    rows.set(key, merged)
  }
  return [...rows.values()]
}
function emptyRecords() { return Object.fromEntries(TYPES.map((type) => [type, []])) }
function snapshotRecords(snapshot = {}) {
  const journal = snapshot.journal || {}, data = snapshot.data || snapshot
  const dated = (rows, field, date) => (rows || []).map((row) => row[field] || !date ? row : { ...row, [field]: date })
  return {
    tasks: snapshot.tasks || [],
    daily_tasks: mergeRows([], [...dated(data.todos || data.todayTodos, 'date', snapshot.date), ...(data.scheduled || data.scheduledTodos || []), ...(data.completedHistory || []), ...(data.history || data.todayHistory || []).flatMap((day) => dated(day.todos, 'date', day.date))]),
    captures: mergeRows([], [...dated(journal.entries, 'journalDate', snapshot.date), ...(journal.favorites || []), ...(journal.hidden || []), ...(journal.history || []).flatMap((day) => dated(day.entries, 'journalDate', day.date)), ...(snapshot.journalArchive || [])]),
    day_records: snapshot.diaryDays || []
  }
}

// Old servers return pre-grouped, potentially truncated views, not a complete
// record stream. Keep their category/order contract and retain unseen history.
// An ID returned in a different category removes its obsolete old membership.
function mergeLegacySnapshot(snapshot, confirmed = {}) {
  const oldData = confirmed.data || { todos: confirmed.todayTodos || [], scheduled: confirmed.scheduledTodos || [], completedHistory: confirmed.completedHistory || [], history: confirmed.todayHistory || [] }
  const oldJournal = confirmed.journal || {}
  const data = snapshot.data || {}, journal = snapshot.journal || oldJournal
  const incoming = snapshotRecords(snapshot)
  const seenTodo = new Set(incoming.daily_tasks.map((row) => recordKey(row)))
  const seenJournal = new Set(incoming.captures.map((row) => recordKey(row)))
  const bucket = (previous, next, seen) => {
    const merged = new Map(mergeRows(previous || [], next || []).map((row) => [recordKey(row), row]))
    return [...(next || []).map((row) => merged.get(recordKey(row))).filter(Boolean),
      ...(previous || []).filter((row) => !seen.has(recordKey(row)))]
  }
  const groups = (previous, next, field, seen) => {
    const days = new Map((previous || []).map((day) => [day.date, day]))
    for (const day of next || []) days.set(day.date, { ...day, [field]: bucket(days.get(day.date)?.[field], day[field], seen) })
    const newDates = new Set((next || []).map((day) => day.date))
    return [...days.values()].map((day) => newDates.has(day.date) ? day : { ...day, [field]: (day[field] || []).filter((row) => !seen.has(recordKey(row))) })
      .filter((day) => day[field].length).sort((a, b) => String(b.date).localeCompare(String(a.date)))
  }
  const resultData = { ...data, todos: bucket(confirmed.date && snapshot.date && confirmed.date !== snapshot.date ? [] : oldData.todos, data.todos, seenTodo) }
  for (const field of ['scheduled', 'completedHistory']) {
    if (Array.isArray(data[field]) || oldData[field]?.length) resultData[field] = bucket(oldData[field], data[field], seenTodo)
  }
  resultData.history = groups(oldData.history, data.history, 'todos', seenTodo)
  const resultJournal = { ...journal }
  for (const field of ['entries', 'favorites', 'hidden']) {
    if (Array.isArray(journal[field]) || oldJournal[field]?.length) resultJournal[field] = bucket(oldJournal[field], journal[field], seenJournal)
  }
  resultJournal.history = groups(oldJournal.history, journal.history, 'entries', seenJournal)
  return { data: resultData, journal: resultJournal,
    tasks: mergeRows(confirmed.tasks || [], snapshot.tasks || []).filter((row) => !isDeleted(row)),
    journalArchive: bucket(confirmed.journalArchive, snapshot.journalArchive, seenJournal),
    diaryDays: mergeRows(confirmed.diaryDays || [], snapshot.diaryDays || [], 'day_records').filter((row) => !isDeleted(row)) }
}
function mergeRecords(previous = {}, incoming = {}) {
  return Object.fromEntries(TYPES.map((type) => [type, mergeRows(previous[type] || [], incoming[type] || [], type)]))
}
function mergePage(previous, page) {
  if (!Array.isArray(page.records) || !page.nextCursor || typeof page.hasMore !== 'boolean') throw Object.assign(new Error('历史分页响应不完整，进度未更新'), { code: 'HISTORY_PAGE_INVALID' })
  const incoming = emptyRecords()
  for (const row of page.records) {
    if (!TYPES.includes(row.collection) || !row.document || !row.document.id) throw Object.assign(new Error('历史记录缺少有效编号，进度未更新'), { code: 'HISTORY_PAGE_INVALID' })
    incoming[row.collection].push(row.document)
  }
  return mergeRecords(previous, incoming)
}
function project(records, date) {
  const todos = (records.daily_tasks || []).filter((row) => !isDeleted(row))
  const history = new Map(), journals = new Map()
  for (const row of todos.filter((row) => row.date < date)) {
    if (!history.has(row.date)) history.set(row.date, [])
    history.get(row.date).push(row)
  }
  const entries = (records.captures || []).filter((row) => !isDeleted(row))
    .sort((a, b) => String(b.occurredAt || b.createdAt || '').localeCompare(String(a.occurredAt || a.createdAt || '')))
  const visible = entries.filter((row) => !row.journalArchived && !row.archivedAt)
  const entryDate = (row) => shanghaiDateFromValue(row.journalDate || row.occurredAt || row.createdAt)
  for (const row of visible.filter((row) => !row.hiddenAt && entryDate(row) && entryDate(row) < date)) {
    const key = entryDate(row)
    if (!journals.has(key)) journals.set(key, [])
    journals.get(key).push(row)
  }
  return {
    data: { todos: sortTodayTodos(todos.filter((row) => row.date === date)), scheduled: sortTodayTodos(todos.filter((row) => row.date > date && row.status === 'planned')),
      completedHistory: todos.filter((row) => row.status === 'done'), history: [...history].sort(([a], [b]) => b.localeCompare(a)).map(([day, rows]) => ({ date: day, todos: sortTodayTodos(rows) })) },
    tasks: (records.tasks || []).filter((row) => !isDeleted(row)),
    journal: { entries: visible.filter((row) => entryDate(row) === date && !row.hiddenAt), favorites: visible.filter((row) => row.favoritedAt && !row.hiddenAt).sort((a, b) => String(b.favoritedAt).localeCompare(String(a.favoritedAt))), hidden: visible.filter((row) => row.hiddenAt).sort((a, b) => String(b.hiddenAt).localeCompare(String(a.hiddenAt))), history: [...journals].sort(([a], [b]) => b.localeCompare(a)).map(([day, rows]) => ({ date: day, entries: rows })) },
    journalArchive: entries.filter((row) => row.journalArchived || row.archivedAt || entryDate(row) < date),
    diaryDays: (records.day_records || []).filter((row) => !isDeleted(row)).sort((a, b) => String(b.date).localeCompare(String(a.date)))
  }
}
module.exports = { originals, mergeRows, snapshotRecords, mergeLegacySnapshot, mergeRecords, mergePage, project, emptyRecords, shanghaiDateFromValue }
