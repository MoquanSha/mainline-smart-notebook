function presentComments(comments = []) {
  return (Array.isArray(comments) ? comments : [])
    .filter((comment) => !comment.deletedAt)
    .map((comment) => ({
      ...comment,
      createdLabel: String(comment.createdAt || '').slice(5, 16).replace('T', ' '),
      organizationLabel: comment.organizationStatus === 'organized' ? 'AI 已整理' : '原文保留',
      attachments: (Array.isArray(comment.attachments) ? comment.attachments : [])
        .filter((attachment) => !attachment.deletedAt)
    }))
}

function collectPhotoAttachments(comments = []) {
  const seen = new Set()
  return (Array.isArray(comments) ? comments : []).flatMap((comment) => comment.attachments || [])
    .filter((attachment) => {
      const key = String(attachment.id || attachment.fileID || attachment.previewUrl || '')
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
}

module.exports = {
  collectPhotoAttachments,
  presentComments
}
