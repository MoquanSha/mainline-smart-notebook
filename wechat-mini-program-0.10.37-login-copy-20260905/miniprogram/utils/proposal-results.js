const { mergeRows } = require('./sync-history')

function selections(rows) {
  return (rows || []).map((row) => ({ id: row.id, baseVersion: Number(row.version || 1),
    ...(row.taskBaseVersion !== undefined ? { taskBaseVersion: row.taskBaseVersion } : {}) }))
}
function mergeResult(current, result) {
  const rows = result?.results ? result.results.filter((row) => row.ok && row.data?.proposal).map((row) => row.data.proposal)
    : result?.proposal ? [result.proposal] : result?.id && result?.status ? [result] : []
  return mergeRows(current, rows)
}
function mergeRead(beforeRows, currentRows, reply) {
  const incoming = reply.proposals || [], ids = new Set(incoming.map((row) => row.id))
  const before = new Map(beforeRows.map((row) => [row.id, row]))
  const current = currentRows.map((row) => mergeRows(before.has(row.id) ? [before.get(row.id)] : [], [row])[0])
  return mergeRows(current.filter((row) => ids.has(row.id) || reply.complete !== true || JSON.stringify(before.get(row.id)) !== JSON.stringify(row)), incoming)
}
function feedback(result, fallback = '已采用') {
  if (result?.failed) return { message: `已采用 ${result.applied || 0} 条，${result.failed} 条待处理`, tone: 'offline' }
  if (result?.planning?.status === 'pending') return { message: `${fallback} · 排程待更新`, tone: 'offline' }
  return { message: fallback, tone: 'ok' }
}
module.exports = { selections, mergeResult, mergeRead, feedback }
