const largeStorage = require('./large-storage')
const { assertSameInput, sameScope } = require('./queue-identity')
const PREFIX = 'mainline.cloud.v2.'
const ACTIVE_SCOPE_KEY = 'mainline.cloud.v3.activeScope'
const LEGACY_RECOVERY_KEY = 'mainline.cloud.v3.legacyRecovery'
let scopeEpoch = 0

function rawRead(key, fallback) {
  // A failed identity read is not an anonymous session. Stop rather than write
  // the current user's pending work under a fallback namespace.
  return largeStorage.read(key, fallback)
}

function currentScope() {
  const scope = rawRead(ACTIVE_SCOPE_KEY, null)
  return scope && scope.userId && scope.workspaceId
    ? { userId: String(scope.userId), workspaceId: String(scope.workspaceId) }
    : null
}

function scopeToken() {
  return JSON.stringify([currentScope(), scopeEpoch])
}

function storageKey(key) {
  const scope = currentScope()
  if (!String(key).startsWith(PREFIX)) return key
  return 'mainline.cloud.v3.' + encodeURIComponent(JSON.stringify(scope ? [scope.userId, scope.workspaceId] : ['unbound'])) + '.' + String(key).slice(PREFIX.length)
}

function quarantinedLegacy() { return largeStorage.read(LEGACY_RECOVERY_KEY, {}) }

function adoptScope(bootstrap) {
  const account = bootstrap && bootstrap.account
  const next = account && account.user && account.user.id && account.workspaceId
    ? { userId: String(account.user.id), workspaceId: String(account.workspaceId) }
    : null
  if (rawRead(ACTIVE_SCOPE_KEY, undefined) !== undefined && JSON.stringify(currentScope()) === JSON.stringify(next)) return false
  // V2 queue entries carry no trustworthy owner. Keep an exact recovery copy;
  // never infer their owner from whichever account happens to log in next.
  if (!largeStorage.read(LEGACY_RECOVERY_KEY, null)) {
    const values = {}
    for (const [name, key] of Object.entries(KEYS)) {
      const value = largeStorage.read(key, undefined)
      if (value !== undefined) values[name] = value
    }
    largeStorage.write(LEGACY_RECOVERY_KEY, {
      capturedAt: new Date().toISOString(), reason: 'unscoped-v2-data',
      queue: values.queue || [], values
    })
  }
  wx.setStorageSync(ACTIVE_SCOPE_KEY, next || {})
  scopeEpoch += 1
  return true
}

const KEYS = {
  bootstrap: `${PREFIX}bootstrap`,
  today: `${PREFIX}today`,
  todayTodos: `${PREFIX}todayTodos`,
  captures: `${PREFIX}captures`,
  journal: `${PREFIX}journal`,
  journalArchive: `${PREFIX}journalArchive`,
  trash: `${PREFIX}trash`,
  proposals: `${PREFIX}proposals`,
  proposalDraftState: `${PREFIX}proposalDraftState`,
  tasks: `${PREFIX}tasks`,
  diaryDays: `${PREFIX}diaryDays`,
  diaryDraft: `${PREFIX}diaryDraft`,
  diaryDraftState: `${PREFIX}diaryDraftState`,
  diaryOrganization: `${PREFIX}diaryOrganization`,
  journalOrganization: `${PREFIX}journalOrganization`,
  journalDraftState: `${PREFIX}journalDraftState`,
  journalSupplementDraftState: `${PREFIX}journalSupplementDraftState`,
  homeDraftState: `${PREFIX}homeDraftState`,
  attachmentFiles: `${PREFIX}attachmentFiles`,
  attachmentUploads: `${PREFIX}attachmentUploads`,
  attachmentPreviews: `${PREFIX}attachmentPreviews`,
  history: `${PREFIX}history`,
  queue: `${PREFIX}queue`,
  codexCandidateRefreshAt: `${PREFIX}codexCandidateRefreshAt`,
  deviceStatus: `${PREFIX}deviceStatus`,
  deviceStatusAt: `${PREFIX}deviceStatusAt`,
  syncRevision: `${PREFIX}syncRevision`,
  syncSnapshotDate: `${PREFIX}syncSnapshotDate`,
  syncSnapshotReady: `${PREFIX}syncSnapshotReady`,
  syncSnapshotScopeVersion: `${PREFIX}syncSnapshotScopeVersion`,
  syncSnapshotScopeProbeVersion: `${PREFIX}syncSnapshotScopeProbeVersion`,
  syncReceiptRepairVersion: `${PREFIX}syncReceiptRepairVersion`,
  confirmedSnapshot: `${PREFIX}confirmedSnapshot`,
  historyTransfer: `${PREFIX}historyTransfer`,
  homeHistoryTransfer: `${PREFIX}homeHistoryTransfer`,
  homeConnection: `${PREFIX}homeConnection`,
  hybridState: `${PREFIX}hybridState`,
  mirrorQueue: `${PREFIX}mirrorQueue`
}

function read(key, fallback = []) {
  return largeStorage.read(storageKey(key), fallback)
}

function write(key, value) {
  largeStorage.write(storageKey(key), value)
  return value
}

function requestId(prefix = 'req') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function enqueue(action, payload, options = {}) {
  const queue = read(KEYS.queue, [])
  const id = options.id || payload && payload.requestId || requestId('offline')
  const existing = queue.find((item) => item.id === id)
  if (existing) return assertSameInput(existing, action, payload)
  const coalesceKey = String(options.coalesceKey || '')
  const item = {
    id,
    action,
    payload,
    scope: currentScope(),
    homeTarget: currentHomeTarget(),
    coalesceKey,
    createdAt: new Date().toISOString(),
    attempts: 0
  }
  const next = coalesceKey
    ? [...queue.filter((queued) => queued.coalesceKey !== coalesceKey ||
      queued.homeTarget !== item.homeTarget || !sameScope(queued.scope, item.scope)), item]
    : [...queue, item]
  write(KEYS.queue, next)
  return item
}

function dequeue(id) {
  const queue = read(KEYS.queue, [])
  const next = queue.filter((item) => item.id !== id)
  if (next.length !== queue.length) write(KEYS.queue, next)
  return next
}

function readConnection() {
  const value = read(KEYS.homeConnection, {})
  return {
    serverBaseUrl: String(value.serverBaseUrl || '').trim().replace(/\/$/, ''),
    token: String(value.token || '').trim()
  }
}

function writeConnection(connection) {
  const previous = read(KEYS.homeConnection, {})
  const serverBaseUrl = String(connection.serverBaseUrl || '').trim().replace(/\/$/, '')
  const token = String(connection.token || '').trim()
  return write(KEYS.homeConnection, {
    serverBaseUrl, token,
    attachmentTargetId: previous.serverBaseUrl === serverBaseUrl && previous.token === token && previous.attachmentTargetId
      ? previous.attachmentTargetId : requestId('attachment_target'),
    updatedAt: new Date().toISOString()
  })
}

function attachmentConnectionId() {
  const value = read(KEYS.homeConnection, {})
  if (value.attachmentTargetId) return value.attachmentTargetId
  // Migrate the existing connection locally without storing its credential in
  // another registry or in a key. Future credential changes rotate this ID.
  const id = requestId('attachment_target')
  write(KEYS.homeConnection, { ...value, attachmentTargetId: id })
  return id
}

function currentHomeTarget() {
  const value = readConnection()
  return value.serverBaseUrl && value.token ? attachmentConnectionId() : null
}

function assertHomeTarget(item) {
  if (!item || !item.homeTarget) {
    throw Object.assign(new Error('这条待传内容尚未确认接收电脑，请在账号页处理待传目标'), {
      code: 'HOME_TARGET_REQUIRED', retryable: false
    })
  }
  if (item.homeTarget !== currentHomeTarget()) {
    throw Object.assign(new Error('接收电脑已更换，旧内容仍保留在手机，请先确认待传目标'), {
      code: 'HOME_TARGET_CHANGED', retryable: false
    })
  }
}

function readHybridState() {
  const value = read(KEYS.hybridState, {})
  return {
    mode: ['cloud', 'home', 'local', 'recovering'].includes(value.mode) ? value.mode : 'cloud',
    quotaBlocked: Boolean(value.quotaBlocked),
    homeReachable: value.homeReachable === true ? true : value.homeReachable === false ? false : null,
    lastCloudError: String(value.lastCloudError || ''),
    lastCloudSuccessAt: String(value.lastCloudSuccessAt || ''),
    lastHomeSuccessAt: String(value.lastHomeSuccessAt || ''),
    cloudProbeAfter: Number(value.cloudProbeAfter || 0),
    updatedAt: String(value.updatedAt || '')
  }
}

function discardCloudOnlyMirrorWork() {
  // Retained for older callers. A disabled destination is not a receipt and
  // cannot authorize removal of user input.
  return read(KEYS.mirrorQueue, [])
}

function writeHybridState(patch) {
  const next = { ...readHybridState(), ...patch, updatedAt: new Date().toISOString() }
  write(KEYS.hybridState, next)
  return next
}

function enqueueMirror(action, payload, destinations = {}, options = {}) {
  const queue = [...read(KEYS.mirrorQueue, [])]
  const operationId = options.id || payload && payload.requestId || requestId('mirror')
  const priorOperation = queue.find((item) => item.requestId === operationId)
  if (priorOperation) assertSameInput(priorOperation, action, payload)
  const id = `${operationId}:${destinations.cloud ? 'c' : ''}${destinations.home ? 'h' : ''}`
  const existing = queue.find((item) => item.id === id)
  if (existing) return assertSameInput(existing, action, payload)
  const item = {
    id,
    requestId: operationId,
    action,
    payload,
    scope: currentScope(),
    homeTarget: destinations.home ? (Object.prototype.hasOwnProperty.call(options, 'homeTarget')
      ? options.homeTarget : currentHomeTarget()) : null,
    pendingCloud: Boolean(destinations.cloud),
    pendingHome: Boolean(destinations.home),
    createdAt: new Date().toISOString(),
    attempts: 0
  }
  queue.push(item)
  write(KEYS.mirrorQueue, queue)
  return item
}

module.exports = {
  currentScope, scopeToken, adoptScope, quarantinedLegacy,
  KEYS, read, write, requestId, enqueue, dequeue,
  readConnection, writeConnection, attachmentConnectionId, currentHomeTarget, assertHomeTarget,
  readHybridState, writeHybridState, enqueueMirror,
  discardCloudOnlyMirrorWork
}
