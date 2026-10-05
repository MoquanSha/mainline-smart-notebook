'use strict'

const crypto = require('crypto')
const { splitInputs } = require('./text-segments')

function inputRevision(inputs) {
  return crypto.createHash('sha256').update(JSON.stringify((inputs || []).map(({ id, content }) => ({ id, content })).sort((a, b) => a.id.localeCompare(b.id)))).digest('hex')
}

function validateDate(value) {
  const date = String(value || '')
  const parsed = new Date(`${date}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw Object.assign(new Error('日记日期无效，原文仍保留在本机'), { code: 'VALIDATION' })
  }
  return date
}

// Only persistence runs in a transaction. Network/AI requests must never hold
// the transaction open. The SDK retries a conflicting transaction callback.
function createDiaryStore({ db, dayId, legacyDayId, createDay, normalizeInputs, assertCapacity, now = () => new Date().toISOString() }) {
  async function read(tx, owner, date) {
    const ref = tx.collection('day_records').doc(dayId(owner, date))
    const result = await ref.get()
    let current = Array.isArray(result.data) ? result.data[0] : result.data
    if (current && (current.ownerOpenId !== owner || current.deletedAt)) {
      throw Object.assign(new Error('该日记已删除或不属于当前空间；原文仍保留在本机'), { code: 'FORBIDDEN' })
    }
    if (legacyDayId && !current?.legacyDiaryMigrated) {
      const legacyResult = await tx.collection('day_records').doc(legacyDayId(owner, date)).get()
      const legacy = Array.isArray(legacyResult.data) ? legacyResult.data[0] : legacyResult.data
      if (legacy && legacy.ownerOpenId !== owner) throw Object.assign(new Error('旧日记不属于当前空间'), { code: 'FORBIDDEN' })
      if (legacy?.deletedAt && !current) throw Object.assign(new Error('旧日记已删除，不能由离线写入自动恢复'), { code: 'FORBIDDEN' })
      if (legacy && !legacy.deletedAt) {
        const inputs = normalizeInputs([...(legacy.manualInputs || []), ...(current?.manualInputs || [])])
        const base = current || { ...legacy, id: `day_records_${date}` }
        const changedInputs = inputRevision(inputs) !== inputRevision(normalizeInputs(base.manualInputs))
        current = {
          ...base, manualInputs: inputs, legacyDiaryMigrated: true,
          inputRevision: inputRevision(inputs), updatedAt: now(), version: Number(base.version || 0) + 1,
          ...(changedInputs ? { summary: `## 今日记录\n\n${inputs.map((item) => item.content).join('\n\n')}`, organizationStatus: 'pending', organizationRevision: '', organizedBy: 'rules', synthesisSource: 'rules' } : {})
        }
        const { _id, ...document } = current
        // Keep the legacy document intact for recovery and older readers.
        if (assertCapacity) assertCapacity(document)
        await ref.set(document)
      }
    }
    return { ref, current }
  }

  async function append(owner, payload) {
    const date = validateDate(payload.date)
    const content = String(payload.content || '')
    const id = String(payload.inputId || payload.requestId || '')
    if (!content.trim() || !id || id.length > 160) throw Object.assign(new Error('原文或提交编号无效'), { code: 'VALIDATION' })
    const input = { id, content, createdAt: now(), source: 'wechat' }
    return db.runTransaction(async (tx) => {
      const { ref, current } = await read(tx, owner, date)
      const inputs = normalizeInputs(current && current.manualInputs)
      const existing = inputs.find((item) => item.id === id)
      if (existing) {
        if (existing.content !== content) throw Object.assign(new Error('提交编号已用于另一份原文，请保留两份内容后重新提交'), { code: 'INPUT_ID_CONFLICT' })
        return { day: current, acceptedInputId: id, replay: true }
      }
      const manualInputs = normalizeInputs([...inputs, input])
      const at = now()
      const next = {
        ...(current || createDay(owner, date)), manualInputs, legacyDiaryMigrated: true,
        summary: `## 今日记录\n\n${manualInputs.map((item) => item.content).join('\n\n')}`,
        organizationStatus: 'pending', organizedBy: 'rules', synthesisSource: 'rules',
        inputRevision: inputRevision(manualInputs), organizationRevision: '', aiError: '',
        updatedAt: at, version: Number(current && current.version || 0) + 1
      }
      const { _id, ...document } = next
      // Refuse oversized documents explicitly; never acknowledge a truncated
      // original. The client keeps its durable operation on this error.
      if (Buffer.byteLength(JSON.stringify(document), 'utf8') > 800000) throw Object.assign(new Error('当天原文超过当前存储容量，已保留本机原文，请导出后分日保存'), { code: 'DIARY_CAPACITY' })
      await ref.set(document)
      return { day: document, acceptedInputId: id, replay: false }
    })
  }

  async function commitOrganization(owner, date, expected, patch) {
    validateDate(date)
    return db.runTransaction(async (tx) => {
      const { ref, current } = await read(tx, owner, date)
      if (!current || Number(current.version || 0) !== Number(expected.version || 0) || inputRevision(normalizeInputs(current.manualInputs)) !== expected.inputRevision) {
        return { day: current, stale: true }
      }
      const next = {
        ...current, ...patch, manualInputs: current.manualInputs,
        inputRevision: expected.inputRevision, organizationRevision: expected.inputRevision,
        updatedAt: now(), version: Number(current.version || 0) + 1
      }
      const { _id, ...document } = next
      if (Buffer.byteLength(JSON.stringify(document), 'utf8') > 800000) throw Object.assign(new Error('整理结果超过当前存储容量，原文已安全保存'), { code: 'DIARY_CAPACITY' })
      await ref.set(document)
      return { day: document, stale: false }
    })
  }

  async function ensure(owner, date) {
    validateDate(date)
    return db.runTransaction(async (tx) => {
      const { ref, current } = await read(tx, owner, date)
      if (current) return current
      const day = { ...createDay(owner, date), manualInputs: [], version: 1, inputRevision: inputRevision([]), legacyDiaryMigrated: true }
      await ref.set(day)
      return day
    })
  }

  return { append, commitOrganization, ensure }
}

module.exports = { createDiaryStore, inputRevision, splitInputs, validateDate }
