const config = require('../config/env')
const cache = require('./cache')

function currentScope() { return cache.currentScope ? cache.currentScope() : null }
function scopeHeaders() {
  const scope = currentScope()
  return scope ? { 'X-Mainline-Scope': encodeURIComponent(JSON.stringify(scope)) } : {}
}

function connection() {
  const saved = cache.readConnection()
  return {
    serverBaseUrl: saved.serverBaseUrl || config.defaultHomeServerBaseUrl || '',
    token: saved.token || ''
  }
}

function configured() {
  const current = connection()
  return Boolean(current.serverBaseUrl && current.token)
}

function sessionGuard() {
  const scope = cache.scopeToken ? cache.scopeToken() : null
  const target = connection()
  const targetId = cache.currentHomeTarget ? cache.currentHomeTarget() : null
  return () => {
    if (scope !== (cache.scopeToken ? cache.scopeToken() : null)) {
      throw Object.assign(new Error('工作区已切换，旧电脑连接的结果已隔离'), { code: 'STALE_SCOPE', retryable: false })
    }
    const current = connection()
    if (current.serverBaseUrl !== target.serverBaseUrl || current.token !== target.token ||
        (cache.currentHomeTarget && targetId !== cache.currentHomeTarget())) {
      throw Object.assign(new Error('电脑连接已更换，旧请求的结果已保留待确认'), { code: 'HOME_CONNECTION_CHANGED', retryable: false })
    }
  }
}

async function guardedRequest(options, guard) {
  guard()
  try {
    const response = await wxRequest(options)
    guard()
    return resultOf(response)
  } catch (error) {
    guard()
    throw error
  }
}

function connectionError() {
  const error = new Error('电脑同步尚未配置')
  error.code = 'UNPAIRED'
  error.retryable = true
  return error
}

function wxRequest(options) {
  return new Promise((resolve, reject) => {
    wx.request({
      ...options,
      success: resolve,
      fail: (failure) => {
        const error = new Error(failure && failure.errMsg || '暂时连接不到电脑')
        error.code = 'HOME_OFFLINE'
        error.retryable = true
        reject(error)
      }
    })
  })
}

function resultOf(response) {
  const result = response && response.data
  if (!result || result.ok === false || Number(response.statusCode || 500) >= 400) {
    const detail = result && result.error || {}
    const error = new Error(detail.message || '电脑同步服务暂时不可用')
    error.code = detail.code || (Number(response?.statusCode) === 401 ? 'UNAUTHORIZED'
      : Number(response?.statusCode) === 403 ? 'FORBIDDEN' : 'HOME_SERVER_ERROR')
    error.retryable = detail.retryable !== false && !['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION', 'CONFLICT', 'REQUEST_ID_CONFLICT', 'LEGACY_RECEIPT', 'RECEIPT_CAPACITY', 'SELECTION_REQUIRED', 'HOME_SCOPE_REQUIRED', 'HOME_IDENTITY_UNBOUND', 'WORKSPACE_MISMATCH'].includes(error.code)
    error.latest = detail.latest
    throw error
  }
  return result.data
}

async function rpc(action, payload = {}, options = {}) {
  const guard = sessionGuard()
  const current = connection()
  if (!current.serverBaseUrl || !current.token) throw connectionError()
  if (Object.prototype.hasOwnProperty.call(options, 'homeTarget') && cache.assertHomeTarget) cache.assertHomeTarget(options)
  const requestId = options.requestId || cache.requestId(action.replace(/\W/g, '_'))
  return guardedRequest({
    url: `${current.serverBaseUrl}/api/home/rpc`,
    method: 'POST',
    timeout: options.timeout || 20000,
    header: {
      'content-type': 'application/json',
      ...scopeHeaders(),
      Authorization: `Bearer ${current.token}`
    },
    data: { action: action === 'proposal.applyAll' ? 'proposal.applySelected' : action, requestId, payload,
      scope: options.scope === undefined ? currentScope() : options.scope, clientVersion: config.clientVersion, responseMode: 'record-v1' }
  }, guard)
}

async function batch(operations = [], options = {}) {
  const guard = sessionGuard()
  const current = connection()
  if (!current.serverBaseUrl || !current.token) throw connectionError()
  for (const item of operations) {
    if (Object.prototype.hasOwnProperty.call(item, 'homeTarget') && cache.assertHomeTarget) cache.assertHomeTarget(item)
  }
  return guardedRequest({
    url: `${current.serverBaseUrl}/api/home/batch`,
    method: 'POST',
    timeout: options.timeout || 30000,
    header: {
      'content-type': 'application/json',
      ...scopeHeaders(),
      Authorization: `Bearer ${current.token}`
    },
    data: {
      operations: operations.map((item) => ({
        action: item.action === 'proposal.applyAll' ? 'proposal.applySelected' : item.action,
        requestId: item.requestId || item.id || item.payload && item.payload.requestId,
        scope: item.scope === undefined ? currentScope() : item.scope,
        payload: item.payload || {}
      })),
      scope: currentScope(),
      clientVersion: config.clientVersion
    }
  }, guard)
}

function readFileBuffer(filePath) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({ filePath, success: ({ data }) => resolve(data), fail: reject })
  })
}

async function uploadImage(todoId, image, mimeType) {
  const guard = sessionGuard()
  const current = connection()
  if (!current.serverBaseUrl || !current.token) throw connectionError()
  const data = await readFileBuffer(image.localFilePath || image.filePath)
  guard()
  const result = await guardedRequest({
    url: `${current.serverBaseUrl}/api/home/comment-image`,
    method: 'POST',
    timeout: 20000,
    header: {
      Authorization: `Bearer ${current.token}`,
      ...scopeHeaders(),
      'content-type': mimeType,
      'x-file-name': image.fileName || `${todoId}.jpg`
    },
    data
  }, guard)
  return result.attachment
}

async function testConnection(candidate) {
  const guard = sessionGuard()
  const serverBaseUrl = String(candidate && candidate.serverBaseUrl || '').trim().replace(/\/$/, '')
  const token = String(candidate && candidate.token || '').trim()
  if (!serverBaseUrl || !token) throw connectionError()
  const result = await guardedRequest({
    url: `${serverBaseUrl}/api/home/ping`,
    method: 'GET',
    timeout: 6000,
    header: { Authorization: `Bearer ${token}`, ...scopeHeaders() }
  }, guard)
  guard()
  if (result.scopeProtocol === 1 && currentScope() && (result.principal?.userId !== currentScope().userId || result.principal?.workspaceId !== currentScope().workspaceId)) {
    throw Object.assign(new Error('这台电脑登录的是另一个账号或空间，原连接与待传内容均已保留'), { code: 'WORKSPACE_MISMATCH', retryable: false })
  }
  cache.writeConnection({ serverBaseUrl, token })
  return result
}

function watch(onChange, onStatus = () => {}) {
  const guard = sessionGuard()
  const current = connection()
  if (!current.serverBaseUrl || !current.token) {
    onStatus(false, connectionError())
    return { close() {} }
  }
  let closed = false
  let revision = ''
  let task = null
  let nextTimer = null
  let failures = 0
  const close = () => {
    if (closed) return
    closed = true
    if (nextTimer) clearTimeout(nextTimer)
    if (task && task.abort) task.abort()
  }
  const active = () => {
    if (closed) return false
    try { guard(); return true } catch { close(); return false }
  }
  const failed = (error) => {
    if (!active()) return
    onStatus(false, error)
    if (!active()) return
    if (error.retryable === false) { close(); return }
    nextTimer = setTimeout(poll, Math.min(60000, 2000 * Math.pow(2, failures++)))
  }
  const poll = () => {
    if (!active()) return
    const suffix = revision ? `?since=${encodeURIComponent(revision)}` : ''
    task = wx.request({
      url: `${current.serverBaseUrl}/api/home/changes${suffix}`,
      method: 'GET',
      timeout: 35000,
      header: { Authorization: `Bearer ${current.token}`, ...scopeHeaders() },
      success: (response) => {
        if (!active()) return
        try {
          const event = resultOf(response) || {}
          if (event.revision) revision = event.revision
          onStatus(true)
          if (!active()) return
          if (event.type === 'changed' || event.changed === true) onChange(event)
          if (!active()) return
          failures = 0
          nextTimer = setTimeout(poll, 25)
        } catch (error) {
          failed(error)
        }
      },
      fail: (failure) => {
        if (!active()) return
        const error = new Error(failure && failure.errMsg || '电脑实时连接已断开')
        error.code = 'HOME_CHANGES_OFFLINE'
        error.retryable = true
        failed(error)
      }
    })
    // Some platform failures are delivered synchronously before wx.request
    // returns its handle. Close that late handle as well.
    if (closed && task && task.abort) task.abort()
  }
  poll()
  return { close }
}

// Notification-only foreground connection. Business reads happen in the shared
// receiver; a healthy socket never polls notebook data or replays a mutation.
function watchSocket(onChange, onStatus = () => {}, options = {}) {
  const guard = sessionGuard(), current = connection()
  let closed = false, retryTimer = null, attempt = null, failures = 0
  let revision = String(options.revision || '')
  const stopAttempt = value => {
    if (!value) return
    value.ended = true
    clearTimeout(value.deadline)
    if (value.task) { try { value.task.close({ code: 1000, reason: 'receiver stopped' }) } catch (_) {} }
  }
  const close = () => {
    if (closed) return
    closed = true
    clearTimeout(retryTimer)
    retryTimer = null
    stopAttempt(attempt)
  }
  const watcher = { close, get closed() { return closed } }
  const active = () => {
    if (closed) return false
    try { guard(); return true } catch (_) { close(); return false }
  }
  const failed = (value, error) => {
    if (!active() || value !== attempt || value.ended) return
    stopAttempt(value)
    onStatus(false, error)
    if (!active()) return
    if (error.retryable === false) { close(); return }
    retryTimer = setTimeout(() => { retryTimer = null; connect() }, Math.min(60000, 2000 * 2 ** Math.min(failures++, 5)))
  }
  const errorOf = (message, code = 'HOME_CHANGES_OFFLINE', retryable = true) => Object.assign(new Error(message), { code, retryable })
  const connect = () => {
    if (!active()) return
    const value = attempt = { task: null, ended: false, deadline: null }
    const valid = () => active() && attempt === value && !value.ended
    value.deadline = setTimeout(() => failed(value, errorOf('电脑变更通知连接超时')), 15000)
    try {
      value.task = wx.connectSocket({
        url: `${current.serverBaseUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:').replace(/\/$/, '')}/api/home/socket`,
        header: { Authorization: `Bearer ${current.token}`, ...scopeHeaders() },
        timeout: 15000,
        fail: error => failed(value, errorOf(error && error.errMsg || '无法连接电脑变更通知'))
      })
      if (!valid()) { stopAttempt(value); return }
      value.task.onOpen(() => {}) // Await the authenticated application greeting.
      value.task.onMessage(message => {
        if (!valid()) return
        let event
        try { event = JSON.parse(message.data) } catch (_) {
          failed(value, errorOf('电脑变更通知格式不正确')); return
        }
        if (event?.type === 'error') {
          failed(value, errorOf(event.message || '电脑拒绝了通知连接', event.code || 'HOME_CHANGES_OFFLINE',
            !['UNAUTHORIZED', 'FORBIDDEN', 'UNPAIRED', 'WORKSPACE_MISMATCH', 'HOME_SCOPE_REQUIRED', 'HOME_IDENTITY_UNBOUND'].includes(event.code)))
          return
        }
        if (!event || !['connected', 'changed'].includes(event.type) || typeof event.revision !== 'string' || !event.revision || event.revision.length > 256) {
          failed(value, errorOf('电脑变更通知缺少有效版本')); return
        }
        clearTimeout(value.deadline)
        failures = 0
        onStatus(true)
        if (!valid()) return
        const changed = revision !== event.revision
        revision = event.revision
        if (changed) onChange(event)
      })
      value.task.onError(error => failed(value, errorOf(error && error.errMsg || '电脑变更通知已断开')))
      value.task.onClose(event => {
        if (Number(event?.code) === 1008 && active() && value === attempt) {
          // Native clients may emit a generic error before the policy close.
          // Cancel that attempt's pending retry once the denial is known.
          close()
          onStatus(false, errorOf('电脑连接凭据已失效，请重新核对连接', 'UNAUTHORIZED', false))
        } else failed(value, errorOf('电脑变更通知已断开'))
      })
    } catch (error) { failed(value, errorOf(error.message || '电脑变更通知无法启动')) }
  }
  if (!current.serverBaseUrl || !current.token || typeof wx.connectSocket !== 'function') {
    close()
    onStatus(false, errorOf(!configured() ? '电脑同步尚未配置' : '当前运行环境不支持变更通知，请使用手动刷新',
      !configured() ? 'UNPAIRED' : 'HOME_SOCKET_UNSUPPORTED', false))
  } else connect()
  return watcher
}

module.exports = { rpc, batch, configured, connection, testConnection, uploadImage, watch, watchSocket, sessionGuard }
