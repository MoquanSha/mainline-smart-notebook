const { sameScope } = require('./queue-identity')
function createAttachmentPreviews({ cache, request, now = Date.now }) {
  const inFlight = new Map(), queued = new Map(), failures = new Map()
  let scheduled = false
  const scopeToken = () => cache.scopeToken ? cache.scopeToken() : ''
  const guard = (scope) => {
    if (scopeToken() !== scope) throw Object.assign(new Error('工作区已切换，旧图片结果已隔离'), { code: 'STALE_SCOPE', retryable: false })
  }
  const keyFor = (todoId, attachment) => JSON.stringify([todoId, attachment.id, attachment.fileID])
  const cacheKey = (key) => (cache.KEYS.attachmentPreviews || 'mainline.cloud.v2.attachmentPreviews') + '.' + encodeURIComponent(key)
  const valid = (value) => value && /^https:\/\//i.test(value.url || '') && Date.parse(value.expiresAt || '') > now() + 10000
  const unavailable = (message = '图片暂时无法读取，点按重试') => ({ url: '', error: message })
  const rememberFailure = (key, value) => {
    if (failures.size >= 512) failures.delete(failures.keys().next().value)
    failures.set(key, { value, until: now() + 30000 })
  }

  async function flush() {
    scheduled = false
    const work = [...queued.values()]; queued.clear()
    // Separate workspaces even when a switch happens in the same event loop.
    const groups = new Map()
    for (const item of work) {
      if (!groups.has(item.scope)) groups.set(item.scope, [])
      groups.get(item.scope).push(item)
    }
    for (const [scope, group] of groups) for (let offset = 0; offset < group.length; offset += 50) {
      const batch = group.slice(offset, offset + 50)
      try {
        guard(scope)
        const result = await request({ references: batch.map((item) => item.reference) })
        guard(scope)
        const values = new Map((result.files || []).map((file) => [JSON.stringify([file.todoId, file.attachmentId, file.fileID]), file]))
        for (const item of batch) {
          const value = values.get(item.key)
          const preview = valid(value) ? { url: value.url, expiresAt: value.expiresAt, fileID: value.fileID }
            : unavailable()
          if (preview.url) { cache.write(cacheKey(item.key), preview); failures.delete(item.flightKey) }
          else rememberFailure(item.flightKey, preview)
          item.resolve(preview)
        }
      } catch (error) {
        for (const item of batch) {
          if (scopeToken() === scope) rememberFailure(item.flightKey, unavailable(error.message))
          item.reject(error)
        }
      } finally {
        for (const item of batch) if (inFlight.get(item.flightKey) === item.promise) inFlight.delete(item.flightKey)
      }
    }
  }

  function fetchOne(todoId, attachment, scope) {
    const key = keyFor(todoId, attachment), flightKey = JSON.stringify([scope, key])
    if (inFlight.has(flightKey)) return inFlight.get(flightKey)
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    inFlight.set(flightKey, promise)
    queued.set(flightKey, { key, flightKey, scope, promise, resolve, reject,
      reference: { todoId, attachmentId: attachment.id, fileID: attachment.fileID } })
    if (!scheduled) { scheduled = true; Promise.resolve().then(flush) }
    return promise
  }

  async function resolve(todoId, attachments, options = {}) {
    const scope = scopeToken()
    return Promise.all((attachments || []).filter((item) => !item.deletedAt).map(async (attachment) => {
      try {
        if (attachment.scope && cache.currentScope && !sameScope(attachment.scope, cache.currentScope())) {
          return { ...attachment, ...unavailable('图片不属于当前空间') }
        }
        const local = attachment.localFilePath || attachment.filePath || (/^(wxfile:|https?:\/\/(tmp|usr)\/)/.test(attachment.previewUrl || '') ? attachment.previewUrl : '')
        if (!options.force && local) return { ...attachment, url: local, error: '' }
        if (!attachment.fileID || !attachment.id) return { ...attachment,
          ...(!options.force && /^https:\/\//i.test(attachment.previewUrl || '') ? { url: attachment.previewUrl, error: '' } : unavailable('图片原文件暂不可用')) }
        if (!options.force) {
          const failed = failures.get(JSON.stringify([scope, keyFor(todoId, attachment)]))
          if (failed?.until > now()) return { ...attachment, ...failed.value }
          const stored = cache.read(cacheKey(keyFor(todoId, attachment)), null)
          const embedded = { url: attachment.previewUrl, expiresAt: attachment.previewUrlExpiresAt }
          if (valid(stored)) return { ...attachment, ...stored, error: '' }
          if (valid(embedded)) return { ...attachment, ...embedded, error: '' }
        }
        const result = await fetchOne(todoId, attachment, scope)
        guard(scope)
        return { ...attachment, ...result, error: result.error || '' }
      } catch (error) {
        guard(scope)
        return { ...attachment, ...unavailable(error.message || '图片链接未能更新，请重试') }
      }
    }))
  }
  return { resolve }
}
module.exports = { createAttachmentPreviews }
