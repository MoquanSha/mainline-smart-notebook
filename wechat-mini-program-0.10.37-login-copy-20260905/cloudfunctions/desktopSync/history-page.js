'use strict'
const { readHead } = require('./sync-database')

const COLLECTIONS = ['tasks', 'daily_tasks', 'captures', 'day_records']

function createHistoryPager({ db, serialize }) {
  return async function page(workspaceId, options = {}) {
    const head = options.cursor ? null : await readHead(db, workspaceId)
    const cursor = options.cursor || { version: 2, workspaceId, collection: 0, after: '', changeAfter: head.sequence }
    if (cursor.workspaceId !== workspaceId) throw Object.assign(new Error('历史游标不属于当前空间'), { code: 'WORKSPACE_MISMATCH', retryable: false })
    if (![1, 2].includes(cursor.version) || !Number.isInteger(cursor.collection) || cursor.collection < 0 || cursor.collection > COLLECTIONS.length || typeof cursor.after !== 'string' || cursor.after.length > 256 || cursor.version === 2 && (!Number.isSafeInteger(cursor.changeAfter) || cursor.changeAfter < 0)) {
      throw Object.assign(new Error('历史游标无效，已收到的内容仍保留'), { code: 'HISTORY_CURSOR_INVALID', retryable: false })
    }
    if (cursor.collection === COLLECTIONS.length) return { records: [], nextCursor: cursor, hasMore: false, quota: { functionCalls: 1, businessReadQueries: 0, returnedDocuments: 0, writes: 0 } }
    const limit = Math.max(1, Math.min(99, Math.floor(Number(options.limit) || 99)))
    const collection = COLLECTIONS[cursor.collection]
    const filter = { ownerOpenId: workspaceId }
    if (collection === 'daily_tasks') filter.entryKind = 'today_todo'
    if (collection === 'captures') filter.entryKind = 'journal_entry'
    if (cursor.after) filter._id = db.command.gt(cursor.after)
    // Stable document IDs, never mutable offsets or user-provided dates. Deleted
    // rows stay in this feed so a phone can remove an older cached copy.
    const result = await db.collection(collection).where(filter).orderBy('_id', 'asc').limit(limit + 1).get()
    const rows = result.data || [], records = []
    let consumed = 0, bytes = 0, after = cursor.after
    for (const row of rows.slice(0, limit)) {
      const document = serialize(collection, row)
      const entry = document ? { collection, document } : null
      const size = entry ? Buffer.byteLength(JSON.stringify(entry), 'utf8') : 0
      if (consumed && bytes + size > 600000) break
      if (size > 950000) throw Object.assign(new Error('单条历史记录超过传输容量，游标尚未前进'), { code: 'RECORD_CAPACITY', retryable: false })
      if (entry) records.push(entry)
      bytes += size
      after = String(row._id || row.id)
      consumed++
    }
    const moreInCollection = rows.length > consumed
    const nextCursor = { ...cursor, collection: cursor.collection + (moreInCollection ? 0 : 1), after: moreInCollection ? after : '' }
    return { records, nextCursor, hasMore: nextCursor.collection < COLLECTIONS.length,
      quota: { functionCalls: 1, metadataReads: head ? 1 : 0, businessReadQueries: 1, returnedDocuments: rows.length, payloadBytes: bytes, writes: 0 } }
  }
}

function createChangePager({ db, serialize }) {
  return async function page(workspaceId, options = {}) {
    const head = options.cursor ? null : await readHead(db, workspaceId)
    const from = Number(options.after || 0)
    const cursor = options.cursor || { version: 2, workspaceId, from, through: head.sequence, collection: 0, after: from }
    if (cursor.workspaceId !== workspaceId) throw Object.assign(new Error('增量游标不属于当前空间'), { code: 'WORKSPACE_MISMATCH', retryable: false })
    if (cursor.version !== 2 || ![cursor.from, cursor.through, cursor.after, cursor.collection].every(Number.isSafeInteger) || cursor.from < 0 || cursor.after < cursor.from || cursor.after > cursor.through || cursor.collection < 0 || cursor.collection > COLLECTIONS.length) {
      throw Object.assign(new Error('增量游标无效，已收到的记录仍保留'), { code: 'CHANGE_CURSOR_INVALID', retryable: false })
    }
    const quota = { functionCalls: 1, metadataReads: head ? 1 : 0, businessReadQueries: 0, returnedDocuments: 0, payloadBytes: 0, writes: 0 }
    if (cursor.collection === COLLECTIONS.length || cursor.from === cursor.through) return { records: [], nextCursor: { ...cursor, collection: COLLECTIONS.length }, hasMore: false, quota }
    const limit = Math.max(1, Math.min(99, Math.floor(Number(options.limit) || 99)))
    const collection = COLLECTIONS[cursor.collection]
    const result = await db.collection(collection).where({ ownerOpenId: workspaceId, _syncSequence: db.command.gt(cursor.after).and(db.command.lte(cursor.through)) }).orderBy('_syncSequence', 'asc').limit(limit + 1).get()
    const rows = result.data || [], records = []
    let consumed = 0, after = cursor.after
    for (const row of rows.slice(0, limit)) {
      const document = serialize(collection, row)
      const entry = document ? { collection, document } : null
      const bytes = entry ? Buffer.byteLength(JSON.stringify(entry), 'utf8') : 0
      if (consumed && quota.payloadBytes + bytes > 600000) break
      if (bytes > 950000) throw Object.assign(new Error('单条记录超过传输容量，增量进度未前进'), { code: 'RECORD_CAPACITY', retryable: false })
      if (entry) records.push(entry)
      quota.payloadBytes += bytes; consumed++; after = row._syncSequence
    }
    quota.businessReadQueries = 1; quota.returnedDocuments = rows.length
    const more = rows.length > consumed
    const nextCursor = { ...cursor, collection: cursor.collection + (more ? 0 : 1), after: more ? after : cursor.from }
    return { records, nextCursor, hasMore: nextCursor.collection < COLLECTIONS.length, quota }
  }
}

module.exports = { createHistoryPager, createChangePager, COLLECTIONS }
