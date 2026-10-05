const { createOrganizationCoordinator } = require('./organization-coordinator')

function journalRows(cache) {
  const overview = cache.read(cache.KEYS.journal, {}) || {}
  const rows = Array.isArray(overview) ? [...overview] : [
    ...(overview.entries || []), ...(overview.favorites || []), ...(overview.hidden || []),
    ...(overview.history || []).flatMap((group) => group.entries || [])
  ]
  rows.push(...cache.read(cache.KEYS.journalArchive, []))
  const latest = new Map()
  for (const row of rows) if (row?.id && (!latest.has(row.id) || Number(row.version || 0) >= Number(latest.get(row.id).version || 0))) latest.set(row.id, row)
  return [...latest.values()]
}
function pendingJournalOperation(cache, id) {
  return cache.read(cache.KEYS.queue, []).some((item) => /^(journal|capture)\./.test(item.action || '') &&
    [item.payload?.id, item.payload?.entryId, item.payload?.captureId].includes(id))
}
function createJournalOrganization(options) {
  const { cache } = options
  return createOrganizationCoordinator({ ...options, capability: 'journalOrganization', identity: 'entryId', eventType: 'journal-organization',
    records: () => journalRows(cache), idOf: (row) => row.id, emptyRecord: () => null,
    revisionOf: (row) => String(row.rawContent ?? row.content ?? ''),
    hasSource: (row) => String(row.rawContent ?? row.content ?? '').trim(),
    eligible: (row) => row && row.organizationHost !== 'desktop' && !row.pending && !row.deletedAt && !row.trashedAt && !pendingJournalOperation(cache, row.id)
  })
}
module.exports = { createJournalOrganization, pendingJournalOperation }
