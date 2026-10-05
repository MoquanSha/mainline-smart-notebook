'use strict'

const crypto = require('crypto')
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  return value
}
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const dataOf = (result) => Array.isArray(result?.data) ? result.data[0] : result?.data

function identity(owner, requestId, action, payload = {}, actor = owner) {
  if (!requestId) return null
  if (typeof requestId !== 'string' || requestId.length > 512) {
    throw Object.assign(new Error('操作编号无效，未确认本次写入'), { code: 'VALIDATION' })
  }
  // The precondition may advance after an explicit conflict response; it does
  // not change the user's intended operation. All actual input stays bound.
  const { baseVersion, requestId: embeddedRequestId, ...intent } = payload
  return { id: 'operation_v2_' + digest([owner, actor, requestId]).slice(0, 48),
    ownerOpenId: owner, actor, requestId, action, fingerprint: digest(canonical({ action, payload: intent })) }
}

async function read(db, expected) {
  if (!expected) return null
  const saved = dataOf(await db.collection('sync_state').doc(expected.id).get())
  if (!saved) return null
  if (saved.ownerOpenId !== expected.ownerOpenId || saved.actor !== expected.actor ||
      saved.action !== expected.action || saved.fingerprint !== expected.fingerprint) {
    throw Object.assign(new Error('同一操作编号对应不同内容，原有内容已保留，请重新提交'), { code: 'INPUT_ID_CONFLICT' })
  }
  return saved
}

async function write(tx, expected, result) {
  if (!expected) return
  const at = new Date().toISOString()
  const receipt = { ...expected, result, createdAt: at, updatedAt: at, version: 1, deletedAt: '', source: 'wechat' }
  if (Buffer.byteLength(JSON.stringify(receipt), 'utf8') > 900000) {
    throw Object.assign(new Error('写入回执超过当前容量，原文仍保留在本机'), { code: 'RECORD_CAPACITY' })
  }
  await tx.collection('sync_state').doc(expected.id).set(receipt)
}

module.exports = { identity, read, write }
