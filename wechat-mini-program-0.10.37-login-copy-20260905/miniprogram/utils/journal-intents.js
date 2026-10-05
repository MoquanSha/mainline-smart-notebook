const history = require('./sync-history')
const { sameScope } = require('./queue-identity')
const { updateChecklistMarkdown } = require('./journal-markdown')
const ACTIONS = new Set(['journal.create', 'journal.append', 'journal.toggleItem', 'journal.archive', 'journal.restore',
  'journal.delete', 'capture.delete', 'capture.setFavorite', 'capture.hide', 'capture.restoreHidden'])
const deleted = (row) => row && (row.deletedAt || row.trashedAt || row.permanentlyPurgedAt)
const key = (row) => String(row?.id || row?._id || '')
const flatten = (journal, archive, date) => history.snapshotRecords({ journal, journalArchive: archive, date }).captures
const clearSync = ({ syncPending, syncBlocked, syncError, ...row }) => row

function projectJournal({ journal = {}, archive = [], localJournal = journal, localArchive = archive,
  queue = [], records = [], date, scope }) {
  const active = queue.filter((item) => ACTIONS.has(item.action) && (!scope || sameScope(scope, item.scope)))
  if (!records.length && !active.length) {
    // Older servers own their pre-grouped view contract. With no local intent
    // or new receipt, do not regroup an undated legacy response by our clock.
    const clean = { ...journal }
    for (const field of ['entries', 'favorites', 'hidden']) if (Array.isArray(clean[field])) clean[field] = clean[field].map(clearSync)
    if (Array.isArray(clean.history)) clean.history = clean.history.map((group) => ({ ...group, entries: (group.entries || []).map(clearSync) }))
    return { journal: clean, archive: archive.map(clearSync), tombstones: [] }
  }
  const received = history.mergeRows(flatten(journal, archive, date), records)
  const rows = new Map(received.map((row) => [key(row), clearSync(row)]))
  const local = new Map(flatten(localJournal, localArchive, date).map((row) => [key(row), row]))
  for (const operation of active) {
    const payload = operation.payload || {}, id = String(payload.entryId || payload.id || payload.captureId || '')
    if (!id) continue
    const at = operation.createdAt || payload.occurredAt || '', action = operation.action
    let row = rows.get(id) || local.get(id)
    // A stale edit cannot resurrect a received tombstone. The queued original
    // remains available for explicit recovery even when its target is deleted.
    if (deleted(row)) continue
    if (action === 'journal.create') {
      if (!row) row = { id, entryKind: 'journal_entry', rawContent: String(payload.content || ''), content: String(payload.content || ''),
        journalDate: payload.date || history.shanghaiDateFromValue(payload.occurredAt || at) || date,
        occurredAt: payload.occurredAt || at, source: payload.source || 'manual', pending: true,
        checklistItems: [], favoritedAt: payload.favorite ? at : '', hiddenAt: '' }
    } else if (!row) continue
    if (action === 'journal.toggleItem') {
      const before = row.checklistItems || [], after = before.map((item) => item.id === payload.itemId ? { ...item, done: Boolean(payload.done) } : item)
      row = { ...row, checklistItems: after }
      for (const field of ['markdown', 'organizedContent']) if (row[field]) row[field] = updateChecklistMarkdown(row[field], before, after)
    } else if (action === 'journal.append') {
      const id = payload.supplementId || operation.id, supplements = [...(row.journalSupplements || [])]
      const existing = supplements.find((item) => item.id === id)
      if (!existing) supplements.push({ id, content: String(payload.content || ''), createdAt: payload.createdAt || at, source: 'wechat', pending: true })
      else if (existing.content !== payload.content && !supplements.some((item) => item.id === id + '-local-' + operation.id)) {
        supplements.push({ id: id + '-local-' + operation.id, conflictOf: id, content: String(payload.content || ''), createdAt: at, pending: true })
      }
      row = { ...row, journalSupplements: supplements }
    } else if (action === 'capture.setFavorite') row = { ...row, favoritedAt: payload.favorited ? at : '', ...(payload.favorited ? { hiddenAt: '' } : {}) }
    else if (action === 'capture.hide') row = { ...row, hiddenAt: at }
    else if (action === 'capture.restoreHidden') row = { ...row, hiddenAt: '' }
    else if (action === 'journal.archive') row = { ...row, journalArchived: true, archivedAt: at }
    else if (action === 'journal.restore') row = { ...row, journalArchived: false, archivedAt: '', journalDate: payload.date || date }
    else if (action === 'journal.delete') row = { ...row, trashedAt: at || 'pending-delete' }
    else if (action === 'capture.delete') row = { ...row, deletedAt: at || 'pending-delete' }
    rows.set(id, { ...row, syncPending: true, syncBlocked: row.syncBlocked || operation.status === 'blocked',
      syncError: operation.lastError || row.syncError || '' })
  }
  const projected = history.project({ captures: [...rows.values()] }, date)
  return { journal: { ...journal, ...projected.journal,
    ...(journal.reviews || journal.dailyReviews || localJournal.reviews ? { reviews: journal.reviews || journal.dailyReviews || localJournal.reviews } : {}) }, archive: projected.journalArchive,
    // Only received deletions become durable authority. Local delete intentions
    // remain in the queue until a server receipt confirms them.
    tombstones: received.filter(deleted) }
}

module.exports = { projectJournal, supportsJournalIntent: (action) => ACTIONS.has(action) }
