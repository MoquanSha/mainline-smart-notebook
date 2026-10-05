const { sameScope } = require('./queue-identity')
function createAttachmentStore(cache) {
  const inFlight = new Map()
  const failure = (code, message) => Object.assign(new Error(message), { code, retryable: false })
  const token = () => cache.scopeToken ? cache.scopeToken() : null
  function guard(expected) {
    if (token() !== expected) throw failure('STALE_SCOPE', '工作区已切换，旧图片结果已隔离')
  }
  function checkOwner(attachment) {
    if (attachment.scope && cache.currentScope && !sameScope(attachment.scope, cache.currentScope())) {
      throw failure('WORKSPACE_MISMATCH', '图片属于其他账号或工作区，已保留并停止发送')
    }
  }
  function source(todoId, image) {
    return JSON.stringify([todoId, image.id, image.localFilePath || '', image.fileName || '', image.mimeType, Number(image.size || 0)])
  }
  function key(base, parts) { return base + '.' + encodeURIComponent(JSON.stringify(parts)) }

  async function save(todoId, image, mimeType, storagePrefix = '') {
    const expected = token()
    checkOwner(image)
    const scope = cache.currentScope ? cache.currentScope() : null
    if (cache.currentScope && !scope) throw failure('UNAUTHORIZED', '请先登录个人空间，再保存图片')
    const id = image.id || cache.requestId('todo-image')
    const recordKey = key(cache.KEYS.attachmentFiles, [todoId, id])
    const existing = cache.read(recordKey, null)
    const filePath = image.localFilePath || image.filePath
    if (existing) {
      if (![existing.sourcePath, existing.image.localFilePath].includes(filePath) ||
          existing.image.mimeType !== mimeType || existing.image.size !== Number(image.size || 0)) {
        throw failure('INPUT_ID_CONFLICT', '图片编号已对应另一份文件，请重新选择图片')
      }
      return { ...existing.image }
    }
    let savedPath = image.localFilePath
    if (!savedPath) {
      if (!filePath || typeof wx.saveFile !== 'function') throw failure('ATTACHMENT_SAVE_FAILED', '当前无法可靠保存图片，请保留原图并重试')
      try {
        savedPath = await new Promise((resolve, reject) => wx.saveFile({
          tempFilePath: filePath,
          success: (result) => result.savedFilePath ? resolve(result.savedFilePath) : reject(new Error('未取得已保存的图片路径')),
          fail: (error) => reject(failure('ATTACHMENT_SAVE_FAILED', '图片尚未保存到手机：' + (error.errMsg || '请检查存储空间')))
        }))
      } catch (error) { guard(expected); throw error }
    }
    guard(expected)
    const descriptor = { id, fileName: image.fileName || `${todoId}.jpg`, mimeType,
      size: Number(image.size || 0), localFilePath: savedPath, filePath: savedPath,
      storagePrefix, scope, createdAt: image.createdAt || new Date().toISOString() }
    // The scoped registry is committed before the page can claim a saved photo.
    // Do not remove the file on metadata failure: it may be recoverable locally.
    cache.write(recordKey, { sourcePath: filePath, image: descriptor })
    return descriptor
  }

  async function uploaded(todoId, attachment, destination, upload, checkDestination = () => {}) {
    const expected = token()
    checkOwner(attachment)
    const receiptKey = key(cache.KEYS.attachmentUploads || 'mainline.cloud.v2.attachmentUploads', [destination, todoId, attachment.id])
    const fingerprint = source(todoId, attachment)
    const verify = (receipt) => {
      if (receipt.source !== fingerprint) throw failure('INPUT_ID_CONFLICT', '同一图片编号对应的文件已改变，已停止重试')
      return receipt.result
    }
    checkDestination()
    const receipt = cache.read(receiptKey, null)
    if (receipt) return verify(receipt)
    const flightKey = JSON.stringify([expected, receiptKey])
    const running = inFlight.get(flightKey)
    if (running) {
      verify({ source: running.source })
      const result = await running.promise
      guard(expected); checkDestination()
      return result
    }
    const promise = (async () => {
      try {
        const result = await upload()
        guard(expected); checkDestination()
        cache.write(receiptKey, { source: fingerprint, result, uploadedAt: new Date().toISOString() })
        return result
      } catch (error) { guard(expected); checkDestination(); throw error }
    })()
    inFlight.set(flightKey, { source: fingerprint, promise })
    try { return await promise } finally { if (inFlight.get(flightKey)?.promise === promise) inFlight.delete(flightKey) }
  }

  return { save, uploaded, checkOwner }
}
module.exports = { createAttachmentStore }
