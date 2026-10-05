'use strict'
const { todoLineageId, todayTodoCarryId, todoIsDeleted } = require('./todo-lineage')

// Read both source and target inside the same transaction. A retried or racing
// rollover must not replace a target edited/deleted by another device.
function createTodoStore({ db, buildCarried, now = () => new Date().toISOString() }) {
  const dataOf = (result) => Array.isArray(result.data) ? result.data[0] : result.data
  const error = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra })
  async function carry(owner, sourceId, date, rank, { baseVersion, automatic = false } = {}) {
    let discoveryReads = 0
    const collection = db.collection('daily_tasks')
    // CloudBase supports doc reads in transactions, not where queries.
    // Discover IDs first; every discovered record is re-read transactionally.
    const read = async (id) => { discoveryReads++; return dataOf(await collection.doc(id).get()) }
    const source = await read(sourceId)
    if (!source || source.ownerOpenId !== owner || source.entryKind !== 'today_todo') throw error('NOT_FOUND', '今日待办不存在')
    if (todoIsDeleted(source)) return { source, target: null, carried: false, reads: discoveryReads, writes: 0 }
    const ancestry = [source]
    let ancestor = source
    while (ancestor.carriedFromId && !ancestor.lineageId) {
      if (ancestry.length >= 256) throw error('LINEAGE_LIMIT', '待办历史链过长，已保留原记录，请先修复历史编号')
      if (ancestry.some((item) => item.id === ancestor.carriedFromId)) break
      const parent = await read(ancestor.carriedFromId)
      if (!parent) break
      if (parent.ownerOpenId !== owner) throw error('FORBIDDEN', '待办来源不属于当前空间')
      ancestry.push(parent)
      ancestor = parent
    }
    const root = todoLineageId(source, ancestry)
    const family = new Map(ancestry.map((item) => [item.id || item._id, item]))
    async function related(query) {
      discoveryReads++
      const result = await collection.where({ ownerOpenId: owner, ...query }).limit(1000).get()
      const rows = result.data || []
      // A bounded incomplete family cannot safely decide that a deleted
      // descendant does not exist. Leave originals intact on overflow.
      if (rows.length >= 1000) throw error('LINEAGE_LIMIT', '待办历史链需分批修复，未自动创建重复记录')
      for (const item of rows) family.set(item.id || item._id, item)
    }
    await related({ lineageId: root })
    // Legacy rows lack lineageId. Walk actual parent links, never titles.
    const visited = new Set()
    const pending = [root, ...ancestry.map((item) => item.id)]
    while (pending.length) {
      const id = pending.shift()
      if (!id || visited.has(id)) continue
      visited.add(id)
      if (visited.size > 256) throw error('LINEAGE_LIMIT', '待办历史链需分批修复，未自动创建重复记录')
      await related({ carriedFromId: id })
      for (const item of family.values()) {
        if (!item.lineageId && !visited.has(item.id)) pending.push(item.id)
      }
    }
    const targetId = todayTodoCarryId(root, date)
    if (family.size >= 256) throw error('LINEAGE_LIMIT', '待办历史链需分批修复，未自动创建重复记录')
    return db.runTransaction(async (tx) => {
      let reads = discoveryReads, writes = 0
      const collection = tx.collection('daily_tasks')
      const read = async (id) => { reads++; return dataOf(await collection.doc(id).get()) }
      const save = async (item) => { const { _id, ...data } = item; await collection.doc(item.id).set(data); writes++ }
      const currentFamily = new Map()
      for (const id of new Set([...family.keys(), targetId])) {
        const item = await read(id)
        if (item && item.ownerOpenId !== owner) throw error('FORBIDDEN', '待办不属于当前空间')
        if (item) currentFamily.set(id, item)
      }
      const source = currentFamily.get(sourceId)
      if (!source) throw error('NOT_FOUND', '今日待办不存在')
      if (todoIsDeleted(source)) return { source, target: null, carried: false, reads, writes }
      if (todoLineageId(source, [...currentFamily.values()]) !== root) throw error('CONFLICT', '待办来源已变化，请重试', { latest: source })
      const exactTarget = currentFamily.get(targetId)
      if (exactTarget && exactTarget.ownerOpenId !== owner) throw error('FORBIDDEN', '目标待办不属于当前空间')
      const members = [...currentFamily.values()].filter((item) => item.deferredTo !== 'duplicate_merged')
      const newest = [...members].sort((a, b) => String(b.date).localeCompare(String(a.date))
        || Number(todoIsDeleted(b) || b.status === 'done') - Number(todoIsDeleted(a) || a.status === 'done'))[0] || source
      let target = exactTarget || members.find((item) => item.date === date)
      const replay = source.status === 'postponed' && source.deferredTo === 'tomorrow' && Boolean(target)
      if (!automatic && !replay && baseVersion !== undefined && Number(source.version || 1) !== Number(baseVersion)) throw error('CONFLICT', '记录已在另一端更新', { latest: source })
      if (!automatic && source.status !== 'planned' && !replay) return { source, target, carried: false, reads, writes }
      const at = now()
      let carried = false
      if (!target && newest.date < date && newest.status === 'planned' && !todoIsDeleted(newest)) {
        target = buildCarried({ ...newest, lineageId: root }, owner, date, rank, at)
        await save(target)
        carried = true
      }
      // Only members known to belong to this lineage may be superseded.
      for (const item of members) {
        if (item.date >= date || item.status !== 'planned' || todoIsDeleted(item)) continue
        await save({ ...item, lineageId: root, status: 'postponed', deferredTo: target ? 'tomorrow' : 'lineage_superseded', pinned: false, priorityPinned: false, pinnedAt: '', updatedAt: at, version: Number(item.version || 1) + 1 })
      }
      return { source, target, carried, reads, writes }
    })
  }
  async function create(owner, todo) {
    return db.runTransaction(async (tx) => {
      const ref = tx.collection('daily_tasks').doc(todo.id)
      const current = dataOf(await ref.get())
      if (current) {
        if (current.ownerOpenId !== owner) throw error('FORBIDDEN', '待办编号不属于当前空间')
        if (current.title !== todo.title || current.date !== todo.date || String(current.rawInput || '') !== String(todo.rawInput || '')) throw error('INPUT_ID_CONFLICT', '待办编号已用于另一条内容，请保留本机输入')
        return current
      }
      const { _id, ...data } = { ...todo, lineageId: todo.id, ownerOpenId: owner, workspaceId: owner }
      await ref.set(data)
      return data
    })
  }
  async function patch(owner, id, changes, expectedVersion) {
    return db.runTransaction(async (tx) => {
      const ref = tx.collection('daily_tasks').doc(id)
      const current = dataOf(await ref.get())
      if (!current || current.ownerOpenId !== owner) throw error('NOT_FOUND', '今日待办不存在')
      if (todoIsDeleted(current)) {
        if (changes.status === 'removed') return current
        throw error('RECORD_DELETED', '待办已删除，请先从垃圾箱主动恢复', { retryable: false, latest: current })
      }
      if (expectedVersion !== undefined && Number(current.version || 1) !== Number(expectedVersion)) throw error('CONFLICT', '记录已在另一端更新', { latest: current })
      const { _id, ...next } = { ...current, ...changes, updatedAt: now(), version: Number(current.version || 1) + 1 }
      await ref.set(next)
      return next
    })
  }
  return { carry, create, patch }
}
module.exports = { createTodoStore }
