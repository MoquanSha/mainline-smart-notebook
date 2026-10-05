'use strict'

const MAX_REFERENCES = 50
const URL_LIFETIME_SECONDS = 1800
const live = (row) => row && !row.deletedAt && !row.trashedAt && !row.permanentlyPurgedAt
const photos = (row) => live(row) && row.entryKind === 'today_todo'
  ? (row.comments || []).filter(live).flatMap((comment) => (comment.attachments || []).filter(live))
  : []
const invalid = () => Object.assign(new Error('图片引用参数无效'), { code: 'VALIDATION' })

function createAttachmentAccess({ db, app, now = Date.now }) {
  async function sign(references, allowed) {
    const fileIDs = [...new Set(references.filter((ref) => allowed.has(ref.fileID)).map((ref) => ref.fileID))]
    const urls = new Map()
    if (fileIDs.length) {
      const result = await app.getTempFileURL({ fileList: fileIDs.map((fileID) => ({ fileID, maxAge: URL_LIFETIME_SECONDS })) })
      for (const file of result.fileList || []) {
        const url = file.tempFileURL || file.download_url || ''
        if (fileIDs.includes(file.fileID) && /^https:\/\//i.test(url) && (!file.code || file.code === 'SUCCESS') &&
            (file.status === undefined || file.status === 0)) urls.set(file.fileID, url)
      }
    }
    // Expire locally before the signed URL's requested lifetime. A failed file
    // remains in the response so the client can render an explicit retry state.
    const expiresAt = new Date(now() + (URL_LIFETIME_SECONDS - 60) * 1000).toISOString()
    return { files: references.map((ref) => {
      const url = allowed.has(ref.fileID) ? urls.get(ref.fileID) || '' : ''
      return { ...ref, url, expiresAt: url ? expiresAt : '', error: url ? '' : 'PHOTO_UNAVAILABLE' }
    }) }
  }

  async function byReferences(owner, input) {
    if (!Array.isArray(input) || input.length > MAX_REFERENCES) throw invalid()
    const refs = input.map((ref) => {
      if (!ref || ![ref.todoId, ref.attachmentId, ref.fileID].every((value) => typeof value === 'string' && value.length > 0) ||
          ref.todoId.length > 240 || /[/\u0000-\u001f]/.test(ref.todoId) || ref.attachmentId.length > 240 ||
          ref.fileID.length > 2048 || !ref.fileID.startsWith('cloud://')) throw invalid()
      return { todoId: ref.todoId, attachmentId: ref.attachmentId, fileID: ref.fileID }
    })
    const rows = new Map(), allowedRefs = new Set()
    for (const ref of refs) {
      if (!rows.has(ref.todoId)) {
        const result = await db.collection('daily_tasks').doc(ref.todoId).get()
        rows.set(ref.todoId, Array.isArray(result.data) ? result.data[0] : result.data)
      }
      const row = rows.get(ref.todoId)
      if (row?.ownerOpenId === owner && photos(row).some((photo) => photo.id === ref.attachmentId && photo.fileID === ref.fileID)) {
        allowedRefs.add(JSON.stringify(ref))
      }
    }
    const valid = refs.filter((ref) => allowedRefs.has(JSON.stringify(ref)))
    const signed = await sign(valid, new Set(valid.map((ref) => ref.fileID)))
    const byRef = new Map(signed.files.map((file) => [JSON.stringify({ todoId: file.todoId, attachmentId: file.attachmentId, fileID: file.fileID }), file]))
    return { files: refs.map((ref) => byRef.get(JSON.stringify(ref)) || { ...ref, url: '', expiresAt: '', error: 'PHOTO_UNAVAILABLE' }) }
  }

  async function legacyByFileIDs(owner, input) {
    if (!Array.isArray(input) || input.length > MAX_REFERENCES ||
        input.some((id) => typeof id !== 'string' || id.length > 2048 || !id.startsWith('cloud://'))) throw invalid()
    const ids = [...new Set(input)], allowed = new Set()
    if (!ids.length) return { files: [] }
    let after = ''
    // Compatibility for clients that only send fileIDs. New clients send record
    // references and need one document read per distinct todo, avoiding this scan.
    while (allowed.size < ids.length) {
      const query = { ownerOpenId: owner, ...(after ? { _id: db.command.gt(after) } : {}) }
      const result = await db.collection('daily_tasks').where(query).orderBy('_id', 'asc').limit(100).get()
      const rows = result.data || []
      for (const row of rows) for (const photo of photos(row)) if (ids.includes(photo.fileID)) allowed.add(photo.fileID)
      if (rows.length < 100) break
      const next = String(rows.at(-1)._id || rows.at(-1).id || '')
      if (!next || next <= after) throw Object.assign(new Error('图片归属检查尚未完成，请稍后重试'), { code: 'PHOTO_LOOKUP_INCOMPLETE' })
      after = next
    }
    return sign(ids.map((fileID) => ({ fileID })), allowed)
  }

  return { byReferences, legacyByFileIDs }
}

module.exports = { createAttachmentAccess, MAX_REFERENCES, URL_LIFETIME_SECONDS }
