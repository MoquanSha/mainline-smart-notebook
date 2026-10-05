'use strict'

const crypto = require('crypto')
const TRACKED = new Set(['tasks', 'daily_tasks', 'captures', 'day_records'])
const dataOf = (result) => Array.isArray(result && result.data) ? result.data[0] : result && result.data
const headId = (owner) => 'sync_head_' + crypto.createHash('sha256').update(owner).digest('hex').slice(0, 32)

async function readHead(db, owner) {
  const value = dataOf(await db.collection('sync_signals').doc(headId(owner)).get())
  return { workspaceId: owner, sequence: Number(value && value.sequence || 0), channelId: headId(owner) }
}

// Assign a workspace-monotonic sequence inside the SAME transaction as each
// business write. Wall clocks, IDs, and post-write signals cannot safely serve
// as incremental cursors. A later commit always has a higher sequence.
// This is shared by every deployed business writer, including old-client APIs.
function withSyncSequence(raw) {
  function transaction(callback) {
    return raw.runTransaction(async (native) => {
      const heads = new Map()
      const observed = new Map()
      const allocate = async (owner) => {
        if (!owner || typeof owner !== 'string') throw Object.assign(new Error('同步记录缺少空间归属'), { code: 'WORKSPACE_REQUIRED' })
        if (!heads.has(owner)) heads.set(owner, (async () => {
          const ref = native.collection('sync_signals').doc(headId(owner))
          const current = dataOf(await ref.get()) || {}
          return { ref, data: { ...current, id: headId(owner), kind: 'sync_head', ownerOpenId: owner, workspaceId: owner,
            sequence: Number(current.sequence || 0), deletedAt: '' } }
        })())
        const head = await heads.get(owner)
        if (!Number.isSafeInteger(head.data.sequence) || head.data.sequence < 0 || head.data.sequence >= Number.MAX_SAFE_INTEGER) {
          throw Object.assign(new Error('同步序号需要修复，未确认本次写入'), { code: 'SYNC_SEQUENCE_INVALID' })
        }
        head.data.sequence++
        head.data.revision = 'sequence-' + head.data.sequence
        head.data.updatedAt = new Date().toISOString()
        return head.data.sequence
      }
      const trackedDoc = (name, id) => {
        const ref = native.collection(name).doc(id), key = name + '/' + id
        const get = async () => { const result = await ref.get(); observed.set(key, dataOf(result)); return result }
        return new Proxy(ref, { get(target, field) {
          if (field === 'get') return get
          if (field === 'set') return async (data) => {
            const owner = data.ownerOpenId
            const sequence = await allocate(owner)
            const { _id, ...document } = data
            const next = { ...document, _syncSequence: sequence }
            const result = await ref.set(next)
            observed.set(key, next)
            return result
          }
          if (field === 'update') return async (patch) => {
            if (!observed.has(key)) await get()
            const current = observed.get(key)
            if (!current) return { updated: 0 }
            const sequence = await allocate(patch.ownerOpenId || current.ownerOpenId)
            const result = await ref.update({ ...patch, _syncSequence: sequence })
            // Do not pretend SDK increment/remove commands are ordinary values.
            observed.delete(key)
            return result
          }
          if (field === 'remove') return () => { throw Object.assign(new Error('同步记录必须保留删除标记'), { code: 'TOMBSTONE_REQUIRED' }) }
          const value = Reflect.get(target, field)
          return typeof value === 'function' ? value.bind(target) : value
        } })
      }
      const wrapped = new Proxy(native, { get(target, field) {
        if (field === 'collection') return (name) => {
          const collection = native.collection(name)
          if (!TRACKED.has(name)) return collection
          return new Proxy(collection, { get(target, field) {
            if (field === 'doc') return (id) => trackedDoc(name, id)
            const value = Reflect.get(target, field)
            return typeof value === 'function' ? value.bind(target) : value
          } })
        }
        const value = Reflect.get(target, field)
        return typeof value === 'function' ? value.bind(target) : value
      } })
      const result = await callback(wrapped)
      for (const promise of heads.values()) {
        const head = await promise
        await head.ref.set(head.data)
      }
      return result
    })
  }
  async function updateWhere(name, query, patch) {
    // Existing bulk paths use an equality owner filter. Discover bounded pages
    // outside the transaction, then re-check each row inside it.
    if (Object.values(query).some((value) => typeof value === 'object' && value !== null)) {
      throw Object.assign(new Error('批量修改需显式分页'), { code: 'BULK_QUERY_UNSUPPORTED' })
    }
    let after = '', updated = 0
    for (;;) {
      const filter = { ...query, ...(after ? { _id: raw.command.gt(after) } : {}) }
      const rows = (await raw.collection(name).where(filter).orderBy('_id', 'asc').limit(50).get()).data || []
      for (const row of rows) {
        const id = row._id || row.id
        updated += await transaction(async (tx) => {
          const ref = tx.collection(name).doc(id), current = dataOf(await ref.get())
          if (!current || !Object.entries(query).every(([key, value]) => current[key] === value)) return 0
          const result = await ref.update(patch)
          return Number(result.updated || result.stats && result.stats.updated || 0)
        })
        after = id
      }
      if (rows.length < 50) return { updated }
    }
  }
  async function backfillOrdered(owner, options = {}) {
    if (!owner || typeof owner !== 'string') throw Object.assign(new Error('回填缺少空间归属'), { code: 'WORKSPACE_REQUIRED' })
    const collection = String(options.collection || '')
    if (!TRACKED.has(collection)) throw Object.assign(new Error('不支持回填该集合'), { code: 'VALIDATION' })
    const after = String(options.after || '')
    if (after.length > 256) throw Object.assign(new Error('回填游标无效'), { code: 'HISTORY_CURSOR_INVALID' })
    const limit = Math.max(1, Math.min(100, Math.floor(Number(options.limit) || 100)))
    const filter = { ownerOpenId: owner }
    if (after) filter._id = raw.command.gt(after)
    const result = await raw.collection(collection).where(filter).orderBy('_id', 'asc').limit(limit).get()
    const rows = result.data || []
    let updated = 0
    for (const row of rows) {
      const id = String(row._id || row.id || '')
      if (!id) continue
      if (Number.isSafeInteger(row._syncSequence) && row._syncSequence >= 0) continue
      const changed = await transaction(async (tx) => {
        const ref = tx.collection(collection).doc(id)
        const current = dataOf(await ref.get())
        if (!current || current.ownerOpenId !== owner) return false
        if (Number.isSafeInteger(current._syncSequence) && current._syncSequence >= 0) return false
        // Updating an unchanged visible timestamp lets the shared transaction
        // adapter attach exactly one sequence without changing user content.
        await ref.update({ updatedAt: current.updatedAt || new Date().toISOString() })
        return true
      })
      if (changed) updated += 1
    }
    const nextAfter = rows.length ? String(rows[rows.length - 1]._id || rows[rows.length - 1].id || after) : after
    return { collection, ownerOpenId: owner, scanned: rows.length, updated, nextAfter, hasMore: rows.length >= limit }
  }
  return new Proxy(raw, { get(target, field) {
    if (field === 'runTransaction') return transaction
    if (field === 'backfillOrdered') return backfillOrdered
    if (field === 'collection') return (name) => {
      const collection = raw.collection(name)
      if (!TRACKED.has(name)) return collection
      return new Proxy(collection, { get(target, field) {
        if (field === 'doc') return (id) => {
          const ref = collection.doc(id)
          return new Proxy(ref, { get(target, field) {
            if (['set', 'update', 'remove'].includes(field)) return (...args) => transaction((tx) => tx.collection(name).doc(id)[field](...args))
            const value = Reflect.get(target, field)
            return typeof value === 'function' ? value.bind(target) : value
          } })
        }
        if (field === 'where') return (query) => {
          const selection = collection.where(query)
          return new Proxy(selection, { get(target, field) {
            if (field === 'update') return (patch) => updateWhere(name, query, patch)
            if (field === 'remove') return () => { throw Object.assign(new Error('同步记录必须保留删除标记'), { code: 'TOMBSTONE_REQUIRED' }) }
            const value = Reflect.get(target, field)
            return typeof value === 'function' ? value.bind(target) : value
          } })
        }
        if (field === 'add') return () => { throw Object.assign(new Error('同步写入需要稳定记录编号'), { code: 'STABLE_ID_REQUIRED' }) }
        const value = Reflect.get(target, field)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    }
    const value = Reflect.get(target, field)
    return typeof value === 'function' ? value.bind(target) : value
  } })
}

module.exports = { withSyncSequence, readHead, headId }
