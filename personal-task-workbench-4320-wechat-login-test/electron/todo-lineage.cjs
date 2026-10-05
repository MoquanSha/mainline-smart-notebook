'use strict'
const crypto = require('crypto')

// Both deployed runtimes carry this small contract; cross-runtime tests compare
// the source and exercise the real callers. Titles/task links are never IDs.
function todoLineageId(item, records = []) {
  if (!item || typeof item !== 'object') return String(item || '')
  const byId = new Map(records.map((row) => [String(row.id || row._id || ''), row]))
  const seen = new Set()
  let current = item
  while (current) {
    if (current.lineageId) return String(current.lineageId)
    const id = String(current.id || current._id || '')
    if (seen.has(id)) return [...seen].sort()[0] || id
    seen.add(id)
    const parent = String(current.carriedFromId || '')
    if (!parent) return id
    if (!byId.has(parent)) return parent
    current = byId.get(parent)
  }
  return ''
}

function todayTodoCarryId(item, targetDate, records = []) {
  const root = todoLineageId(item, records)
  if (!root) throw new Error('待办缺少原始记录编号')
  return `today-todo-carry-${crypto.createHash('sha256').update(`${root}|${targetDate}`).digest('hex').slice(0, 24)}`
}

function todoIsDeleted(item) {
  return Boolean(item && (item.deletedAt || item.trashedAt || item.status === 'removed'))
}

module.exports = { todoLineageId, todayTodoCarryId, todoIsDeleted }
