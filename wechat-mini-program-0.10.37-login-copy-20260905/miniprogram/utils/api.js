const config = require('../config/env')
const cache = require('./cache')
const home = require('./home-transport')
const homeRecovery = require('./home-queue-recovery').createHomeQueueRecovery({ cache, home })
const attachmentStore = require('./attachment-store').createAttachmentStore(cache)
const attachmentPreviews = require('./attachment-previews').createAttachmentPreviews({
  cache, request: (payload) => cloudRpc('attachment.previews', payload)
})
const hybrid = require('./hybrid-policy')
const { rebaseTodoQueueItem, overlayQueuedTodoIntents } = require('./sync-policy')
const historySync = require('./sync-history')
const { projectJournal, supportsJournalIntent } = require('./journal-intents')
const { sameInput, sameScope } = require('./queue-identity')
const { createDiaryOrganization } = require('./diary-organization')
const { createJournalOrganization } = require('./journal-organization')

const CLOUD_PROBE_INTERVAL_MS = 30 * 60 * 1000
const DIRTY_FLUSH_DEBOUNCE_MS = 800
const SYNC_PUSH_BATCH_SIZE = 50
const SNAPSHOT_SCOPE_VERSION = 3
const CLOUD_RPC_TIMEOUT_MS = Math.max(1, Math.min(60 * 1000, Number(config.cloudRpcTimeoutMs || 12 * 1000)))
const CLOUD_SYNC_ENABLED = config.cloudSyncEnabled === true
const MANUAL_SYNC_ONLY = config.manualSyncOnly === true || config.syncMode === 'cloud-manual'
// These errors describe an operation that cannot become valid by retrying the
// same request. Keep the queue blocked and show the user what needs review;
// otherwise an invalid request can be retried forever and hide later work.
const NON_RETRYABLE_CODES = new Set([
  'FORBIDDEN', 'VALIDATION', 'CONFLICT', 'UNAUTHORIZED', 'UNAUTHENTICATED', 'INVITE_REQUIRED',
  'WORKSPACE_MISMATCH', 'INPUT_ID_CONFLICT', 'DIARY_CAPACITY', 'RECORD_DELETED', 'LINEAGE_LIMIT',
  'RESTORE_CONFLICT', 'RECORD_CAPACITY', 'REQUEST_ID_CONFLICT', 'LEGACY_RECEIPT', 'RECEIPT_CAPACITY',
  'SELECTION_REQUIRED'
])
let clientOperationChain = Promise.resolve()
const recoveryRequests = new Map()
const mirrorFlushes = new Map()
const primaryFlushes = new Map()
let dirtyFlushTimer = null
const dirtyFlushes = new Map()
let identityVerified = false
let identityCheckPromise = null
const lastHomeWarmSignatures = new Map()
const HOME_WARM_ACTIONS = new Set([
  'todayTodo.list', 'todayTodo.history', 'todayTodo.completedByDate', 'journal.overview', 'journal.listArchive',
  'trash.list', 'proposal.list', 'task.list'
])
const MANUAL_CACHED_READS = new Set([
  'bootstrap', 'todayTodo.list', 'todayTodo.history', 'todayTodo.completedByDate', 'journal.overview',
  'journal.listToday', 'journal.listArchive', 'trash.list', 'proposal.list',
  'task.list', 'source.list', 'device.status'
])
const ROUTINE_SYNC_PREFIXES = ['todayTodo.', 'task.', 'journal.', 'capture.', 'trash.', 'diary.appendInput', 'diary.organizeInput']
const MANUAL_ROUTINE_MUTATIONS = new Set([
  'diary.appendInput',
  'todayTodo.add', 'todayTodo.complete', 'todayTodo.reopen', 'todayTodo.defer', 'todayTodo.delete',
  'todayTodo.setPin', 'todayTodo.reorder', 'todayTodo.commentAdd', 'todayTodo.commentDelete',
  'task.update', 'task.completeStep', 'task.archive',
  'journal.create', 'journal.toggleItem', 'journal.append', 'journal.archive', 'journal.restore', 'journal.delete',
  'capture.setFavorite', 'capture.hide', 'capture.restoreHidden', 'trash.restore'
])
const REMOTE_REQUIRED_MUTATIONS = new Set([
  'journal.organizationStep',
  'diary.refresh', 'diary.organizationStep',
  'proposal.apply', 'proposal.applyAll', 'proposal.reject', 'proposal.delete',
  'proposal.update', 'proposal.defer', 'proposal.restore', 'task.reanalyze'
])

const diaryOrganization = createDiaryOrganization({
  cache,
  isVisible: () => { const app = typeof getApp === 'function' ? getApp() : null; return Boolean(app && app.appVisible) },
  request: async (payload) => {
    const data = await cloudRpc('diary.organizationStep', payload, { timeoutMs: 60000 })
    if (data && data.day) reconcileDiaryResult(data.day)
    return data
  },
  notify: (event) => { const app = typeof getApp === 'function' ? getApp() : null; if (app && app.notifySyncListeners) app.notifySyncListeners(event) }
})

function organizePendingDiaries(options) { return diaryOrganization.resume(options) }

const journalOrganization = createJournalOrganization({
  cache,
  isVisible: () => { const app = typeof getApp === 'function' ? getApp() : null; return Boolean(app && app.appVisible) },
  request: async (payload) => {
    const result = await cloudRpc('journal.organizationStep', payload, { timeoutMs: 60000 })
    if (result?.entry) reconcileBatchMutation('journal.organizationStep', result.entry)
    return result
  },
  notify: (event) => { const app = typeof getApp === 'function' ? getApp() : null; app?.notifySyncListeners?.(event) }
})
function organizePendingJournals(options) { return journalOrganization.resume(options) }

function currentShanghaiDateKey(value = Date.now()) {
  const date = new Date(Number(value) + 8 * 60 * 60 * 1000)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

function routineSyncAction(action) {
  return ROUTINE_SYNC_PREFIXES.some((prefix) => String(action || '').startsWith(prefix))
}

function retryableQueueItem(item) {
  return item && item.status !== 'blocked' && routineSyncAction(item.action)
}

function failedQueueItem(original, failure = {}, fallback = '上传未完成') {
  const code = String(failure.code || 'SERVER_ERROR')
  const blocked = failure.retryable === false || NON_RETRYABLE_CODES.has(code)
  return {
    ...original,
    attempts: Number(original.attempts || 0) + 1,
    lastError: failure.message || fallback,
    lastErrorCode: code,
    status: blocked ? 'blocked' : 'pending'
  }
}

function settleQueueBatch(snapshot, remaining) {
  const sentById = new Map(snapshot.map((item) => [item.id, item]))
  const failedById = new Map(remaining.map((item) => [item.id, item]))
  // Read the current queue after the await. Coalesced replacements and new
  // writes belong to a later batch, even when they touch the same record.
  const next = cache.read(cache.KEYS.queue, []).flatMap((current) => {
    const sent = sentById.get(current.id)
    if (!sent || sent.action !== current.action || JSON.stringify(sent.payload) !== JSON.stringify(current.payload) ||
        sent.homeTarget !== current.homeTarget || JSON.stringify(sent.scope) !== JSON.stringify(current.scope)) return [current]
    return failedById.has(current.id) ? [failedById.get(current.id)] : []
  })
  cache.write(cache.KEYS.queue, next)
  if (snapshot.some((item) => supportsJournalIntent(item.action))) refreshJournalView()
  return next
}

function manualRoutineMutation(action) {
  return MANUAL_SYNC_ONLY && MANUAL_ROUTINE_MUTATIONS.has(String(action || ''))
}

function remoteRequiredMutation(action) {
  return REMOTE_REQUIRED_MUTATIONS.has(String(action || ''))
}

function runSerialized(operation) {
  const scope = activeScopeToken()
  const current = clientOperationChain.catch(() => {}).then(() => {
    assertScopeToken(scope)
    return operation()
  })
  clientOperationChain = current.catch(() => {})
  return current
}

function activeScopeToken() { return cache.scopeToken ? cache.scopeToken() : null }
function assertScopeToken(expected) {
  if (expected !== activeScopeToken()) {
    const error = new Error('工作区已切换，旧请求的结果已隔离')
    error.code = 'STALE_SCOPE'
    error.retryable = false
    throw error
  }
}
function scopeIndependentAction(action) {
  return ['bootstrap', 'workspace.createPersonal', 'workspace.join', 'login.mini.preview', 'login.mini.complete'].includes(action)
}
function adoptBootstrap(data) {
  if (!cache.adoptScope || !data || !Object.prototype.hasOwnProperty.call(data, 'account')) return
  const changed = cache.adoptScope(data)
  identityVerified = true
  cache.write(cache.KEYS.bootstrap, data)
  if (changed) {
    cancelDirtyFlushTimer()
    const app = typeof getApp === 'function' ? getApp() : null
    if (app && app.onScopeChanged) app.onScopeChanged()
    if (app && app.notifySyncListeners) app.notifySyncListeners({ type: 'scope-changed' })
  }
}
async function ensureVerifiedIdentity() {
  if (!cache.adoptScope || identityVerified || !CLOUD_SYNC_ENABLED) return
  if (!identityCheckPromise) {
    identityCheckPromise = bootstrap().finally(() => { identityCheckPromise = null })
  }
  await identityCheckPromise
  if (!identityVerified || !cache.currentScope()) {
    throw Object.assign(new Error('请先确认微信身份；本机记录仍保留'), { code: 'UNAUTHENTICATED', retryable: false })
  }
}

function resultOf(response) {
  const result = response && response.result
  if (!result || result.ok === false) {
    const error = new Error((result && result.error && result.error.message) || '云端暂时不可用')
    error.code = result && result.error && result.error.code
    error.retryable = !result || !NON_RETRYABLE_CODES.has(error.code)
    error.latest = result && result.error && result.error.latest
    error.cloudResponse = response
    throw error
  }
  return result.data
}

function normalizeCloudFailure(failure) {
  if (failure instanceof Error) {
    if (!failure.code) failure.code = failure.errCode || 'CLOUD_ERROR'
    if (failure.retryable === undefined) failure.retryable = !NON_RETRYABLE_CODES.has(failure.code)
    return failure
  }
  const error = new Error(failure && (failure.errMsg || failure.message) || '云端暂时不可用')
  error.code = failure && (failure.code || failure.errCode) || 'CLOUD_ERROR'
  error.retryable = true
  error.cloudFailure = failure
  return error
}

function cloudTimeout(action, timeoutMs) {
  const error = new Error(`${action} 请求超时，已保存在手机并等待下次同步`)
  error.code = 'CLOUD_TIMEOUT'
  error.retryable = true
  return error
}

function withTimeout(promise, action, timeoutMs = CLOUD_RPC_TIMEOUT_MS) {
  let timer = null
  const limit = Math.max(1, Number(timeoutMs) || CLOUD_RPC_TIMEOUT_MS)
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(cloudTimeout(action, limit)), limit)
  })
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

async function cloudRpc(action, payload = {}, options = {}) {
  if (!CLOUD_SYNC_ENABLED) {
    const error = new Error('CloudBase 同步已停用，当前只连接电脑本地数据')
    error.code = 'CLOUD_DISABLED'
    error.retryable = false
    throw error
  }
  const requestId = options.requestId || cache.requestId(action.replace(/\W/g, '_'))
  const scopeToken = activeScopeToken()
  if (!scopeIndependentAction(action)) {
    await ensureVerifiedIdentity()
    assertScopeToken(scopeToken)
  }
  const scope = cache.currentScope ? cache.currentScope() : null
  try {
    const response = await withTimeout(wx.cloud.callFunction({
      name: config.apiFunction,
      data: { action, requestId, payload, clientVersion: config.clientVersion, ...(scope && !scopeIndependentAction(action) ? { scope } : {}) }
    }), action, options.timeoutMs)
    assertScopeToken(scopeToken)
    const data = resultOf(response)
    if (data && data.syncReceipt && data.syncReceipt.revision) {
      // A mutation receipt proves only that this write reached the cloud. It
      // does not prove that the phone has pulled other devices' changes at the
      // same revision. Persisting it as the snapshot revision can make the
      // following receive phase return notModified and leave stale diary or
      // task caches behind.
      const app = typeof getApp === 'function' ? getApp() : null
      if (app && app.rememberLocalSyncRevision) app.rememberLocalSyncRevision(data.syncReceipt.revision)
    }
    return data
  } catch (failure) {
    assertScopeToken(scopeToken)
    throw normalizeCloudFailure(failure)
  }
}

function statusPatch(patch) {
  const next = cache.writeHybridState(patch)
  const app = typeof getApp === 'function' ? getApp() : null
  if (app && next.quotaBlocked && app.stopRealtimeSync) app.stopRealtimeSync()
  if (app && app.notifySyncListeners) app.notifySyncListeners({ type: 'transport-state', state: publicHybridStatus(next) })
  return next
}

function publicHybridStatus(value = cache.readHybridState()) {
  const mainQueue = cache.read(cache.KEYS.queue, [])
  const mirrorQueue = cache.read(cache.KEYS.mirrorQueue, [])
  const mode = !CLOUD_SYNC_ENABLED
    ? (home.configured() && value.homeReachable !== false ? 'home' : 'local')
    : value.mode === 'recovering'
    ? 'recovering'
    : value.quotaBlocked
      ? (home.configured() && value.homeReachable !== false ? 'home' : 'local')
      : 'cloud'
  const labels = {
    cloud: '云端同步',
    home: CLOUD_SYNC_ENABLED ? '家庭服务器' : '电脑本地同步',
    local: CLOUD_SYNC_ENABLED ? '仅保存在手机' : '手机离线缓存',
    recovering: '正在恢复云端'
  }
  return {
    ...value,
    mode,
    label: labels[mode],
    homeConfigured: home.configured(),
    pendingLocal: mainQueue.length,
    cloudSyncEnabled: CLOUD_SYNC_ENABLED,
    pendingCloud: mirrorQueue.filter((item) => item.pendingCloud).length,
    blockedMirror: mirrorQueue.filter((item) => item.status === 'blocked').length,
    pendingHome: mirrorQueue.filter((item) => item.pendingHome).length
  }
}

function markQuotaBlocked(error) {
  const nextMode = hybrid.fallbackMode(home.configured(), null)
  return statusPatch({
    mode: nextMode,
    quotaBlocked: true,
    lastCloudError: String(error && error.message || '云端额度不足').slice(0, 240),
    cloudProbeAfter: Date.now() + CLOUD_PROBE_INTERVAL_MS
  })
}

function markCloudHealthy() {
  return statusPatch({
    mode: 'cloud', quotaBlocked: false, homeReachable: cache.readHybridState().homeReachable,
    lastCloudError: '', lastCloudSuccessAt: new Date().toISOString(), cloudProbeAfter: 0
  })
}

function markHomeReachable() {
  return statusPatch({
    mode: cache.readHybridState().quotaBlocked ? 'home' : cache.readHybridState().mode,
    homeReachable: true,
    lastHomeSuccessAt: new Date().toISOString()
  })
}

function markHomeOffline(error) {
  return statusPatch({
    mode: cache.readHybridState().quotaBlocked ? 'local' : cache.readHybridState().mode,
    homeReachable: false,
    lastHomeError: String(error && error.message || '家庭服务器离线').slice(0, 240)
  })
}

function randomStableId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`
}

function autoPinHighPriorityTodosEnabled() {
  const bootstrap = cache.read(cache.KEYS.bootstrap, {}) || {}
  const direct = bootstrap.autoPinHighPriorityTodos
  const nested = bootstrap.settings && bootstrap.settings.autoPinHighPriorityTodos
  if (direct !== undefined) return direct !== false
  if (nested !== undefined) return nested !== false
  return true
}

function polishTodayTodoTitle(value) {
  return String(value || '')
    .replace(/^[\s•#\-\d.、）)]+/, '')
    .replace(/^(今天|今日|现在|待会|一会)[，, ]*(我要|需要|打算|计划|准备|必须)?/, '')
    .replace(/^(然后|接着|另外|还有|其次)[，, ]*/, '')
    .replace(/[。！!；;]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

function splitTodayTodoInput(value) {
  // Keep the complete user input in the client payload. The view may impose a
  // typing limit, but imported/desktop input can be longer and must not lose
  // its tail before it reaches the capture record.
  const input = String(value || '').trim()
    .replace(/\r\n?/g, '\n')
    .replace(/(^|\s)(\d{1,2}[.、）)])[\s]*/g, '$1\n')
    .replace(/([。！!；;])[\s]*/g, '$1\n')
  const seen = new Set()
  return input.split(/\n+/)
    .flatMap((line) => line.split(/(?:，|,)?\s*(?:另外|还有|其次|接着|然后)\s*/))
    .map((raw) => ({ raw: raw.trim(), title: polishTodayTodoTitle(raw) }))
    .filter((item) => item.title.length >= 2)
    .filter((item) => {
      const key = item.title.replace(/[\s，,。.!！]/g, '').toLowerCase()
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 12)
}

function normalizeClientPayload(action, payload = {}) {
  const output = { ...payload }
  if ((action === 'todayTodo.add' || action === 'todayTodo.setPin') && output.autoPinHighPriorityTodos === undefined) {
    output.autoPinHighPriorityTodos = autoPinHighPriorityTodosEnabled()
  }
  if (action === 'todayTodo.add' && !Array.isArray(output.clientItems)) {
    output.clientCaptureId = output.clientCaptureId || randomStableId('capture_client')
    output.clientItems = splitTodayTodoInput(output.content)
      .map(() => ({ id: randomStableId('today_todo_client') }))
  }
  if (action === 'todayTodo.commentAdd' && !output.commentId) {
    output.commentId = randomStableId('todo_comment_client')
  }
  if (action === 'journal.append' && !output.supplementId) {
    output.supplementId = output.requestId || randomStableId('journal_supplement_client')
  }
  if (action === 'todayTodo.defer' && !output.clientDeferredTodoId) {
    output.clientDeferredTodoId = randomStableId('today_todo_deferred_client')
  }
  return output
}

function queueCoalesceKey(action, payload = {}) {
  if (action === 'todayTodo.setPin') return `todayTodo.setPin:${payload.todoId || ''}`
  if (action === 'todayTodo.reorder') return 'todayTodo.reorder'
  if (action === 'journal.toggleItem') return `journal.toggleItem:${payload.entryId || ''}:${payload.itemId || ''}`
  if (action === 'capture.setFavorite') return `capture.setFavorite:${payload.entryId || payload.id || ''}`
  if (action === 'capture.hide' || action === 'capture.restoreHidden') return `capture.visibility:${payload.entryId || payload.id || ''}`
  if (action === 'task.update' && payload.patch && Object.keys(payload.patch).length === 1 && Object.prototype.hasOwnProperty.call(payload.patch, 'progress')) {
    return `task.update:progress:${payload.id || payload.taskId || ''}`
  }
  return ''
}

function enqueueRoutineAction(action, payload, requestId) {
  // A mutation must never create a new queue item without a verified account
  // and workspace. Legacy unscoped items are quarantined separately; allowing
  // fresh unscoped writes here would make a later login look like their owner.
  if (cache.currentScope && !cache.currentScope()) {
    throw Object.assign(new Error('请先确认微信身份和个人空间；原文仍保留在输入框中'), {
      code: 'SCOPE_REQUIRED', retryable: false
    })
  }
  return cache.enqueue(action, payload, {
    id: requestId,
    coalesceKey: queueCoalesceKey(action, payload)
  })
}

function emptyConfirmedSnapshot() {
  return {
    revision: '',
    date: '',
    bootstrap: {},
    todayTodos: [],
    scheduledTodos: [],
    completedHistory: [],
    todayHistory: [],
    tasks: [],
    diaryDays: [],
    journal: { entries: [], favorites: [], hidden: [], history: [] },
    journalArchive: [],
    confirmedAt: ''
  }
}

function confirmedSnapshotKey() {
  return cache.KEYS.confirmedSnapshot || 'mainline.cloud.v2.confirmedSnapshot'
}

function readConfirmedSnapshot() {
  const value = cache.read(confirmedSnapshotKey(), {}) || {}
  const empty = emptyConfirmedSnapshot()
  return {
    ...empty,
    ...value,
    bootstrap: value.bootstrap && typeof value.bootstrap === 'object' ? value.bootstrap : {},
    todayTodos: Array.isArray(value.todayTodos) ? value.todayTodos : [],
    scheduledTodos: Array.isArray(value.scheduledTodos) ? value.scheduledTodos : [],
    completedHistory: Array.isArray(value.completedHistory) ? value.completedHistory : [],
    todayHistory: Array.isArray(value.todayHistory) ? value.todayHistory : [],
    tasks: Array.isArray(value.tasks) ? value.tasks : [],
    diaryDays: Array.isArray(value.diaryDays) ? value.diaryDays : [],
    journal: value.journal && typeof value.journal === 'object' && !Array.isArray(value.journal)
      ? value.journal
      : empty.journal,
    journalArchive: Array.isArray(value.journalArchive) ? value.journalArchive : []
  }
}

function writeConfirmedSnapshot(patch = {}) {
  const current = readConfirmedSnapshot()
  const next = {
    ...current,
    ...patch,
    confirmedAt: patch.confirmedAt || current.confirmedAt || new Date().toISOString()
  }
  cache.write(confirmedSnapshotKey(), next)
  return next
}

function confirmedSyncContext(snapshot = readConfirmedSnapshot()) {
  return {
    todayTodos: snapshot.todayTodos || [],
    tasks: { tasks: snapshot.tasks || [] },
    diaryDays: snapshot.diaryDays || [],
    journal: snapshot.journal || { entries: [], favorites: [], hidden: [], history: [] },
    journalArchive: { entries: snapshot.journalArchive || [] },
    trash: { items: [] }
  }
}

function localReadFallback(action, payload = {}) {
  const today = cache.read(cache.KEYS.todayTodos, {})
  const journal = cache.read(cache.KEYS.journal, {})
  const archive = cache.read(cache.KEYS.journalArchive, [])
  const trash = cache.read(cache.KEYS.trash, [])
  const proposals = cache.read(cache.KEYS.proposals, [])
  const tasks = cache.read(cache.KEYS.tasks, [])
  const bootstrap = cache.read(cache.KEYS.bootstrap, {})

  if (action === 'bootstrap') {
    return {
      ...bootstrap,
      onboardingRequired: false,
      offline: true,
      counts: {
        ...(bootstrap.counts || {}),
        proposals: proposals.filter((item) => item && item.status === 'pending').length,
        tasks: tasks.length
      }
    }
  }
  if (action === 'todayTodo.list') {
    return today && !Array.isArray(today) ? today : { todos: [], history: [] }
  }
  if (action === 'todayTodo.history') {
    return { history: today && !Array.isArray(today) ? (today.history || []) : [] }
  }
  if (action === 'todayTodo.completedByDate') {
    const date = String(payload.date || '')
    const rows = today && !Array.isArray(today) ? (today.completedHistory || []) : []
    return { date, todos: rows.filter((item) => currentShanghaiDateKey(Date.parse(item.completedAt)) === date) }
  }
  if (action === 'journal.overview' || action === 'journal.listToday') {
    return journal && !Array.isArray(journal)
      ? journal
      : { entries: Array.isArray(journal) ? journal : [], favorites: [], hidden: [], history: [] }
  }
  if (action === 'journal.listArchive') return { entries: Array.isArray(archive) ? archive : [] }
  if (action === 'trash.list') return { items: Array.isArray(trash) ? trash : [] }
  if (action === 'proposal.list') return { proposals: Array.isArray(proposals) ? proposals : [] }
  if (action === 'task.list') return { tasks: Array.isArray(tasks) ? tasks : [] }
  if (action === 'source.list') return { sources: [] }
  if (action === 'device.status') {
    return cache.read(cache.KEYS.deviceStatus, {
      connected: false, paired: false, deviceCount: 0, lastSyncStatus: 'offline'
    })
  }
  return null
}

function applyLocalTaskIntent(action, payload = {}, queuedAt = new Date().toISOString()) {
  const rows = cache.read(cache.KEYS.tasks, [])
  const targetId = payload.taskId || payload.id
  const nextRows = (rows || []).map((task) => {
    if (!task || task.id !== targetId) return task
    if (action === 'task.update') {
      return { ...task, ...(payload.patch || {}), pending: true, updatedAt: queuedAt }
    }
    if (action === 'task.archive') {
      return {
        ...task,
        status: 'archived',
        deletedAt: payload.deletePermanently ? queuedAt : '',
        pending: true,
        updatedAt: queuedAt
      }
    }
    if (action === 'task.completeStep') {
      const steps = (task.steps || []).map((step) => ({ ...step }))
      const completed = steps.find((step) => step.id === payload.stepId)
      if (completed) {
        completed.status = 'done'
        completed.completedAt = queuedAt
      }
      const next = steps.find((step) => step.status !== 'done')
      if (next) next.status = 'current'
      const doneCount = steps.filter((step) => step.status === 'done').length
      return {
        ...task,
        steps,
        currentStepId: next ? next.id : '',
        nextAction: next ? next.title : task.nextAction,
        progress: steps.length ? Math.round(doneCount / steps.length * 100) : 100,
        status: next ? 'active' : 'done',
        completedAt: next ? '' : queuedAt,
        pending: true,
        updatedAt: queuedAt
      }
    }
    return task
  })
  cache.write(cache.KEYS.tasks, nextRows)
  return nextRows
}

function overlayQueuedTaskIntents(rows = [], queue = []) {
  let nextRows = (rows || []).map((task) => ({ ...task }))
  for (const item of queue || []) {
    if (!item || !String(item.action || '').startsWith('task.')) continue
    const payload = item.payload || {}
    const targetId = payload.taskId || payload.id
    nextRows = nextRows.map((task) => {
      if (!task || task.id !== targetId) return task
      if (item.action === 'task.update') {
        return { ...task, ...(payload.patch || {}), pending: true, updatedAt: item.createdAt || task.updatedAt }
      }
      if (item.action === 'task.archive') {
        return {
          ...task,
          status: 'archived',
          deletedAt: payload.deletePermanently ? (item.createdAt || task.deletedAt) : '',
          pending: true,
          updatedAt: item.createdAt || task.updatedAt
        }
      }
      if (item.action === 'task.completeStep') {
        const steps = (task.steps || []).map((step) => ({ ...step }))
        const completed = steps.find((step) => step.id === payload.stepId)
        if (completed) {
          completed.status = 'done'
          completed.completedAt = item.createdAt || completed.completedAt
        }
        const next = steps.find((step) => step.status !== 'done')
        if (next) next.status = 'current'
        const doneCount = steps.filter((step) => step.status === 'done').length
        return {
          ...task,
          steps,
          currentStepId: next ? next.id : '',
          nextAction: next ? next.title : task.nextAction,
          progress: steps.length ? Math.round(doneCount / steps.length * 100) : 100,
          status: next ? 'active' : 'done',
          completedAt: next ? '' : (item.createdAt || task.completedAt),
          pending: true,
          updatedAt: item.createdAt || task.updatedAt
        }
      }
      return task
    })
  }
  return nextRows
}

function applyLocalRoutineIntent(action, payload, durableItem) {
  if (supportsJournalIntent(action)) {
    const view = refreshJournalView()
    return { journal: view.journal, localSaved: true }
  }
  if (action === 'diary.appendInput') {
    const existing = cache.read(cache.KEYS.diaryDays, []).find((day) => day.date === payload.date) || {}
    const inputs = [...(existing.manualInputs || [])]
    if (!inputs.some((input) => input.id === payload.inputId)) inputs.push({
      id: payload.inputId, content: payload.content, source: 'wechat', createdAt: durableItem.createdAt, pending: true
    })
    const day = { ...existing, id: existing.id || `day_records_${payload.date}`, date: payload.date,
      manualInputs: inputs, summary: `## 今日记录\n\n${inputs.map((item) => item.content).join('\n\n')}`,
      organizationStatus: 'pending', organizedBy: 'rules', synthesisSource: 'rules' }
    cache.write(cache.KEYS.diaryDays, [...cache.read(cache.KEYS.diaryDays, []).filter((item) => item.date !== day.date), day])
    return { day, acceptedInputId: payload.inputId, localSaved: true }
  }
  if (String(action).startsWith('todayTodo.')) {
    const current = localReadFallback('todayTodo.list') || { todos: [], history: [] }
    const visible = overlayQueuedTodoIntents(current, [durableItem])
    cache.write(cache.KEYS.todayTodos, visible)
    return { todos: visible.todos || [], history: visible.history || [] }
  }
  if (String(action).startsWith('task.')) {
    return { tasks: applyLocalTaskIntent(action, payload, durableItem.createdAt) }
  }
  return {}
}

function receivedJournalRecords(records = []) {
  const confirmed = readConfirmedSnapshot()
  const history = cache.read(cache.KEYS.historyTransfer, {}) || {}
  return historySync.mergeRows(history.records?.captures || [], [
    ...historySync.snapshotRecords(confirmed).captures, ...(confirmed.journalTombstones || []), ...records
  ])
}

function refreshJournalView(records = [], options = {}) {
  const journal = cache.read(cache.KEYS.journal, { entries: [], history: [] })
  const archive = cache.read(cache.KEYS.journalArchive, [])
  const view = projectJournal({ journal, archive, records: receivedJournalRecords(records),
    queue: options.queue || cache.read(cache.KEYS.queue, []), scope: cache.currentScope?.(),
    date: currentShanghaiDateKey() })
  cache.write(cache.KEYS.journal, view.journal)
  cache.write(cache.KEYS.journalArchive, view.archive)
  return view
}

function markLocalFallback(error) {
  const current = cache.readHybridState()
  return statusPatch({
    mode: 'local',
    homeReachable: home.configured() ? current.homeReachable : false,
    lastCloudError: String(error && error.message || '当前线路不可用').slice(0, 240)
  })
}

function isTodoAction(action) {
  return String(action || '').startsWith('todayTodo.')
}

async function preparePayloadForHome(action, payload) {
  if (action !== 'todayTodo.commentAdd' || !(payload.attachments || []).length) return payload
  const scope = activeScopeToken()
  const target = home.connection()
  const targetId = cache.attachmentConnectionId ? cache.attachmentConnectionId() : null
  const checkDestination = () => {
    assertScopeToken(scope)
    const current = home.connection()
    if (current.serverBaseUrl !== target.serverBaseUrl || current.token !== target.token ||
        (targetId && cache.attachmentConnectionId() !== targetId)) {
      throw Object.assign(new Error('电脑连接已更换，旧图片回执已隔离'), { code: 'HOME_CONNECTION_CHANGED', retryable: false })
    }
  }
  const attachments = []
  for (const attachment of payload.attachments || []) {
    checkDestination()
    attachmentStore.checkOwner(attachment)
    const upload = async () => {
      if (!attachment.localFilePath) throw Object.assign(new Error('图片原文件已失效，请恢复原图后重试'), { code: 'ATTACHMENT_UNAVAILABLE', retryable: false })
      const result = await home.uploadImage(payload.todoId, attachment, attachment.mimeType)
      if (!result?.id) throw Object.assign(new Error('电脑未确认图片上传，请重试'), { code: 'ATTACHMENT_UPLOAD_FAILED', retryable: true })
      return result
    }
    // Old embedded homeAttachment descriptors have no destination identity.
    // Reuse only receipts whose connection and immutable input are verified.
    const uploaded = targetId
      ? await attachmentStore.uploaded(payload.todoId, attachment, ['home', target.serverBaseUrl, targetId], upload, checkDestination)
      : await upload()
    checkDestination()
    attachments.push(uploaded)
  }
  return { ...payload, attachments }
}

async function cloudUploadAttachment(todoId, attachment) {
  const scope = activeScopeToken()
  attachmentStore.checkOwner(attachment)
  const bootstrap = cache.read(cache.KEYS.bootstrap, {})
  const storagePrefix = bootstrap.storagePrefix || attachment.storagePrefix
  if (!storagePrefix) throw Object.assign(new Error('尚未取得云图片存储位置'), { code: 'STORAGE_UNAVAILABLE', retryable: true })
  const fileId = String(attachment.fileID || '')
  const sameEnvironment = !config.envId || fileId.startsWith(`cloud://${config.envId}.`) || fileId.startsWith(`cloud://${config.envId}/`)
  if (fileId && sameEnvironment && attachment.cloudPath?.startsWith(`${storagePrefix}/${todoId}/`)) return attachment
  if (!attachment.localFilePath) throw Object.assign(new Error('图片原文件已失效，请恢复原图后重试'), { code: 'ATTACHMENT_UNAVAILABLE', retryable: false })
  const extension = attachment.mimeType === 'image/png' ? 'png' : attachment.mimeType === 'image/webp' ? 'webp' : 'jpg'
  const cloudPath = `${storagePrefix}/${todoId}/${attachment.id}.${extension}`
  const receipt = await attachmentStore.uploaded(todoId, attachment, ['cloud', config.envId || '', storagePrefix], async () => {
    const upload = await wx.cloud.uploadFile({ cloudPath, filePath: attachment.localFilePath })
    if (!upload.fileID) throw Object.assign(new Error('云端未确认图片上传，请重试'), { code: 'ATTACHMENT_UPLOAD_FAILED', retryable: true })
    return { cloudPath, fileID: upload.fileID }
  }, () => {
    assertScopeToken(scope)
    const currentPrefix = cache.read(cache.KEYS.bootstrap, {}).storagePrefix || attachment.storagePrefix
    if (currentPrefix !== storagePrefix) throw Object.assign(new Error('图片存储目标已变化，请确认连接后重试'), { code: 'STORAGE_TARGET_CHANGED', retryable: false })
  })
  return { ...attachment, ...receipt }
}

async function preparePayloadForCloud(action, payload) {
  if (action !== 'todayTodo.commentAdd') return payload
  const scope = activeScopeToken()
  const attachments = []
  for (const attachment of payload.attachments || []) {
    assertScopeToken(scope)
    attachments.push(await cloudUploadAttachment(payload.todoId, attachment))
    assertScopeToken(scope)
  }
  return { ...payload, attachments }
}

function rememberMirror(action, payload, destinations, requestId, options = {}) {
  if (!hybrid.isBusinessMutation(action) || !routineSyncAction(action)) return
  cache.enqueueMirror(action, { ...payload, requestId }, destinations, { ...options, id: requestId })
}

function snapshotSignature(action, data) {
  const input = `${action}:${JSON.stringify(data || {})}`
  let hash = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${input.length}_${(hash >>> 0).toString(36)}`
}

function scheduleHomeWarmRead(action, data) {
  if (MANUAL_SYNC_ONLY || !HOME_WARM_ACTIONS.has(action) || !home.configured() || typeof setTimeout !== 'function') return
  const scope = activeScopeToken()
  const guardHome = home.sessionGuard ? home.sessionGuard() : () => {}
  const key = `${scope}:${action}`
  const signature = snapshotSignature(action, data)
  if (lastHomeWarmSignatures.get(key) === signature) return
  setTimeout(async () => {
    try {
      assertScopeToken(scope)
      guardHome()
      await flushMirrorQueue()
      assertScopeToken(scope)
      guardHome()
      if (cache.read(cache.KEYS.mirrorQueue, []).some((item) => item.pendingHome)) return
      await home.rpc('hybrid.mergeCloudRead', { sourceAction: action, data }, {
        requestId: `warm_${action.replace(/\W/g, '_')}_${signature}`,
        recordMirror: false
      })
      assertScopeToken(scope)
      guardHome()
      lastHomeWarmSignatures.set(key, signature)
      markHomeReachable()
    } catch (error) {
      if (scope !== activeScopeToken() || error.code === 'HOME_CONNECTION_CHANGED') return
      markHomeOffline(error)
    }
  }, 80)
}

async function routeHome(action, payload, options = {}) {
  const scope = activeScopeToken()
  const guardHome = home.sessionGuard ? home.sessionGuard() : () => {}
  if (!home.configured()) throw Object.assign(new Error('云端额度不足，家庭服务器尚未配置，操作已保存在手机'), { code: 'HOME_UNPAIRED', retryable: true })
  if (Object.prototype.hasOwnProperty.call(options, 'homeTarget')) cache.assertHomeTarget(options)
  try {
    const prepared = await preparePayloadForHome(action, payload)
    assertScopeToken(scope)
    guardHome()
    const data = await home.rpc(action, prepared, options)
    assertScopeToken(scope)
    guardHome()
    markHomeReachable()
    if (!MANUAL_SYNC_ONLY && CLOUD_SYNC_ENABLED && hybrid.isBusinessMutation(action) && options.recordMirror !== false) {
      rememberMirror(action, payload, { cloud: true }, options.requestId || payload.requestId)
    }
    return data
  } catch (error) {
    assertScopeToken(scope)
    guardHome()
    markHomeOffline(error)
    throw error
  }
}

async function routeCloud(action, payload, options = {}) {
  const scope = activeScopeToken()
  if (!CLOUD_SYNC_ENABLED) return cloudRpc(action, payload, options)
  try {
    const prepared = await preparePayloadForCloud(action, payload)
    assertScopeToken(scope)
    const data = await cloudRpc(action, prepared, options)
    assertScopeToken(scope)
    markCloudHealthy()
    if (hybrid.isReadAction(action)) scheduleHomeWarmRead(action, data)
    if (!MANUAL_SYNC_ONLY && hybrid.isBusinessMutation(action) && home.configured() && options.recordMirror !== false) {
      rememberMirror(action, payload, { home: true }, options.requestId || payload.requestId,
        Object.prototype.hasOwnProperty.call(options, 'homeTarget') ? { homeTarget: options.homeTarget } : {})
    }
    return data
  } catch (error) {
    assertScopeToken(scope)
    if (!hybrid.isQuotaError(error)) throw error
    markQuotaBlocked(error)
    if (hybrid.isCloudOnlyAction(action)) throw error
    return routeHome(action, payload, options)
  }
}

async function transportRpc(action, payload = {}, options = {}) {
  if (!CLOUD_SYNC_ENABLED) {
    if (hybrid.isCloudOnlyAction(action)) {
      const error = new Error('当前为电脑本地模式，此功能将在以后迁移固定云服务器时开放')
      error.code = 'CLOUD_FEATURE_DISABLED'
      error.retryable = false
      throw error
    }
    return routeHome(action, payload, options)
  }
  const state = cache.readHybridState()
  if (hybrid.isCloudOnlyAction(action)) return routeCloud(action, payload, options)
  if (!state.quotaBlocked) return routeCloud(action, payload, options)
  return routeHome(action, payload, options)
}

async function readOrganizationReview(payload) {
  const scope = activeScopeToken()
  const result = await cloudRpc('organization.review', payload)
  assertScopeToken(scope)
  return result
}

async function call(action, payload = {}, options = {}) {
  const scope = activeScopeToken()
  if (MANUAL_SYNC_ONLY && MANUAL_CACHED_READS.has(String(action || '')) && options.forceRemote !== true) {
    return localReadFallback(action, payload)
  }
  const requestId = options.requestId || payload.requestId || cache.requestId(action.replace(/\W/g, '_'))
  const normalizedPayload = normalizeClientPayload(action, { ...payload, requestId })
  // Proposal decisions and AI re-analysis have server-side effects that cannot
  // be represented faithfully by the compact incremental replay protocol. If
  // they fail, surface the error without rolling back newer received rows or
  // leaving a queue item that can never be uploaded.
  const shouldQueue = !remoteRequiredMutation(action) && Boolean(options.queueOnFailure || hybrid.isBusinessMutation(action))
  const durableItem = shouldQueue
    ? enqueueRoutineAction(action, normalizedPayload, requestId)
    : null
  const localDiary = durableItem && (action === 'diary.appendInput' || supportsJournalIntent(action))
    ? applyLocalRoutineIntent(action, normalizedPayload, durableItem) : {}
  if (durableItem && manualRoutineMutation(action) && options.immediateSync !== true) {
    scheduleDirtyFlush()
    return {
      queued: true,
      requestId,
      transportMode: 'local',
      ...(action === 'diary.appendInput' || supportsJournalIntent(action) ? localDiary : applyLocalRoutineIntent(action, normalizedPayload, durableItem))
    }
  }
  try {
    const data = await transportRpc(action, normalizedPayload, { ...options, requestId,
      ...(durableItem ? { scope: durableItem.scope, homeTarget: durableItem.homeTarget } : {}) })
    assertScopeToken(scope)
    if (action === 'diary.appendInput') validateDiaryReceipt(normalizedPayload, data)
    if (action.startsWith('diary.') && data && data.day) reconcileDiaryResult(data.day)
    if (supportsJournalIntent(action) && data && (data.id || data._id)) reconcileBatchMutation(action, data)
    // Persist the receipt before removing its durable upload intention. A
    // storage failure must leave the original operation available for retry.
    if (durableItem) settleQueueBatch([durableItem], [])
    if (['workspace.switch', 'workspace.join', 'workspace.createPersonal'].includes(action)) adoptBootstrap(data)
    if (!MANUAL_SYNC_ONLY) scheduleMirrorFlush()
    return data
  } catch (error) {
    assertScopeToken(scope)
    if (hybrid.isReadAction(action) && error.retryable !== false && options.forceRemote !== true) {
      markLocalFallback(error)
      return localReadFallback(action, payload)
    }
    if (shouldQueue && error.retryable !== false) {
      scheduleDirtyFlush()
      return { queued: true, requestId, transportMode: publicHybridStatus().mode, ...localDiary }
    }
    if (durableItem) settleQueueBatch([durableItem], [failedQueueItem(durableItem, error)])
    throw error
  }
}

function flattenJournal(overview = {}) {
  return [
    ...(overview.entries || []),
    ...(overview.favorites || []),
    ...(overview.hidden || []),
    ...(overview.history || []).flatMap((group) => group.entries || [])
  ]
}

function queueContextNeeds(queue, prefix) {
  return (queue || []).some((item) => String(item.action || '').startsWith(prefix))
}

async function pullQueueContext(queue, todayData, historyDays, rpc = transportRpc) {
  const context = { todayTodos: todayData && todayData.todos || [] }
  const needsJournal = queueContextNeeds(queue, 'journal.') || queueContextNeeds(queue, 'capture.') || queueContextNeeds(queue, 'trash.')
  const needsProposals = queueContextNeeds(queue, 'proposal.')
  const needsTasks = queueContextNeeds(queue, 'task.')
  const requests = []
  if (needsJournal) requests.push(rpc('journal.overview', { historyDays }).then((value) => { context.journal = value }))
  if (queueContextNeeds(queue, 'journal.') || queueContextNeeds(queue, 'trash.')) {
    requests.push(rpc('journal.listArchive', {}).then((value) => { context.journalArchive = value }))
    requests.push(rpc('trash.list', {}).then((value) => { context.trash = value }))
  }
  if (needsProposals) requests.push(rpc('proposal.list', {}).then((value) => { context.proposals = value }))
  if (needsTasks) requests.push(rpc('task.list', {}).then((value) => { context.tasks = value }))
  await Promise.all(requests)
  return context
}

function contextRowsForAction(action, context = {}) {
  if (action.startsWith('journal.') || action.startsWith('capture.')) {
    return [...flattenJournal(context.journal), ...((context.journalArchive && context.journalArchive.entries) || [])]
  }
  if (action.startsWith('trash.')) return (context.trash && context.trash.items) || []
  if (action.startsWith('proposal.')) return (context.proposals && context.proposals.proposals) || []
  if (action.startsWith('task.')) return (context.tasks && context.tasks.tasks) || []
  return []
}

function canRebaseGeneral(action) {
  // Body edits retain their original base. Replacing that precondition with
  // the latest version would silently authorize overwriting another device.
  return ['journal.append', 'journal.toggleItem', 'journal.archive', 'journal.restore', 'journal.delete',
    'capture.setFavorite', 'capture.hide', 'capture.restoreHidden', 'task.completeStep', 'task.archive', 'trash.restore'].includes(action)
}

function rebaseGeneralQueueItem(item, context = {}) {
  if (!canRebaseGeneral(String(item && item.action || ''))) return item
  const payload = item && item.payload || {}
  if (!Object.prototype.hasOwnProperty.call(payload, 'baseVersion')) return item
  const targetId = payload.entryId || payload.taskId || payload.id
  if (!targetId) return item
  const latest = contextRowsForAction(String(item.action || ''), context).find((row) => row && (row.id === targetId || row._id === targetId))
  if (!latest || latest.version === undefined) return item
  return { ...item, payload: { ...payload, baseVersion: latest.version } }
}

async function sendWithConflict(rpc, original, latestTodos = [], context = {}, prepare = async (action, payload) => payload) {
  const policy = rebaseTodoQueueItem(original, latestTodos)
  if (policy.satisfied || policy.discarded) return { settled: true, discarded: policy.discarded, latestTodos }
  let item = rebaseGeneralQueueItem(policy.item, context)
  try {
    const payload = await prepare(item.action, item.payload)
    const data = await rpc(item.action, payload, { requestId: item.requestId || item.payload.requestId || item.id,
      scope: item.scope, homeTarget: item.homeTarget, recordMirror: false })
    return { sent: true, data, latestTodos: Array.isArray(data && data.todos) ? data.todos : latestTodos }
  } catch (error) {
    if (error.code !== 'CONFLICT') throw error
    const latestRows = Array.isArray(error.latest) ? error.latest : (error.latest ? [error.latest] : [])
    if (isTodoAction(item.action) && latestRows.length) {
      const retryPolicy = rebaseTodoQueueItem(item, latestRows)
      if (retryPolicy.satisfied || retryPolicy.discarded) return { settled: true, discarded: retryPolicy.discarded, latestTodos: latestRows }
      item = retryPolicy.item
    } else if (canRebaseGeneral(item.action) && latestRows[0] && latestRows[0].version !== undefined) {
      item = { ...item, payload: { ...item.payload, baseVersion: latestRows[0].version } }
    } else throw error
    const payload = await prepare(item.action, item.payload)
    const data = await rpc(item.action, payload, { requestId: item.requestId || item.payload.requestId || item.id,
      scope: item.scope, homeTarget: item.homeTarget, recordMirror: false })
    return { sent: true, data, latestTodos: Array.isArray(data && data.todos) ? data.todos : latestTodos }
  }
}

async function flushHomeQueueBatch(queue, options = {}) {
  const scope = activeScopeToken()
  let latestTodos = Array.isArray(options.latestTodos) ? options.latestTodos : []
  const context = options.context || {}
  const prepared = []
  const remaining = []
  let sent = 0
  let settled = 0
  let discarded = 0

  for (const original of queue) {
    try {
      const shouldRebase = options.rebase === true
      if (cache.currentScope && !sameScope(original.scope, cache.currentScope())) {
        const error = new Error('待上传内容的账号或工作区无法确认，已保留并停止发送')
        error.code = 'WORKSPACE_MISMATCH'
        error.retryable = false
        throw error
      }
      cache.assertHomeTarget(original)
      const policy = shouldRebase && isTodoAction(original.action)
        ? rebaseTodoQueueItem(original, latestTodos)
        : { item: shouldRebase ? rebaseGeneralQueueItem(original, context) : original }
      if (policy.satisfied || policy.discarded) {
        settled += 1
        if (policy.discarded) discarded += 1
        continue
      }
      const item = policy.item || original
      prepared.push({
        original,
        action: item.action,
        scope: original.scope,
        homeTarget: original.homeTarget,
        requestId: item.requestId || item.payload && item.payload.requestId || item.id,
        payload: await preparePayloadForHome(item.action, item.payload || {})
      })
      assertScopeToken(scope)
    } catch (error) {
      assertScopeToken(scope)
      remaining.push(failedQueueItem(original, error))
    }
  }

  for (let offset = 0; offset < prepared.length; offset += SYNC_PUSH_BATCH_SIZE) {
    const chunk = prepared.slice(offset, offset + SYNC_PUSH_BATCH_SIZE)
    assertScopeToken(scope)
    let data
    try {
      data = await home.batch(chunk, { timeout: 30000 })
      assertScopeToken(scope)
      markHomeReachable()
      if (Array.isArray(data && data.todos)) latestTodos = data.todos
    } catch (error) {
      assertScopeToken(scope)
      markHomeOffline(error)
      for (const item of prepared.slice(offset)) {
        remaining.push(failedQueueItem(item.original, error))
      }
      return { sent, settled, discarded, remainingItems: remaining, latestTodos }
    }

    const resultsById = new Map((data.results || []).map((item) => [item.requestId, item]))
    for (const item of chunk) {
      const result = resultsById.get(item.requestId)
      if (result && result.ok) {
        try {
          if (item.action === 'diary.appendInput') validateDiaryReceipt(item.original.payload, result.data)
          reconcileBatchMutation(item.action, result.data, { latestTodos, context })
          sent += 1
        } catch (error) {
          remaining.push(failedQueueItem(item.original, error, '结果尚未保存在手机，原操作已保留'))
        }
        continue
      }
      if (result && result.error && result.error.code === 'CONFLICT') {
        try {
          const retry = await sendWithConflict(home.rpc, item.original, latestTodos, context, preparePayloadForHome)
          assertScopeToken(scope)
          latestTodos = retry.latestTodos
          if (retry.sent) {
            if (item.action === 'diary.appendInput') validateDiaryReceipt(item.original.payload, retry.data)
            reconcileBatchMutation(item.action, retry.data, { latestTodos, context })
            sent += 1
          }
          else {
            settled += 1
            if (retry.discarded) discarded += 1
          }
          continue
        } catch (error) {
          assertScopeToken(scope)
          remaining.push(failedQueueItem(item.original, error))
          continue
        }
      }
      remaining.push(failedQueueItem(item.original, result && result.error || {}, '批量补传没有完成'))
    }
  }

  return { sent, settled, discarded, remainingItems: remaining, latestTodos }
}

function mergeEntityRow(rows, updated) {
  if (!updated || !(updated.id || updated._id)) return rows || []
  const id = updated.id || updated._id
  const cleaned = { ...updated, pending: false }
  const existing = (rows || []).some((row) => row && (row.id || row._id) === id)
  return existing
    ? (rows || []).map((row) => row && (row.id || row._id) === id ? { ...row, ...cleaned } : row)
    : [cleaned, ...(rows || [])]
}

function reconcileJournalResult(updated) {
  if (!updated || !(updated.id || updated._id)) return
  refreshJournalView([{ ...updated, pending: false }])
}

function validateDiaryReceipt(payload, data) {
  const inputId = payload.inputId || payload.requestId
  const day = data && data.day
  const original = day && (day.manualInputs || []).find(input => input.id === inputId)
  if (!day || day.date !== payload.date || data.acceptedInputId !== inputId ||
      (!day.deletedAt && !day.trashedAt && (!original || original.content !== payload.content))) {
    throw Object.assign(new Error('同步端没有确认这份日记原文，已保留待上传内容，请更新或核对连接'), {
      code: 'RECEIPT_INCOMPLETE', retryable: false
    })
  }
}

function reconcileDiaryResult(day) {
  if (!day || !day.date) return
  const confirmed = readConfirmedSnapshot()
  writeConfirmedSnapshot({ diaryDays: historySync.mergeRows(confirmed.diaryDays, [day], 'day_records') })
  const rows = cache.read(cache.KEYS.diaryDays, [])
  if (day.deletedAt || day.trashedAt || day.permanentlyPurgedAt) {
    cache.write(cache.KEYS.diaryDays, rows.filter(item => item.date !== day.date))
    return
  }
  const current = rows.find((item) => item.date === day.date) || {}
  const inputs = new Map((current.manualInputs || []).map((item) => [item.id, item]))
  for (const input of day.manualInputs || []) inputs.set(input.id, { ...input, pending: false })
  const next = { ...(Number(current.version || 0) > Number(day.version || 0) ? current : day), manualInputs: [...inputs.values()] }
  if (next.manualInputs.some((input) => input.pending)) {
    next.summary = `## 今日记录\n\n${next.manualInputs.map((input) => input.content).join('\n\n')}`
    next.organizationStatus = 'pending'
    next.organizedBy = 'rules'
    next.synthesisSource = 'rules'
  }
  cache.write(cache.KEYS.diaryDays, [...rows.filter((item) => item.date !== day.date), next])
}

function reconcileBatchMutation(action, data, state) {
  if (!data) return
  if (String(action).startsWith('diary.') && data.day) { reconcileDiaryResult(data.day); return }
  const revision = cache.KEYS.syncRevision ? String(cache.read(cache.KEYS.syncRevision, '')) : ''
  if (String(action).startsWith('todayTodo.') && Array.isArray(data.todos)) {
    state.latestTodos = data.todos
    writeConfirmedSnapshot({
      revision,
      todayTodos: data.todos,
      scheduledTodos: Array.isArray(data.scheduled) ? data.scheduled : readConfirmedSnapshot().scheduledTodos,
      todayHistory: Array.isArray(data.history) ? data.history : readConfirmedSnapshot().todayHistory,
      confirmedAt: new Date().toISOString()
    })
    cache.write(cache.KEYS.todayTodos, {
      ...(localReadFallback('todayTodo.list') || {}),
      ...data,
      todos: data.todos
    })
    return
  }
  if (String(action).startsWith('task.') && (data.id || data._id)) {
    const rows = mergeEntityRow(cache.read(cache.KEYS.tasks, []), data)
    const confirmed = readConfirmedSnapshot()
    writeConfirmedSnapshot({
      revision,
      tasks: mergeEntityRow(confirmed.tasks, data),
      confirmedAt: new Date().toISOString()
    })
    cache.write(cache.KEYS.tasks, rows)
    if (state.context) state.context.tasks = { tasks: rows }
    return
  }
  if ((String(action).startsWith('journal.') || String(action).startsWith('capture.')) && (data.id || data._id)) {
    const confirmed = readConfirmedSnapshot()
    const view = projectJournal({ journal: confirmed.journal, archive: confirmed.journalArchive,
      records: receivedJournalRecords([{ ...data, pending: false }]), date: currentShanghaiDateKey() })
    writeConfirmedSnapshot({
      revision,
      journal: view.journal,
      journalArchive: view.archive,
      journalTombstones: view.tombstones,
      confirmedAt: new Date().toISOString()
    })
    reconcileJournalResult(data)
  }
}

async function flushCloudQueueBatch(queue, options = {}) {
  const scope = activeScopeToken()
  const remaining = []
  const state = {
    latestTodos: Array.isArray(options.latestTodos) ? options.latestTodos : [],
    context: options.context || {}
  }
  let sent = 0
  let settled = 0
  let discarded = 0
  const prepared = []

  for (const original of queue) {
    try {
      if (cache.currentScope && !sameScope(original.scope, cache.currentScope())) {
        const error = new Error('待上传内容的账号或工作区无法确认，已保留并停止发送')
        error.code = 'WORKSPACE_MISMATCH'
        error.retryable = false
        throw error
      }
      const shouldRebase = options.rebase === true
      const policy = shouldRebase && isTodoAction(original.action)
        ? rebaseTodoQueueItem(original, state.latestTodos)
        : { item: shouldRebase ? rebaseGeneralQueueItem(original, state.context) : original }
      if (policy.satisfied || policy.discarded) {
        settled += 1
        if (policy.discarded) discarded += 1
        continue
      }
      const item = policy.item || original
      prepared.push({
        original,
        action: item.action,
        scope: original.scope,
        requestId: item.requestId || item.payload && item.payload.requestId || item.id,
        payload: await preparePayloadForCloud(item.action, item.payload || {})
      })
      assertScopeToken(scope)
    } catch (error) {
      assertScopeToken(scope)
      remaining.push(failedQueueItem(original, error))
    }
  }

  for (let offset = 0; offset < prepared.length; offset += SYNC_PUSH_BATCH_SIZE) {
    assertScopeToken(scope)
    const batch = prepared.slice(offset, offset + SYNC_PUSH_BATCH_SIZE)
    let data
    try {
      data = await cloudRpc('sync.push', {
        operations: batch.map(({ action, scope, requestId, payload }) => ({ action, scope, requestId, payload }))
      }, { requestId: cache.requestId('sync_push') })
      markCloudHealthy()
    } catch (error) {
      assertScopeToken(scope)
      if (hybrid.isQuotaError(error)) markQuotaBlocked(error)
      else markLocalFallback(error)
      for (const item of batch) {
        remaining.push(failedQueueItem(item.original, error))
      }
      continue
    }

    const resultsById = new Map((data && data.results || []).map((item) => [item.requestId, item]))
    const retryBatch = []
    for (const item of batch) {
      const result = resultsById.get(item.requestId)
      if (result && result.ok) {
        sent += 1
        reconcileBatchMutation(item.action, result.data, state)
        continue
      }
      if (result && result.error && result.error.code === 'CONFLICT' && result.error.latest) {
        const latestRows = Array.isArray(result.error.latest) ? result.error.latest : [result.error.latest]
        if (isTodoAction(item.action)) {
          const policy = rebaseTodoQueueItem({
            ...item.original,
            action: item.action,
            payload: item.payload,
            requestId: item.requestId
          }, latestRows)
          if (policy.satisfied || policy.discarded) {
            settled += 1
            if (policy.discarded) discarded += 1
            continue
          }
          retryBatch.push({ ...item, payload: policy.item.payload })
          continue
        }
        const latest = latestRows[0]
        if (canRebaseGeneral(item.action) && latest && latest.version !== undefined) {
          retryBatch.push({ ...item, payload: { ...item.payload, baseVersion: latest.version } })
          continue
        }
      }
      remaining.push(failedQueueItem(item.original, result && result.error || {}, '批量增量同步没有完成'))
    }

    if (retryBatch.length) {
      let retryData
      try {
        retryData = await cloudRpc('sync.push', {
          operations: retryBatch.map(({ action, scope, requestId, payload }) => ({ action, scope, requestId, payload }))
        }, { requestId: cache.requestId('sync_push_retry') })
        markCloudHealthy()
      } catch (error) {
        assertScopeToken(scope)
        if (hybrid.isQuotaError(error)) markQuotaBlocked(error)
        else markLocalFallback(error)
        for (const item of retryBatch) {
          remaining.push(failedQueueItem(item.original, error))
        }
        continue
      }
      const retryResultsById = new Map((retryData && retryData.results || []).map((item) => [item.requestId, item]))
      for (const item of retryBatch) {
        const result = retryResultsById.get(item.requestId)
        if (result && result.ok) {
          sent += 1
          reconcileBatchMutation(item.action, result.data, state)
          continue
        }
        remaining.push(failedQueueItem(item.original, result && result.error || {}, '冲突重试没有完成'))
      }
    }
  }

  return { sent, settled, discarded, remainingItems: remaining, latestTodos: state.latestTodos }
}

async function flushQueue(options = {}) {
  const scope = activeScopeToken()
  if (primaryFlushes.has(scope)) return primaryFlushes.get(scope)
  const running = flushQueueOnce(options)
  primaryFlushes.set(scope, running)
  try { return await running }
  finally { if (primaryFlushes.get(scope) === running) primaryFlushes.delete(scope) }
}

async function flushQueueOnce(options = {}) {
  const scope = activeScopeToken()
  const allQueue = cache.read(cache.KEYS.queue, [])
  const queue = allQueue.filter(retryableQueueItem)
  const deferred = allQueue.filter((item) => !retryableQueueItem(item))
  if (!queue.length) return { sent: 0, remaining: deferred.length }
  const transport = publicHybridStatus()
  if ((!CLOUD_SYNC_ENABLED || transport.mode === 'home') && home.configured()) {
    const outcome = await flushHomeQueueBatch(queue, options)
    assertScopeToken(scope)
    const next = settleQueueBatch(queue, outcome.remainingItems || [])
    return { ...outcome, remaining: next.length }
  }
  if (transport.mode !== 'cloud') return { sent: 0, remaining: allQueue.length, latestTodos: options.latestTodos || [] }
  const batched = await flushCloudQueueBatch(queue, options)
  assertScopeToken(scope)
  const next = settleQueueBatch(queue, batched.remainingItems)
  return {
    sent: batched.sent,
    settled: batched.settled,
    discarded: batched.discarded,
    remaining: next.length,
    latestTodos: batched.latestTodos
  }
}

function localSyncContext() {
  return {
    todayTodos: (localReadFallback('todayTodo.list') || {}).todos || [],
    tasks: { tasks: cache.read(cache.KEYS.tasks, []) },
    journal: cache.read(cache.KEYS.journal, { entries: [], favorites: [], hidden: [], history: [] }),
    journalArchive: { entries: cache.read(cache.KEYS.journalArchive, []) },
    trash: { items: cache.read(cache.KEYS.trash, []) }
  }
}

function cancelDirtyFlushTimer() {
  if (dirtyFlushTimer && typeof clearTimeout === 'function') clearTimeout(dirtyFlushTimer)
  dirtyFlushTimer = null
}

async function flushDirtyQueueInternal(options = {}) {
  cancelDirtyFlushTimer()
  if (!cache.read(cache.KEYS.queue, []).some(retryableQueueItem)) {
    return { sent: 0, remaining: cache.read(cache.KEYS.queue, []).length, skipped: 'clean' }
  }
  // Routine writes are push-first. Rebase only against a snapshot that was
  // explicitly confirmed by CloudBase, never against the optimistic UI cache.
  const confirmed = readConfirmedSnapshot()
  const flush = await flushQueue({
    latestTodos: confirmed.todayTodos,
    context: confirmedSyncContext(confirmed),
    rebase: Boolean(confirmed.confirmedAt)
  })
  const data = localReadFallback('todayTodo.list')
  const result = {
    bootstrap: localReadFallback('bootstrap'),
    data,
    views: localSyncContext(),
    flush,
    transport: publicHybridStatus()
  }
  const app = typeof getApp === 'function' ? getApp() : null
  if (app && app.notifySyncListeners) {
    app.notifySyncListeners({ type: 'sync-cycle', reason: options.reason || 'mutation-batch', result })
  }
  return result
}

function flushDirtyQueueNow(options = {}) {
  const scope = activeScopeToken()
  if (dirtyFlushes.has(scope)) return dirtyFlushes.get(scope)
  const startedIds = new Set(cache.read(cache.KEYS.queue, []).map((item) => item.id))
  const running = runSerialized(() => flushDirtyQueueInternal(options))
    .finally(() => {
      if (dirtyFlushes.get(scope) === running) dirtyFlushes.delete(scope)
      if (scope === activeScopeToken() && cache.read(cache.KEYS.queue, []).some((item) => retryableQueueItem(item) && !startedIds.has(item.id))) {
        scheduleDirtyFlush()
      }
    })
  dirtyFlushes.set(scope, running)
  return running
}

function scheduleDirtyFlush(delay = DIRTY_FLUSH_DEBOUNCE_MS) {
  if (!MANUAL_SYNC_ONLY || typeof setTimeout !== 'function') return null
  cancelDirtyFlushTimer()
  dirtyFlushTimer = setTimeout(() => {
    dirtyFlushTimer = null
    flushDirtyQueueNow({ reason: 'mutation-batch' }).catch((error) => {
      const app = typeof getApp === 'function' ? getApp() : null
      if (app && app.notifySyncListeners) app.notifySyncListeners({ type: 'sync-error', reason: 'mutation-batch', error })
    })
  }, Math.max(700, Math.min(900, Number(delay) || DIRTY_FLUSH_DEBOUNCE_MS)))
  return dirtyFlushTimer
}

function mirrorSummary(item) {
  const pending = ['cloud', 'home'].filter((destination) => item[destination === 'cloud' ? 'pendingCloud' : 'pendingHome'])
  const failures = pending.map((destination) => item[`${destination}Failure`]).filter(Boolean)
  const blocked = failures.find((failure) => failure.status === 'blocked')
  const failure = blocked || failures[0]
  return { ...item, status: blocked ? 'blocked' : 'pending',
    lastError: failure?.lastError || '', lastErrorCode: failure?.lastErrorCode || '' }
}

function mirrorFailure(item, destination, error, attempted = true) {
  const previous = item[`${destination}Failure`] || {}
  const failure = failedQueueItem(previous, error)
  if (!attempted) failure.attempts = Number(previous.attempts || 0)
  return mirrorSummary({ ...item, [`${destination}Status`]: failure.status,
    [`${destination}Failure`]: failure,
    attempts: Number(item.attempts || 0) + (attempted ? 1 : 0) })
}

function settleMirrorItem(original, updated, scope) {
  assertScopeToken(scope)
  // Commit each destination immediately, against the CURRENT queue. A late
  // acknowledgement never erases a new input or a coalesced replacement.
  let matched = false
  const next = cache.read(cache.KEYS.mirrorQueue, []).flatMap((current) => {
    if (current.id !== original.id || !sameInput(current, original) ||
        JSON.stringify(current.scope) !== JSON.stringify(original.scope) || current.homeTarget !== original.homeTarget) return [current]
    matched = true
    return updated.pendingCloud || updated.pendingHome ? [updated] : []
  })
  if (matched) cache.write(cache.KEYS.mirrorQueue, next)
  return matched
}

async function flushMirrorQueue(options = {}) {
  const scope = activeScopeToken()
  if (mirrorFlushes.has(scope)) return mirrorFlushes.get(scope)
  const running = (async () => {
    const guardHome = home.sessionGuard ? home.sessionGuard() : () => {}
    const queue = [...cache.read(cache.KEYS.mirrorQueue, [])]
    let sentCloud = 0, sentHome = 0
    const contexts = {}
    const scopedRpc = (rpc) => async (...args) => {
      assertScopeToken(scope)
      try {
        const data = await rpc(...args)
        assertScopeToken(scope)
        return data
      } catch (error) {
        assertScopeToken(scope)
        throw error
      }
    }
    const routes = { cloud: scopedRpc(cloudRpc), home: scopedRpc(async (...args) => {
      guardHome()
      const data = await home.rpc(...args)
      guardHome()
      return data
    }) }
    for (const original of queue) {
      assertScopeToken(scope)
      let item = JSON.parse(JSON.stringify(original))
      let problem
      if (!sameScope(item.scope, cache.currentScope ? cache.currentScope() : null)) {
        problem = { code: 'UNSCOPED_QUEUE', message: '待传内容归属未确认，已保留，请恢复原账号后处理', retryable: false }
      } else if (!routineSyncAction(item.action)) {
        problem = { code: 'UNSUPPORTED_ACTION', message: '此操作暂不支持同步，原内容已保留', retryable: false }
      } else if (MANUAL_SYNC_ONLY) {
        problem = { code: 'SYNC_MODE_PAUSED', message: '备用同步已暂停，旧待传内容已保留', retryable: false }
      }
      for (const destination of ['cloud', 'home']) {
        const pendingKey = destination === 'cloud' ? 'pendingCloud' : 'pendingHome'
        if (!item[pendingKey]) continue
        let unavailable = problem
        if (!unavailable && destination === 'cloud' && !CLOUD_SYNC_ENABLED) {
          unavailable = { code: 'CLOUD_DISABLED', message: '云端同步已停用，待传内容已保留', retryable: false }
        }
        if (!unavailable && destination === 'home' && !home.configured()) {
          unavailable = { code: 'HOME_UNPAIRED', message: '电脑同步尚未配置，待传内容已保留', retryable: false }
        }
        if (!unavailable && destination === 'home') {
          try { cache.assertHomeTarget(item) } catch (error) { unavailable = error }
        }
        if (unavailable) {
          item = mirrorFailure(item, destination, unavailable, false)
          if (!settleMirrorItem(original, item, scope)) break
          continue
        }
        const failure = item[`${destination}Failure`]
        // Configuration pauses recover when the corresponding route is enabled.
        // Permission/validation conflicts require an explicit retry action.
        if (failure?.status === 'blocked' && !options.retryBlocked &&
            !['SYNC_MODE_PAUSED', 'CLOUD_DISABLED', 'HOME_UNPAIRED'].includes(failure.lastErrorCode)) continue
        if (destination === 'cloud' && cache.readHybridState().quotaBlocked && !options.forceCloud) continue
        try {
          if (destination === 'home') guardHome()
          const rpc = routes[destination]
          if (!contexts[destination]) {
            const bundle = await rpc('todayTodo.list', { historyDays: 14 }, { requestId: cache.requestId('mirror_pull') })
            const context = await pullQueueContext(
              queue.filter((entry) => entry[pendingKey] && sameScope(entry.scope, item.scope) && routineSyncAction(entry.action)),
              bundle, 14, rpc)
            assertScopeToken(scope)
            contexts[destination] = { todos: bundle.todos || [], context }
          }
          const current = contexts[destination]
          const prepare = destination === 'cloud' ? preparePayloadForCloud : preparePayloadForHome
          const outcome = await sendWithConflict(rpc, item, current.todos, current.context, prepare)
          assertScopeToken(scope)
          if (destination === 'home') guardHome()
          current.todos = outcome.latestTodos
          item = mirrorSummary({ ...item, [pendingKey]: false, [`${destination}Status`]: 'confirmed', [`${destination}Failure`]: null })
          const checkpointed = settleMirrorItem(original, item, scope)
          if (destination === 'cloud') sentCloud += 1
          else { sentHome += 1; markHomeReachable() }
          if (!checkpointed) break
        } catch (error) {
          assertScopeToken(scope)
          if (destination === 'home') guardHome()
          // A failed local checkpoint must stop; a cloud receipt alone cannot
          // justify clearing local work or continuing to another destination.
          if (String(error.code || '').startsWith('LOCAL_STORAGE_')) throw error
          if (destination === 'cloud' && hybrid.isQuotaError(error)) markQuotaBlocked(error)
          if (destination === 'home') markHomeOffline(error)
          item = mirrorFailure(item, destination, error)
          if (!settleMirrorItem(original, item, scope)) break
        }
      }
    }
    assertScopeToken(scope)
    const remaining = cache.read(cache.KEYS.mirrorQueue, [])
    return { sentCloud, sentHome, remaining: remaining.length,
      blocked: remaining.filter((item) => item.status === 'blocked').length, disabled: MANUAL_SYNC_ONLY, scope }
  })()
  mirrorFlushes.set(scope, running)
  try { return await running } finally { if (mirrorFlushes.get(scope) === running) mirrorFlushes.delete(scope) }
}

function scheduleMirrorFlush() {
  if (typeof setTimeout !== 'function') return
  const scope = activeScopeToken()
  setTimeout(() => {
    if (scope === activeScopeToken()) flushMirrorQueue().catch(() => {})
  }, 50)
}

async function maybeRecoverCloud(options = {}) {
  const scope = activeScopeToken()
  if (!CLOUD_SYNC_ENABLED) return { recovered: false, reason: 'cloud-disabled' }
  const state = cache.readHybridState()
  if (!state.quotaBlocked) return { recovered: false, reason: 'cloud-active' }
  if (!options.force && Date.now() < state.cloudProbeAfter) return { recovered: false, reason: 'probe-not-due' }
  if (recoveryRequests.has(scope)) return recoveryRequests.get(scope)
  const running = (async () => {
    statusPatch({ mode: 'recovering' })
      try {
        const bootstrapData = await cloudRpc('bootstrap', {}, { requestId: cache.requestId('quota_probe') })
        assertScopeToken(scope)
        const remote = bootstrapData.account
        if (cache.currentScope && (!remote || !sameScope(cache.currentScope(),
          { userId: remote.user?.id, workspaceId: remote.workspaceId }))) {
          throw Object.assign(new Error('云端账号或空间已变化，旧待传内容已保留，请重新确认登录身份'), {
            code: 'WORKSPACE_MISMATCH', retryable: false })
        }
        cache.write(cache.KEYS.bootstrap, bootstrapData)
        markCloudHealthy()
        const mirror = await flushMirrorQueue({ forceCloud: true })
        assertScopeToken(scope)
        const app = typeof getApp === 'function' ? getApp() : null
        if (app && bootstrapData.syncChannel) {
          app.startRealtimeSync(bootstrapData.syncChannel, bootstrapData.syncWorkspaceId)
        }
        return { recovered: true, bootstrap: bootstrapData, mirror }
    } catch (error) {
      assertScopeToken(scope)
      if (hybrid.isQuotaError(error)) markQuotaBlocked(error)
      else statusPatch({ mode: hybrid.fallbackMode(home.configured(), cache.readHybridState().homeReachable), cloudProbeAfter: Date.now() + CLOUD_PROBE_INTERVAL_MS })
      return { recovered: false, reason: error.message, code: error.code }
    }
  })()
  recoveryRequests.set(scope, running)
  try { return await running } finally { if (recoveryRequests.get(scope) === running) recoveryRequests.delete(scope) }
}

async function bootstrap() {
  const scope = activeScopeToken()
  if (CLOUD_SYNC_ENABLED && cache.readHybridState().quotaBlocked) await maybeRecoverCloud()
  assertScopeToken(scope)
  let data
  let remoteConfirmed = false
  try {
    data = await transportRpc('bootstrap')
    remoteConfirmed = true
  } catch (error) {
    assertScopeToken(scope)
    if (error.retryable === false) throw error
    markLocalFallback(error)
    data = localReadFallback('bootstrap')
  }
  if (remoteConfirmed) adoptBootstrap(data)
  if (publicHybridStatus().mode !== 'local') cache.write(cache.KEYS.bootstrap, data)
  const app = typeof getApp === 'function' ? getApp() : null
  if (app && data.syncChannel && publicHybridStatus().mode === 'cloud') app.startRealtimeSync(data.syncChannel, data.syncWorkspaceId)
  return data
}

async function receiveStreamHistory(snapshot, options = {}) {
  const scope = activeScopeToken()
  const fromHome = snapshot.source === 'home'
  const guard = fromHome ? home.sessionGuard() : () => {}
  const connectionId = fromHome ? cache.attachmentConnectionId() : ''
  const rpc = fromHome ? home.rpc : transportRpc
  const key = fromHome ? cache.KEYS.homeHistoryTransfer : cache.KEYS.historyTransfer || 'mainline.cloud.v2.historyTransfer'
  const saved = cache.read(key, {}) || {}
  if (fromHome && (!snapshot.epoch || !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0)) {
    throw Object.assign(new Error('电脑历史标识无效，已停止接收'), { code: 'HISTORY_HEADER_INVALID', retryable: false })
  }
  if (fromHome && saved.epoch && saved.epoch !== snapshot.epoch) {
    throw Object.assign(new Error('连接指向了另一份电脑数据，请先核对个人空间；原缓存和待传内容已保留'), { code: 'WORKSPACE_MISMATCH', retryable: false })
  }
  let progress = saved.protocol === 2 && (!fromHome || saved.connectionId === connectionId) ? saved : {
    protocol: 2, phase: 'history', records: saved.records || (fromHome ? historySync.emptyRecords() : historySync.snapshotRecords(readConfirmedSnapshot())), sequence: 0,
    ...(fromHome ? { epoch: snapshot.epoch, connectionId } : {})
  }
  const quota = { functionCalls: 0, metadataReads: 0, businessReadQueries: 0, returnedDocuments: 0, payloadBytes: 0 }
  const budget = Math.max(1, Math.min(20, Math.floor(Number(options.historyPageBudget) || 8)))
  let error = null
  if (progress.phase === 'idle' && progress.sequence !== snapshot.sequence) progress = { ...progress, phase: 'changes', cursor: null }
  for (let i = 0; progress.phase !== 'idle' && i < budget; i++) {
    if (i && options.shouldContinue && !options.shouldContinue()) break
    try {
      const action = progress.phase === 'history' ? 'sync.historyPage' : 'sync.changes'
      guard()
      const page = await rpc(action, { cursor: progress.cursor, after: progress.sequence, limit: 99 })
      assertScopeToken(scope)
      guard()
      if (fromHome && (page.source !== 'home' || page.epoch !== snapshot.epoch)) throw Object.assign(new Error('历史分页来自另一数据空间，进度未更新'), { code: 'WORKSPACE_MISMATCH', retryable: false })
      if (page.hasMore && JSON.stringify(page.nextCursor) === JSON.stringify(progress.cursor)) throw Object.assign(new Error('接收进度没有前进，已保存内容仍保留'), { code: 'HISTORY_PAGE_STALLED' })
      const records = historySync.mergePage(progress.records, page)
      let next = { ...progress, records, cursor: page.nextCursor, updatedAt: new Date().toISOString() }
      if (progress.phase === 'history' && !page.hasMore) {
        if (!Number.isSafeInteger(page.nextCursor.changeAfter)) throw Object.assign(new Error('历史缺少增量起点，进度尚未确认'), { code: 'HISTORY_ANCHOR_MISSING' })
        next = { ...next, phase: 'changes', cursor: null, sequence: page.nextCursor.changeAfter }
      } else if (progress.phase === 'changes' && !page.hasMore) {
        next = { ...next, phase: 'idle', cursor: null, sequence: page.nextCursor.through }
      }
      cache.write(key, next)
      progress = next
      for (const field of Object.keys(quota)) quota[field] += Number(page.quota && page.quota[field] || 0)
    } catch (failure) {
      assertScopeToken(scope)
      guard()
      error = { code: failure.code || 'HISTORY_RECEIVE_FAILED', message: failure.message || '接收尚未完成', retryable: failure.retryable }
      break
    }
  }
  return { records: progress.records, pending: progress.phase !== 'idle', supported: true, error, quota }
}

async function receiveHistory(snapshot, options = {}) {
  if (snapshot.historyProtocol === 2) return receiveStreamHistory(snapshot, options)
  const scope = activeScopeToken()
  const key = cache.KEYS.historyTransfer || 'mainline.cloud.v2.historyTransfer'
  const previous = cache.read(key, {}) || {}
  let progress = { ...previous, records: historySync.mergeRecords(
    previous.records || historySync.snapshotRecords(readConfirmedSnapshot()), historySync.snapshotRecords(snapshot)
  ) }
  const quota = { functionCalls: 0, businessReadQueries: 0, returnedDocuments: 0, payloadBytes: 0 }
  if (snapshot.historyProtocol !== 1) return { records: progress.records, pending: false, supported: false, quota }
  const budget = Math.max(1, Math.min(20, Number(options.historyPageBudget) || 8))
  let error = null
  for (let i = 0; !progress.complete && i < budget; i++) {
    if (i && options.shouldContinue && !options.shouldContinue()) break
    try {
      const page = await transportRpc('sync.historyPage', { cursor: progress.cursor, limit: 99 })
      assertScopeToken(scope)
      if (page.hasMore && JSON.stringify(page.nextCursor) === JSON.stringify(progress.cursor)) throw Object.assign(new Error('历史分页没有前进，已收到的内容仍保留'), { code: 'HISTORY_PAGE_STALLED' })
      const records = historySync.mergePage(progress.records, page)
      const next = { records, cursor: page.nextCursor, complete: !page.hasMore, startedRevision: progress.startedRevision || snapshot.revision || '', updatedAt: new Date().toISOString() }
      // Data and its resume cursor are one atomic local-storage write. A failed
      // storage write cannot acknowledge a page whose records were not saved.
      cache.write(key, next)
      progress = next
      for (const field of Object.keys(quota)) quota[field] += Number(page.quota && page.quota[field] || 0)
    } catch (failure) {
      assertScopeToken(scope)
      error = { code: failure.code || 'HISTORY_RECEIVE_FAILED', message: failure.message || '历史接收尚未完成', retryable: failure.retryable }
      break
    }
  }
  if (progress.complete && JSON.stringify(previous.records) !== JSON.stringify(progress.records)) cache.write(key, progress)
  return { records: progress.records, pending: !progress.complete, supported: true, error, quota }
}

async function syncNowInternal(options = {}) {
  const syncScope = activeScopeToken()
  if (CLOUD_SYNC_ENABLED && cache.readHybridState().quotaBlocked) await maybeRecoverCloud({ force: Boolean(options.forceCloudProbe) })

  // Upload durable local intents before receiving. A rebase is allowed only
  // against data stored in the cloud-confirmed snapshot.
  const confirmedBeforePush = readConfirmedSnapshot()
  const flush = options.skipQueueFlush === true
    ? { sent: 0, remaining: cache.read(cache.KEYS.queue, []).length, latestTodos: confirmedBeforePush.todayTodos }
    : await flushQueue({
        latestTodos: confirmedBeforePush.todayTodos,
        context: confirmedSyncContext(confirmedBeforePush),
        rebase: Boolean(confirmedBeforePush.confirmedAt)
      })

  const localJournal = cache.read(cache.KEYS.journal, { entries: [], favorites: [], hidden: [], history: [] })
  const localJournalArchive = cache.read(cache.KEYS.journalArchive, [])
  let bootstrapData = null
  let data = null
  let tasks = null
  let journal = localJournal
  let journalArchive = localJournalArchive
  let diaryDays = cache.read(cache.KEYS.diaryDays, [])
  let remoteData = null
  let remoteFresh = false
  let history = null
  let receiveError = null

  if (options.includeBootstrap === false) {
    data = await transportRpc('todayTodo.list', { includeHistory: false })
    if (!Array.isArray(data.completedHistory)) data.completedHistory = readConfirmedSnapshot().completedHistory
    tasks = localReadFallback('task.list').tasks || []
    remoteData = data
    remoteFresh = true
    writeConfirmedSnapshot({
      revision: cache.KEYS.syncRevision ? String(cache.read(cache.KEYS.syncRevision, '')) : '',
      date: currentShanghaiDateKey(),
      todayTodos: data.todos || [],
      scheduledTodos: data.scheduled || [],
      completedHistory: data.completedHistory || [],
      todayHistory: data.history || [],
      confirmedAt: new Date().toISOString()
    })
  } else try {
    const knownRevision = cache.KEYS.syncRevision ? String(cache.read(cache.KEYS.syncRevision, '')) : ''
    const snapshotDateKey = cache.KEYS.syncSnapshotDate || 'mainline.cloud.v2.syncSnapshotDate'
    const snapshotScopeKey = cache.KEYS.syncSnapshotScopeVersion || 'mainline.cloud.v2.syncSnapshotScopeVersion'
    const snapshotScopeProbeKey = cache.KEYS.syncSnapshotScopeProbeVersion || 'mainline.cloud.v2.syncSnapshotScopeProbeVersion'
    const receiptRepairKey = cache.KEYS.syncReceiptRepairVersion || 'mainline.cloud.v2.syncReceiptRepairVersion'
    const receiptRepairPending = Number(cache.read(receiptRepairKey, 0)) < 1
    const scopeRepairPending = Number(cache.read(snapshotScopeKey, 0)) < SNAPSHOT_SCOPE_VERSION &&
      Number(cache.read(snapshotScopeProbeKey, 0)) < SNAPSHOT_SCOPE_VERSION
    const knownDate = String(cache.read(snapshotDateKey, ''))
    const currentDate = currentShanghaiDateKey()
    // Existing installations may have a revision but no separated confirmed
    // snapshot yet. Force exactly one full snapshot during that migration.
    const confirmedReady = Boolean(readConfirmedSnapshot().confirmedAt)
    const snapshotCacheReady = confirmedReady && cache.KEYS.syncSnapshotReady
      ? cache.read(cache.KEYS.syncSnapshotReady, false) === true
      : false
    // Existing caches did not record a date. The cloud-side daily revision
    // marker keeps those installations safe; once a dated snapshot is stored,
    // a local Shanghai-day change forces exactly one full refresh.
    const cacheReady = snapshotCacheReady && (!knownDate || knownDate === currentDate) && !receiptRepairPending && !scopeRepairPending
    const snapshot = await transportRpc('sync.snapshot', { includeHistory: false, knownRevision, knownDate, cacheReady, historyProtocol: 2 })
    assertScopeToken(syncScope)
    const app = typeof getApp === 'function' ? getApp() : null
    if (snapshot?.source === 'home' && snapshot.capabilities?.socket === 1) app?.startHomeRealtimeSync?.({ revision: snapshot.notificationRevision })
    else app?.stopHomeRealtimeSync?.()
    if (snapshot && (snapshot.streamProtocol === 2 || snapshot.notModified || snapshot.data && Array.isArray(snapshot.tasks))) history = await receiveHistory(snapshot, options)
    assertScopeToken(syncScope)
    if (snapshot && (snapshot.streamProtocol === 2 || snapshot.notModified === true)) {
      const confirmed = readConfirmedSnapshot()
      bootstrapData = localReadFallback('bootstrap')
      data = localReadFallback('todayTodo.list')
      tasks = localReadFallback('task.list').tasks || []
      journal = localJournal
      journalArchive = localJournalArchive
      diaryDays = cache.read(cache.KEYS.diaryDays, [])
      remoteData = confirmed.confirmedAt
        ? { todos: confirmed.todayTodos, scheduled: confirmed.scheduledTodos, completedHistory: confirmed.completedHistory, history: confirmed.todayHistory }
        : null
      remoteFresh = Boolean(confirmed.confirmedAt)
      if (cache.KEYS.syncRevision && snapshot.revision) cache.write(cache.KEYS.syncRevision, snapshot.revision)
      if (snapshot.date) {
        cache.write(snapshotDateKey, snapshot.date)
        writeConfirmedSnapshot({ date: snapshot.date })
      }
      // An older cloud endpoint may ignore cacheReady and still return
      // notModified. Record this bounded probe so an unsupported endpoint does
      // not trigger a full-snapshot attempt on every app foreground.
      if (scopeRepairPending) cache.write(snapshotScopeProbeKey, SNAPSHOT_SCOPE_VERSION)
      if (history && history.supported) {
        const received = historySync.project(history.records, snapshot.date || currentDate)
        data = received.data; tasks = received.tasks; journal = received.journal
        journalArchive = received.journalArchive; diaryDays = received.diaryDays
        remoteData = data
        writeConfirmedSnapshot({ tasks, diaryDays, journal, journalArchive, todayTodos: data.todos, scheduledTodos: data.scheduled, completedHistory: data.completedHistory, todayHistory: data.history })
        if (snapshot.streamProtocol === 2) {
          remoteFresh = !history.pending
          writeConfirmedSnapshot({ revision: String(snapshot.revision || ''), date: snapshot.date || currentDate, bootstrap: bootstrapData || {} })
          if (cache.KEYS.syncSnapshotReady) cache.write(cache.KEYS.syncSnapshotReady, true)
          cache.write(receiptRepairKey, 1)
          cache.write(snapshotScopeKey, SNAPSHOT_SCOPE_VERSION)
          cache.write(snapshotScopeProbeKey, SNAPSHOT_SCOPE_VERSION)
          const app = typeof getApp === 'function' ? getApp() : null
          if (app && app.startRealtimeSync && snapshot.syncChannel) app.startRealtimeSync(snapshot.syncChannel, snapshot.syncWorkspaceId)
        }
      }
    } else if (!snapshot || !snapshot.data || !Array.isArray(snapshot.data.todos) || !Array.isArray(snapshot.tasks)) {
      throw Object.assign(new Error('当前同步端不支持轻量快照'), { code: 'SNAPSHOT_UNAVAILABLE', retryable: true })
    } else {
      bootstrapData = snapshot.bootstrap || null
      const received = history.supported
        ? historySync.project(history.records, snapshot.date || currentDate)
        : historySync.mergeLegacySnapshot(snapshot, readConfirmedSnapshot())
      data = received.data
      tasks = received.tasks
      journal = received.journal
      journalArchive = received.journalArchive
      diaryDays = received.diaryDays
      remoteData = data
      remoteFresh = true
      writeConfirmedSnapshot({
        revision: String(snapshot.revision || ''),
        date: String(snapshot.date || currentDate),
        bootstrap: bootstrapData || {},
        todayTodos: data.todos || [],
        scheduledTodos: data.scheduled || [],
        completedHistory: data.completedHistory || [],
        todayHistory: data.history || [],
        tasks,
        diaryDays,
        journal,
        journalArchive,
        confirmedAt: new Date().toISOString()
      })
      if (bootstrapData) cache.write(cache.KEYS.bootstrap, bootstrapData)
      if (cache.KEYS.syncRevision && snapshot.revision) cache.write(cache.KEYS.syncRevision, snapshot.revision)
      cache.write(snapshotDateKey, String(snapshot.date || currentDate))
      if (cache.KEYS.syncSnapshotReady) cache.write(cache.KEYS.syncSnapshotReady, true)
      if (receiptRepairPending) cache.write(receiptRepairKey, 1)
      if (scopeRepairPending) {
        cache.write(snapshotScopeProbeKey, SNAPSHOT_SCOPE_VERSION)
        const includedScopes = Array.isArray(snapshot.includedScopes) ? snapshot.includedScopes : []
        if (includedScopes.includes('daily_diary') || Array.isArray(snapshot.diaryDays)) {
          cache.write(snapshotScopeKey, SNAPSHOT_SCOPE_VERSION)
        }
      }
    }
  } catch (snapshotError) {
    if (snapshotError.retryable === false) throw snapshotError
    receiveError = { code: snapshotError.code, message: snapshotError.message, retryable: snapshotError.retryable }
    remoteFresh = false
    markLocalFallback(snapshotError)
    bootstrapData = localReadFallback('bootstrap')
    data = localReadFallback('todayTodo.list')
    tasks = localReadFallback('task.list').tasks || []
    journal = localJournal
    journalArchive = localJournalArchive
    diaryDays = cache.read(cache.KEYS.diaryDays, [])
  }

  if (bootstrapData && bootstrapData.onboardingRequired) {
    return { bootstrap: bootstrapData, data: null, flush, transport: publicHybridStatus() }
  }

  const remainingQueue = cache.read(cache.KEYS.queue, [])
  assertScopeToken(syncScope)
  // An input written while a page was in flight belongs to the local queue;
  // preserve it for display without labeling it cloud-confirmed.
  diaryDays = historySync.mergeRows(cache.read(cache.KEYS.diaryDays, []),
    history?.supported ? history.records.day_records || [] : diaryDays, 'day_records')
    .filter(day => !day.deletedAt && !day.trashedAt && !day.permanentlyPurgedAt)
  const visibleTasks = overlayQueuedTaskIntents(tasks || [], remainingQueue)
  const confirmed = readConfirmedSnapshot()
  const date = bootstrapData?.date || confirmed.date || currentShanghaiDateKey()
  let journalRecords = []
  if (history?.supported || confirmed.journalTombstones?.length) {
    journalRecords = receivedJournalRecords(history?.supported ? history.records.captures || [] : [])
    const received = projectJournal({ journal: confirmed.journal, archive: confirmed.journalArchive, records: journalRecords, date })
    const patch = { journal: received.journal, journalArchive: received.archive, journalTombstones: received.tombstones }
    if (Object.keys(patch).some((key) => JSON.stringify(confirmed[key]) !== JSON.stringify(patch[key]))) writeConfirmedSnapshot(patch)
  }
  const visible = projectJournal({ journal, archive: journalArchive,
    localJournal: cache.read(cache.KEYS.journal, localJournal), localArchive: cache.read(cache.KEYS.journalArchive, localJournalArchive),
    records: journalRecords, queue: remainingQueue, scope: cache.currentScope?.(), date })
  const visibleJournal = visible.journal, visibleJournalArchive = visible.archive
  const context = {
    todayTodos: data.todos || [],
    tasks: { tasks: visibleTasks },
    diaryDays,
    journal: visibleJournal,
    journalArchive: { entries: visibleJournalArchive }
  }
  const visibleData = overlayQueuedTodoIntents(data, remainingQueue)
  cache.write(cache.KEYS.todayTodos, visibleData)
  cache.write(cache.KEYS.journal, visibleJournal)
  cache.write(cache.KEYS.journalArchive, visibleJournalArchive)
  cache.write(cache.KEYS.tasks, visibleTasks)
  cache.write(cache.KEYS.diaryDays, diaryDays)
  if (!MANUAL_SYNC_ONLY) scheduleMirrorFlush()
  return { bootstrap: bootstrapData, data: visibleData, remoteData, remoteFresh: remoteFresh && !(history && history.pending), receiveError, history: history && { pending: history.pending, supported: history.supported, error: history.error, quota: history.quota }, views: context, flush, transport: publicHybridStatus() }
}

function syncNow(options = {}) {
  return runSerialized(() => syncNowInternal(options))
}

function isManualSyncOnly() {
  return MANUAL_SYNC_ONLY
}

async function mutateTodayTodoInternal(action, payload = {}, options = {}) {
  const scope = activeScopeToken()
  const requestId = options.requestId || payload.requestId || cache.requestId(action.replace(/\W/g, '_'))
  const queuedPayload = normalizeClientPayload(action, { ...payload, requestId })
  const durableItem = enqueueRoutineAction(action, queuedPayload, requestId)
  if (manualRoutineMutation(action) && options.immediateSync !== true) {
    scheduleDirtyFlush()
    return {
      queued: true,
      requestId,
      transportMode: 'local',
      ...applyLocalRoutineIntent(action, queuedPayload, durableItem)
    }
  }
  const finish = (value) => { assertScopeToken(scope); cache.dequeue(durableItem.id); return value }
  try {
    return finish(await transportRpc(action, queuedPayload, { ...options, requestId }))
  } catch (error) {
    assertScopeToken(scope)
    if (error.code !== 'CONFLICT') {
      if (error.retryable !== false) return { queued: true, requestId, transportMode: publicHybridStatus().mode }
      settleQueueBatch([durableItem], [failedQueueItem(durableItem, error)])
      throw error
    }
    try {
      const conflictRows = Array.isArray(error.latest) ? error.latest : (error.latest ? [error.latest] : [])
      const refreshed = conflictRows.length ? { todos: conflictRows } : await transportRpc('todayTodo.list', { historyDays: options.historyDays || 14 })
      const retryPolicy = rebaseTodoQueueItem({ action, payload: queuedPayload }, refreshed.todos)
      if (retryPolicy.satisfied || retryPolicy.discarded) {
        const full = conflictRows.length ? await transportRpc('todayTodo.list', { historyDays: options.historyDays || 14 }) : refreshed
        return finish({ ...full, satisfied: retryPolicy.satisfied, discarded: retryPolicy.discarded })
      }
      return finish(await transportRpc(action, retryPolicy.item.payload, { requestId }))
    } catch (retryError) {
      assertScopeToken(scope)
      if (retryError.retryable !== false) return { queued: true, requestId, transportMode: publicHybridStatus().mode }
      settleQueueBatch([durableItem], [failedQueueItem(durableItem, retryError)])
      throw retryError
    }
  }
}

function mutateTodayTodo(action, payload = {}, options = {}) {
  return runSerialized(() => mutateTodayTodoInternal(action, payload, options))
}

function hasPendingQueue() {
  return cache.read(cache.KEYS.queue, []).length > 0 || cache.read(cache.KEYS.mirrorQueue, []).length > 0
}

function prepareTodayTodoPayload(content, date = currentShanghaiDateKey()) {
  return normalizeClientPayload('todayTodo.add', { content, date })
}

async function uploadImage(todoId, image, mimeType, storagePrefix = '') {
  const scope = activeScopeToken()
  const descriptor = await attachmentStore.save(todoId, image, mimeType, storagePrefix)
  assertScopeToken(scope)
  if (MANUAL_SYNC_ONLY) return descriptor
  const state = cache.readHybridState()
  if (CLOUD_SYNC_ENABLED && !state.quotaBlocked) {
    try { return await cloudUploadAttachment(todoId, descriptor) } catch (error) {
      assertScopeToken(scope)
      if (!hybrid.isQuotaError(error)) throw error
      markQuotaBlocked(error)
    }
  }
  if (home.configured()) {
    try {
      const prepared = await preparePayloadForHome('todayTodo.commentAdd', { todoId, attachments: [descriptor] })
      descriptor.homeAttachment = prepared.attachments[0]
      assertScopeToken(scope)
      markHomeReachable()
    } catch (error) { assertScopeToken(scope); markHomeOffline(error) }
  }
  return descriptor
}

async function testHomeConnection(candidate) {
  const scope = activeScopeToken()
  const data = await home.testConnection(candidate)
  assertScopeToken(scope)
  markHomeReachable()
  return data
}

function saveHomeConnection(candidate) {
  return cache.writeConnection(candidate)
}

function watchHomeChanges(onChange, onStatus, options = {}) {
  if (!home.configured()) return { close() {} }
  return options.socket ? home.watchSocket(onChange, onStatus, options) : home.watch(onChange, onStatus)
}

module.exports = {
  previewHomeRecovery: homeRecovery.preview, confirmHomeRecovery: homeRecovery.confirm,
  loadAttachmentPreviews: attachmentPreviews.resolve,
  readOrganizationReview,
  call, flushQueue, flushMirrorQueue, bootstrap, syncNow, mutateTodayTodo, organizePendingDiaries, organizePendingJournals,
  hasPendingQueue, isManualSyncOnly, getHybridStatus: publicHybridStatus, maybeRecoverCloud,
  scheduleDirtyFlush, flushDirtyQueueNow,
  testHomeConnection, saveHomeConnection, homeConnection: home.connection,
  homeConfigured: home.configured, watchHomeChanges, uploadImage, saveImage: attachmentStore.save, prepareTodayTodoPayload,
  autoPinHighPriorityTodosEnabled, splitTodayTodoInput,
  __test: {
    cancelDirtyFlushTimer, settleQueueBatch, failedQueueItem,
    cloudRpc, transportRpc, normalizeClientPayload, preparePayloadForCloud, preparePayloadForHome,
    localReadFallback, queueCoalesceKey, flushCloudQueueBatch, DIRTY_FLUSH_DEBOUNCE_MS,
    CLOUD_SYNC_ENABLED, CLOUD_RPC_TIMEOUT_MS, remoteRequiredMutation, splitTodayTodoInput, cloudRpc
  }
}
