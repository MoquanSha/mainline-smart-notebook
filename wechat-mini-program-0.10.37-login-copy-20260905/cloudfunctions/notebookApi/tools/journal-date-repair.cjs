'use strict'

// This tool is deliberately outside the normal request path. It is for an
// owner-scoped, reviewable migration of legacy journal rows whose journalDate
// is missing. Preview is the default; apply and rollback both require an
// explicit plan digest and keep a complete JSON backup before the first write.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const COLLECTION = 'captures'
const PAGE_SIZE = 100
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function dateFromValue(value) {
  const explicit = String(value || '')
  if (DATE_RE.test(explicit)) return explicit
  const timestamp = Date.parse(explicit)
  if (!Number.isFinite(timestamp)) return ''
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(timestamp))
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function digest(value) {
  return crypto.createHash('sha256').update(stable(value)).digest('hex')
}

function planForRows(rows, ownerOpenId) {
  const candidates = []
  const skipped = []
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.entryKind !== 'journal_entry' || row.ownerOpenId !== ownerOpenId) continue
    const id = String(row.id || row._id || '')
    if (!id) { skipped.push({ reason: 'missing-id' }); continue }
    if (DATE_RE.test(String(row.journalDate || ''))) continue
    const inferred = dateFromValue(row.journalDate || row.occurredAt || row.createdAt)
    if (!inferred) { skipped.push({ id, reason: 'missing-date-source' }); continue }
    candidates.push({
      id,
      before: { journalDate: String(row.journalDate || ''), version: Number(row.version || 1), updatedAt: String(row.updatedAt || '') },
      after: { journalDate: inferred },
      source: String(row.occurredAt || row.createdAt || '')
    })
  }
  const body = { version: 1, collection: COLLECTION, ownerOpenId, candidates, skipped }
  return { ...body, digest: digest(body) }
}

function verifyPlan(plan, ownerOpenId) {
  if (!plan || plan.version !== 1 || plan.collection !== COLLECTION || plan.ownerOpenId !== ownerOpenId || digest({
    version: plan.version, collection: plan.collection, ownerOpenId: plan.ownerOpenId,
    candidates: plan.candidates, skipped: plan.skipped
  }) !== plan.digest) throw new Error('迁移计划摘要不匹配，已停止写入')
}

function backupForRows(rows, plan) {
  const byId = new Map((rows || []).map((row) => [String(row.id || row._id || ''), row]))
  return {
    version: 1, createdAt: new Date().toISOString(), collection: COLLECTION,
    ownerOpenId: plan.ownerOpenId, planDigest: plan.digest,
    rows: plan.candidates.map((candidate) => byId.get(candidate.id)).filter(Boolean)
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

async function readRows(db, ownerOpenId) {
  const rows = []
  let after = ''
  for (;;) {
    const query = { ownerOpenId, entryKind: 'journal_entry', ...(after ? { _id: db.command.gt(after) } : {}) }
    const result = await db.collection(COLLECTION).where(query).orderBy('_id', 'asc').limit(PAGE_SIZE).get()
    const page = result.data || []
    rows.push(...page)
    if (page.length < PAGE_SIZE) return rows
    const next = String(page[page.length - 1]._id || page[page.length - 1].id || '')
    if (!next || next <= after) throw new Error('读取游标没有前进，已停止迁移')
    after = next
  }
}

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) continue
    const key = value.slice(2)
    args[key] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true
  }
  return args
}

async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const mode = String(args.mode || 'preview')
  const ownerOpenId = String(args.owner || '')
  const planFile = String(args.plan || '')
  const backupFile = String(args.backup || '')
  if (!ownerOpenId || !['preview', 'apply', 'rollback'].includes(mode)) throw new Error('需要 --owner 和 --mode preview|apply|rollback')
  if ((mode === 'preview' && !planFile) || (mode !== 'preview' && (!planFile || !backupFile || args.confirm !== true && args.confirm !== 'true'))) {
    throw new Error('预览需要 --plan；写入或回滚还需要 --backup 和 --confirm true')
  }

  const tcb = require('@cloudbase/node-sdk')
  const env = process.env.CLOUDBASE_ENV_ID || process.env.TCB_ENV || 'YOUR_CLOUDBASE_ENV_ID'
  const app = tcb.init({ env, ...(process.env.TCB_SECRET_ID && process.env.TCB_SECRET_KEY ? { secretId: process.env.TCB_SECRET_ID, secretKey: process.env.TCB_SECRET_KEY } : {}) })
  const raw = app.database()
  const { withSyncSequence } = require('../sync-database')
  const db = withSyncSequence(raw)

  if (mode === 'rollback') {
    const backup = JSON.parse(fs.readFileSync(backupFile, 'utf8'))
    if (backup.version !== 1 || backup.ownerOpenId !== ownerOpenId || backup.collection !== COLLECTION) throw new Error('备份归属或版本不匹配')
    const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'))
    verifyPlan(plan, ownerOpenId)
    if (backup.planDigest !== plan.digest) throw new Error('备份与迁移计划不匹配')
    const planned = new Map(plan.candidates.map((candidate) => [candidate.id, candidate]))
    let restored = 0
    for (const row of backup.rows || []) {
      const id = String(row._id || row.id || '')
      if (!id) continue
      const candidate = planned.get(id)
      const currentResult = await db.collection(COLLECTION).doc(id).get()
      const current = Array.isArray(currentResult.data) ? currentResult.data[0] : currentResult.data
      if (!candidate || !current || current.ownerOpenId !== ownerOpenId || current.journalDate !== candidate.after.journalDate) continue
      await db.collection(COLLECTION).doc(id).update({ journalDate: String(row.journalDate || ''), updatedAt: new Date().toISOString() })
      restored += 1
    }
    return { mode, restored, ownerOpenId, planDigest: plan.digest }
  }

  if (mode === 'preview') {
    const rows = await readRows(db, ownerOpenId)
    const plan = planForRows(rows, ownerOpenId)
    writeJson(planFile, plan)
    return { mode, scanned: rows.length, candidates: plan.candidates.length, skipped: plan.skipped.length, planDigest: plan.digest }
  }
  // Apply consumes the reviewed preview file. It never regenerates the plan,
  // so a changed dataset cannot silently turn a preview into authorization.
  const suppliedPlan = JSON.parse(fs.readFileSync(planFile, 'utf8'))
  verifyPlan(suppliedPlan, ownerOpenId)
  const rows = await readRows(db, ownerOpenId)
  const backup = backupForRows(rows, suppliedPlan)
  writeJson(backupFile, backup)
  let applied = 0
  for (const candidate of suppliedPlan.candidates) {
    const current = await db.collection(COLLECTION).doc(candidate.id).get()
    const row = Array.isArray(current.data) ? current.data[0] : current.data
    if (!row || row.ownerOpenId !== ownerOpenId || row.entryKind !== 'journal_entry' || DATE_RE.test(String(row.journalDate || ''))) continue
    await db.collection(COLLECTION).doc(candidate.id).update({ journalDate: candidate.after.journalDate, updatedAt: new Date().toISOString() })
    applied += 1
  }
  return { mode, scanned: rows.length, applied, backupFile, planDigest: suppliedPlan.digest }
}

if (require.main === module) runCli().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => { console.error(error.message); process.exitCode = 1 })

module.exports = { dateFromValue, planForRows, verifyPlan, backupForRows, parseArgs }

