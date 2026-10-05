'use strict'
const { createHash } = require('node:crypto')
const BODY_FIELDS = ['title', 'description', 'content', 'rawContent', 'rawInput', 'summary', 'markdown', 'journalTitle', 'journalSummary', 'organizedContent', 'organizationSummary']
const LIST_FIELDS = ['comments', 'attachments', 'journalSupplements', 'annotations', 'checklistItems', 'steps']

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
function digest(value) { return createHash('sha256').update(stable(value)).digest('hex').slice(0, 24) }
function isDeleted(row) { return Boolean(row && (row.deletedAt || row.trashedAt || row.status === 'removed')) }
function deletionKey(row) {
  if (!isDeleted(row)) return ''
  // Derive from the actual delete event, never from an inherited marker left by
  // a previous delete/restore cycle. Permanent removal is checked separately.
  return `delete-${digest({ id: row.id || row._id, at: row.trashedAt || row.deletedAt || '', removed: !row.trashedAt && !row.deletedAt && row.status === 'removed' })}`
}
function restores(candidate, deleted) {
  return !isDeleted(candidate) && isDeleted(deleted) && !deleted.deletedAt && Boolean(candidate.restoreId) && candidate.restoreOf === deletionKey(deleted)
}
function restoreMarker(deleted, restoreId, at) {
  if (!isDeleted(deleted) || !restoreId) throw new Error('恢复操作缺少对应的删除记录')
  return { restoreId, restoreOf: deletionKey(deleted), restoredAt: at, deletionId: '', deletedAt: '', trashedAt: '', purgeAt: '' }
}
function bodyOf(row) {
  return Object.fromEntries(BODY_FIELDS.filter((key) => row && row[key] !== undefined).map((key) => [key, row[key]]))
}
function snapshot(row) {
  const body = bodyOf(row)
  return { id: `conflict-${digest(body)}`, body, updatedAt: row.updatedAt || row.createdAt || '', source: row.source || '' }
}
function mergeVersions(...lists) {
  const values = new Map()
  for (const row of lists.flat()) {
    if (!row || !row.body || typeof row.body !== 'object') continue
    const body = bodyOf(row.body), id = `conflict-${digest(body)}`
    if (!values.has(id)) values.set(id, { ...row, id, body })
  }
  return [...values.values()].sort((a, b) => a.id.localeCompare(b.id))
}
function mergeOriginals(...lists) {
  const groups = new Map()
  for (const raw of lists.flat()) {
    if (!raw || !String(raw.content || '').trim()) continue
    const item = { ...raw, content: String(raw.content) }
    item.id = String(raw.id || `input-${digest({ content: item.content, createdAt: raw.createdAt })}`)
    const root = String(raw.conflictOf || item.id)
    if (!groups.has(root)) groups.set(root, new Map())
    const variants = groups.get(root), key = digest(item.content)
    if (!variants.has(key) || stable(item) < stable(variants.get(key))) variants.set(key, item)
  }
  const result = new Map()
  for (const [root, variants] of groups) {
    let first = true
    for (const [key, item] of [...variants].sort(([a], [b]) => a.localeCompare(b))) {
      const value = { ...item, id: first ? root : `${root.slice(0, 110)}-conflict-${key}` }
      if (!first) value.conflictOf = root
      else delete value.conflictOf
      result.set(value.id, value)
      first = false
    }
  }
  return [...result.values()].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id.localeCompare(b.id))
}
function mergeRows(left = [], right = [], options = {}) {
  const rows = new Map()
  for (const row of [...left, ...right]) {
    if (!row || typeof row !== 'object') continue
    const id = String(row.id || row._id || `legacy-${digest(row)}`)
    rows.set(id, rows.has(id) ? mergeRecord(rows.get(id), { ...row, id }, options) : { ...row, id })
  }
  return [...rows.values()].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id.localeCompare(b.id))
}
function mergeRecord(local, incoming, options = {}) {
  if (!local) return { ...incoming }
  if (!incoming) return { ...local }
  let winner = options.prefer === 'local' ? local : incoming
  if (restores(local, incoming)) winner = local
  if (restores(incoming, local)) winner = incoming
  if (isDeleted(local) && !restores(incoming, local)) winner = local
  if (isDeleted(incoming) && !restores(local, incoming)) winner = incoming
  if (isDeleted(local) && isDeleted(incoming)) {
    if (local.restoreOf === deletionKey(incoming)) winner = local
    else if (incoming.restoreOf === deletionKey(local)) winner = incoming
    else {
      const localVersion = Number(local.cloudVersion || local.version || 0)
      const incomingVersion = Number(incoming.cloudVersion || incoming.version || 0)
      if (localVersion !== incomingVersion) winner = localVersion > incomingVersion ? local : incoming
      else winner = deletionKey(local) > deletionKey(incoming) ? local : incoming
    }
  }
  // Permanent removal is not undone by a stale soft-delete copy.
  if (local.deletedAt && isDeleted(incoming) && !incoming.deletedAt) winner = local
  if (incoming.deletedAt && isDeleted(local) && !local.deletedAt) winner = incoming
  const loser = winner === local ? incoming : local
  const result = { ...loser, ...winner }
  if (isDeleted(winner)) {
    result.deletionId = deletionKey(winner)
  } else if (restores(winner, loser)) {
    result.deletedAt = ''; result.trashedAt = ''; result.purgeAt = ''
  }
  for (const key of LIST_FIELDS) {
    if (Array.isArray(local[key]) || Array.isArray(incoming[key])) result[key] = mergeRows(local[key] || [], incoming[key] || [], options)
  }
  if (Array.isArray(local.manualInputs) || Array.isArray(incoming.manualInputs)) {
    result.manualInputs = mergeOriginals(local.manualInputs || [], incoming.manualInputs || [])
    result.inputRevision = inputRevision(result.manualInputs)
    if (result.manualInputs.length) {
      const organized = [winner, loser].find((row) => row.organizationRevision === result.inputRevision && String(row.summary || '').trim())
      if (organized) {
        for (const key of ['summary', 'organizationRevision', 'organizationStatus', 'organizedBy', 'synthesisSource', 'synthesisUpdatedAt']) {
          if (organized[key] !== undefined) result[key] = organized[key]
        }
      } else {
        Object.assign(result, { summary: `## 今日记录\n\n${result.manualInputs.map((item) => item.content).join('\n\n')}`, organizationStatus: 'pending', organizationRevision: '', organizedBy: 'rules', synthesisSource: 'rules' })
      }
    }
  }
  const changed = BODY_FIELDS.some((key) => local[key] !== undefined && incoming[key] !== undefined && stable(local[key]) !== stable(incoming[key]))
  const versions = mergeVersions(local.conflictVersions || [], incoming.conflictVersions || [], changed && (options.preserveConflicts !== false || isDeleted(winner)) ? [snapshot(local), snapshot(incoming)] : [])
  if (versions.length) result.conflictVersions = versions
  return result
}
function inputRevision(inputs) {
  return createHash('sha256').update(JSON.stringify((inputs || []).map(({ id, content }) => ({ id, content })).sort((a, b) => a.id.localeCompare(b.id)))).digest('hex')
}
function syncMetadata(row) {
  return Object.fromEntries(['deletedAt', 'trashedAt', 'purgeAt', 'trashOrigin', 'deletionId', 'restoreId', 'restoreOf', 'restoredAt', 'conflictVersions'].filter((key) => row && row[key] !== undefined).map((key) => [key, row[key]]))
}
module.exports = { mergeRecord, mergeRows, mergeOriginals, mergeVersions, deletionKey, restoreMarker, restores, isDeleted, syncMetadata, inputRevision }
