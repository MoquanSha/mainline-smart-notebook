'use strict'

const tcb = require('@cloudbase/node-sdk')
const crypto = require('crypto')

const ENV_ID = process.env.CLOUDBASE_ENV_ID || process.env.TCB_ENV || process.env.SCF_NAMESPACE || 'YOUR_CLOUDBASE_ENV_ID'
const app = tcb.init({ env: ENV_ID, timeout: 90000 })
const db = app.database()
const TRACKED = new Set(['tasks', 'daily_tasks', 'captures', 'day_records'])
const CONFIRM = 'MAINLINE_RELIABILITY_BACKFILL_20260925'

function dataOf(result) {
  return Array.isArray(result && result.data) ? result.data[0] : result && result.data
}

function headId(owner) {
  return 'sync_head_' + crypto.createHash('sha256').update(owner).digest('hex').slice(0, 32)
}

function nowIso() { return new Date().toISOString() }

function validSequence(value) {
  return Number.isSafeInteger(value) && value >= 0
}

async function requireWorkspace(owner) {
  const result = await db.collection('workspaces').doc(owner).get()
  const workspace = dataOf(result)
  if (!workspace || workspace.id !== owner || workspace.status !== 'active' || workspace.deletedAt) {
    throw Object.assign(new Error('迁移目标空间不存在或已停用'), { code: 'WORKSPACE_INVALID' })
  }
  return workspace
}

async function backfillPage({ owner, collection, after = '', limit = 25 }) {
  await requireWorkspace(owner)
  if (!TRACKED.has(collection)) throw Object.assign(new Error('不支持回填该集合'), { code: 'COLLECTION_INVALID' })
  if (String(after).length > 256) throw Object.assign(new Error('回填游标无效'), { code: 'CURSOR_INVALID' })
  const pageLimit = Math.max(1, Math.min(25, Math.floor(Number(limit) || 25)))
  const filter = { ownerOpenId: owner }
  if (after) filter._id = db.command.gt(String(after))
  const result = await db.collection(collection).where(filter).orderBy('_id', 'asc').limit(pageLimit).get()
  const rows = result.data || []
  let updated = 0
  let skipped = 0
  for (const row of rows) {
    const id = String(row._id || row.id || '')
    if (!id) { skipped += 1; continue }
    const outcome = await db.runTransaction(async (tx) => {
      const ref = tx.collection(collection).doc(id)
      const current = dataOf(await ref.get())
      if (!current || current.ownerOpenId !== owner) return 'skip'
      if (validSequence(current._syncSequence)) return 'skip'

      const headRef = tx.collection('sync_signals').doc(headId(owner))
      const head = dataOf(await headRef.get()) || {}
      const sequence = Number(head.sequence || 0)
      if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= Number.MAX_SAFE_INTEGER) {
        throw Object.assign(new Error('同步序号头无效，迁移已停止'), { code: 'SYNC_SEQUENCE_INVALID' })
      }
      const next = sequence + 1
      const at = nowIso()
      await ref.update({
        updatedAt: current.updatedAt || at,
        _syncSequence: next
      })
      const { _id: ignoredHeadId, ...headDocument } = head
      await headRef.set({
        ...headDocument,
        id: headId(owner),
        kind: 'sync_head',
        ownerOpenId: owner,
        workspaceId: owner,
        sequence: next,
        revision: `sequence-${next}`,
        updatedAt: at,
        deletedAt: ''
      })
      return 'updated'
    })
    if (outcome === 'updated') updated += 1
    else skipped += 1
  }
  const nextAfter = rows.length ? String(rows[rows.length - 1]._id || rows[rows.length - 1].id || after) : String(after)
  return {
    environmentId: ENV_ID,
    ownerOpenId: owner,
    collection,
    scanned: rows.length,
    updated,
    skipped,
    nextAfter,
    hasMore: rows.length >= pageLimit
  }
}

exports.main = async (event = {}) => {
  try {
    if (String(event.confirm || '') !== CONFIRM) {
      throw Object.assign(new Error('迁移确认标记不正确'), { code: 'MIGRATION_CONFIRM_REQUIRED' })
    }
    const owner = String(event.owner || '')
    const collection = String(event.collection || '')
    return { ok: true, data: await backfillPage({ owner, collection, after: String(event.after || ''), limit: event.limit }) }
  } catch (error) {
    return { ok: false, error: { code: error.code || 'MIGRATION_FAILED', message: String(error.message || error).slice(0, 300) } }
  }
}

exports.__test = { validSequence, headId, backfillPage }

