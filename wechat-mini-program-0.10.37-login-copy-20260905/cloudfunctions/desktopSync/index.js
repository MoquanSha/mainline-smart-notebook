'use strict'

const tcb = require('@cloudbase/node-sdk')
const crypto = require('crypto')
const { mergeRecord, mergeOriginals, syncMetadata } = require('./record-merge')
const releaseIdentity = require('./release-identity.json')

const ENV_ID = process.env.CLOUDBASE_ENV_ID || process.env.TCB_ENV || process.env.SCF_NAMESPACE || 'YOUR_CLOUDBASE_ENV_ID'
const app = tcb.init({ env: ENV_ID, timeout: 90000 })
const { withSyncSequence, readHead, headId } = require('./sync-database')
const { createHistoryPager, createChangePager } = require('./history-page')
const db = withSyncSequence(app.database())
const attachmentAccess = require('./attachment-access').createAttachmentAccess({ db, app })
const _ = db.command
const WECHAT_OPEN_APPID = String(process.env.WECHAT_OPEN_APPID || '').trim()
const WECHAT_OPEN_APPSECRET = String(process.env.WECHAT_OPEN_APPSECRET || '').trim()
const WECHAT_OPEN_REDIRECT_URI = String(process.env.WECHAT_OPEN_REDIRECT_URI || '').trim()
let ticketApp = null
try {
  const credentials = process.env.CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS
    ? JSON.parse(process.env.CLOUDBASE_CUSTOM_LOGIN_CREDENTIALS)
    : null
  if (credentials) ticketApp = tcb.init({ env: ENV_ID, credentials, timeout: 30000 })
} catch (error) {
  console.error('Custom login credentials are invalid:', safeMessage(error))
}

const COLLECTIONS = [
  'tasks', 'daily_tasks', 'captures', 'day_records'
]
const SECRET_FIELDS = new Set(['apiKey', 'token', 'deviceToken', 'secret', 'password', 'providerApiKey'])
const USER_JOURNAL_SOURCES = new Set([
  'manual', 'wechat', 'wechat_mp', 'wechat_kf', 'wecom',
  'mobile', 'home', 'desktop'
])
const CODEX_INTERNAL_KINDS = new Set([
  'user_prompt', 'assistant_message', 'assistant_response', 'tool', 'tool_call',
  'tool_output', 'reasoning', 'codex_message', 'session_event'
])
const AUTH_CACHE_TTL_MS = 5 * 60 * 1000
const DEVICE_HEARTBEAT_WRITE_INTERVAL_MS = 60 * 1000
const PULL_CURSOR_VERSION = 5
const PULL_CURSOR_SEEN_LIMIT = 100
const authCache = new Map()

function nowIso() { return new Date().toISOString() }
function orderedSyncEnabled() {
  return process.env.ENABLE_ORDERED_SYNC === 'true' && process.env.ORDERED_SYNC_INDEXES_VERIFIED === 'true'
}
function uid(prefix) { return `${prefix}_${Date.now()}_${crypto.randomBytes(7).toString('hex')}` }
function hash(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex') }
function attachmentPrefix(ownerOpenId) { return `todo-comments/${hash(ownerOpenId).slice(0, 24)}` }
function deviceWorkspaceId(device) { return String(device && (device.workspaceId || device.ownerOpenId) || '') }
function cloudDocumentId(workspaceId, collection, logicalId) {
  return ['day_records', 'planning_profiles'].includes(collection)
    ? `${hash(workspaceId).slice(0, 12)}_${logicalId}`
    : logicalId
}
function realtimeCustomUserId(deviceId) { return `device_${hash(deviceId).slice(0, 24)}` }
function safeMessage(error) {
  if (error && error.message) return String(error.message).slice(0, 500)
  if (error && typeof error === 'object') {
    try { return JSON.stringify(error).slice(0, 500) } catch {}
  }
  return String(error || '未知错误').slice(0, 500)
}
function ok(data) { return { ok: true, data } }
function fail(code, message, extra = {}) { return { ok: false, error: { code, message, ...extra } } }

function normalizeEvent(event) {
  if (event && typeof event.body === 'string') {
    try { return { ...event, ...JSON.parse(event.body) } } catch (error) { return event }
  }
  return event || {}
}

function tokenFrom(event) {
  const headers = event.headers || event.header || {}
  const authorization = headers.authorization || headers.Authorization || ''
  return event.token || authorization.replace(/^Bearer\s+/i, '')
}

async function getDoc(collection, id) {
  try {
    const result = await db.collection(collection).doc(id).get()
    return result && result.data && (Array.isArray(result.data) ? result.data[0] : result.data) || null
  } catch (error) {
    if (/not exist|不存在|DATABASE_REQUEST_FAILED/i.test(safeMessage(error))) return null
    throw error
  }
}

async function setDoc(collection, id, data) {
  const { _id, ...payload } = data || {}
  return db.collection(collection).doc(id).set(payload)
}

function identityId(provider, providerUserId) { return `identity_${provider}_${hash(providerUserId).slice(0, 32)}` }
function membershipId(workspaceId, userId) { return `membership_${hash(`${workspaceId}:${userId}`).slice(0, 40)}` }
async function requireDeviceRole(device, allowed) {
  const workspaceId = deviceWorkspaceId(device), userId = String(device.userId || device.pairedByUserId || '')
  const membership = workspaceId && userId ? await getDoc('memberships', membershipId(workspaceId, userId)) : null
  if (!membership || membership.workspaceId !== workspaceId || membership.userId !== userId || membership.status !== 'active' || !allowed.includes(membership.role)) {
    throw Object.assign(new Error('只有空间管理员可以执行该操作'), { code: 'FORBIDDEN' })
  }
  return membership
}
function qrLoginConfigured() {
  return Boolean(WECHAT_OPEN_APPID && WECHAT_OPEN_APPSECRET && WECHAT_OPEN_REDIRECT_URI)
}

async function ensureWeChatWorkspace(profile) {
  const unionId = String(profile.unionid || '').trim()
  const openId = String(profile.openid || '').trim()
  if (!unionId && !openId) throw Object.assign(new Error('微信登录没有返回有效身份'), { code: 'WECHAT_IDENTITY_INVALID' })
  let identity = null
  if (unionId) {
    const byUnion = await db.collection('identities').where({ unionId, deletedAt: '' }).limit(1).get()
    identity = byUnion.data && byUnion.data[0] || null
  }
  if (!identity && openId) identity = await getDoc('identities', identityId('wechat_open', openId))
  const at = nowIso()
  if (identity && identity.userId && identity.activeWorkspaceId) {
    if (unionId && identity.unionId !== unionId) await db.collection('identities').doc(identity._id || identity.id).update({ unionId, updatedAt: at })
    return { userId: identity.userId, workspaceId: identity.activeWorkspaceId }
  }
  const stable = unionId || openId
  const userId = `user_${hash(stable).slice(0, 32)}`
  const workspaceId = `workspace_${hash(stable).slice(0, 32)}`
  const provider = unionId ? 'wechat_union' : 'wechat_open'
  const providerUserId = unionId || openId
  await setDoc('users', userId, { id: userId, displayName: String(profile.nickname || '微信用户').slice(0, 80), status: 'active', createdAt: at, updatedAt: at, version: 1, deletedAt: '', source: 'wechat', sourceIds: [] })
  await setDoc('workspaces', workspaceId, { id: workspaceId, name: 'Mainline Notebook', plan: 'beta', accessOpenIds: [], status: 'active', createdByUserId: userId, createdAt: at, updatedAt: at, version: 1, deletedAt: '', source: 'wechat', sourceIds: [] })
  await setDoc('memberships', membershipId(workspaceId, userId), { id: membershipId(workspaceId, userId), workspaceId, userId, role: 'owner', status: 'active', joinedAt: at, createdAt: at, updatedAt: at, version: 1, deletedAt: '', source: 'wechat', sourceIds: [] })
  await setDoc('identities', identityId(provider, providerUserId), { id: identityId(provider, providerUserId), provider, providerUserId, unionId: unionId || '', userId, activeWorkspaceId: workspaceId, createdAt: at, updatedAt: at, version: 1, deletedAt: '', source: 'wechat', sourceIds: [] })
  return { userId, workspaceId }
}

async function exchangeWeChatCode(code) {
  if (!qrLoginConfigured()) throw Object.assign(new Error('微信扫码登录尚未配置，请先设置开放平台参数'), { code: 'WECHAT_QR_NOT_CONFIGURED' })
  const url = new URL('https://api.weixin.qq.com/sns/oauth2/access_token')
  url.searchParams.set('appid', WECHAT_OPEN_APPID)
  url.searchParams.set('secret', WECHAT_OPEN_APPSECRET)
  url.searchParams.set('code', String(code || ''))
  url.searchParams.set('grant_type', 'authorization_code')
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload.errcode) throw Object.assign(new Error(payload.errmsg || '微信授权交换失败'), { code: 'WECHAT_OAUTH_FAILED' })
  return payload
}

async function createMiniProgramQrLogin(deviceName = '主线笔记 Windows') {
  // The desktop shows a normal QR that contains only this unguessable,
  // one-time scene. The mini-program scans it from inside WeChat and performs
  // the authorization with its own OpenID. This avoids server-side
  // cloud.openapi, whose WeChat token exists only when a mini-program client
  // directly triggered that cloud function.
  const id = `qr_login_${crypto.randomBytes(11).toString('hex')}`
  const pollToken = crypto.randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
  await setDoc('devices', id, {
    id, status: 'qr_waiting', loginScene: id, loginPollTokenHash: hash(pollToken),
    loginExpiresAt: expiresAt, deviceName: String(deviceName || 'Windows 电脑').slice(0, 80),
    createdAt: nowIso(), updatedAt: nowIso(), version: 1, deletedAt: '',
    source: 'desktop_qr_mini_program', sourceIds: []
  })
  return {
    sessionId: id,
    pollToken,
    loginMode: 'mini_program_scanner',
    loginUrl: `https://mainline-notebook.local/desktop-login?scene=${encodeURIComponent(id)}`,
    qrDataUrl: '',
    expiresAt
  }
}

async function createQrLogin(deviceName = '主线笔记 Windows') {
  if (!qrLoginConfigured()) return createMiniProgramQrLogin(deviceName)
  const id = uid('qr_login')
  const state = crypto.randomBytes(24).toString('base64url')
  const pollToken = crypto.randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
  await setDoc('devices', id, { id, status: 'qr_waiting', loginStateHash: hash(state), loginPollTokenHash: hash(pollToken), loginExpiresAt: expiresAt, deviceName: String(deviceName || 'Windows 电脑').slice(0, 80), createdAt: nowIso(), updatedAt: nowIso(), version: 1, deletedAt: '', source: 'desktop_qr', sourceIds: [] })
  const login = new URL('https://open.weixin.qq.com/connect/qrconnect')
  login.searchParams.set('appid', WECHAT_OPEN_APPID)
  login.searchParams.set('redirect_uri', WECHAT_OPEN_REDIRECT_URI)
  login.searchParams.set('response_type', 'code')
  login.searchParams.set('scope', 'snsapi_login')
  login.searchParams.set('state', `${id}.${state}`)
  return { sessionId: id, pollToken, loginMode: 'open_platform', loginUrl: `${login.toString()}#wechat_redirect`, qrDataUrl: '', expiresAt }
}

async function completeQrCallback(code, state) {
  const [id, rawState] = String(state || '').split('.', 2)
  if (!id || !rawState) throw Object.assign(new Error('微信登录状态无效'), { code: 'WECHAT_STATE_INVALID' })
  const device = await getDoc('devices', id)
  if (!device || device.status !== 'qr_waiting' || device.loginStateHash !== hash(rawState)) throw Object.assign(new Error('微信登录会话无效或已使用'), { code: 'WECHAT_STATE_INVALID' })
  if (Date.parse(device.loginExpiresAt || '') < Date.now()) throw Object.assign(new Error('微信登录二维码已过期'), { code: 'WECHAT_QR_EXPIRED' })
  const account = await ensureWeChatWorkspace(await exchangeWeChatCode(code))
  await db.collection('devices').doc(id).update({ status: 'qr_authorized', loginUserId: account.userId, loginWorkspaceId: account.workspaceId, updatedAt: nowIso(), version: Number(device.version || 1) + 1 })
  return { sessionId: id, authorized: true }
}

async function pollQrLogin(sessionId, pollToken) {
  const device = await getDoc('devices', String(sessionId || ''))
  if (!device || !String(device.id || device._id || '').startsWith('qr_login_')) throw Object.assign(new Error('登录会话不存在'), { code: 'NOT_FOUND' })
  if (!pollToken || device.loginPollTokenHash !== hash(pollToken)) throw Object.assign(new Error('登录会话凭证无效'), { code: 'UNAUTHENTICATED' })
  if (device.status === 'qr_waiting' && Date.parse(device.loginExpiresAt || '') < Date.now()) {
    await db.collection('devices').doc(device._id || device.id).update({ status: 'qr_expired', updatedAt: nowIso() })
    return { status: 'expired' }
  }
  if (device.status !== 'qr_authorized') return { status: device.status === 'qr_expired' ? 'expired' : 'waiting' }
  const token = crypto.randomBytes(32).toString('base64url')
  const pairedAt = nowIso()
  await db.collection('devices').doc(device._id || device.id).update({ status: 'paired', deviceTokenHash: hash(token), deviceId: device._id || device.id, workspaceId: device.loginWorkspaceId, userId: device.loginUserId, pairedAt, lastSeenAt: pairedAt, updatedAt: pairedAt, version: Number(device.version || 1) + 1 })
  return { status: 'authorized', token, deviceId: device._id || device.id, workspaceId: device.loginWorkspaceId, userId: device.loginUserId, pairedAt }
}

async function cancelQrLogin(sessionId, pollToken) {
  const device = await getDoc('devices', String(sessionId || ''))
  if (!device || !String(device.id || device._id || '').startsWith('qr_login_')) return { cancelled: false }
  if (!pollToken || device.loginPollTokenHash !== hash(pollToken)) {
    throw Object.assign(new Error('登录会话凭证无效'), { code: 'UNAUTHENTICATED' })
  }
  if (device.status !== 'qr_waiting') return { cancelled: false, status: device.status }
  await db.collection('devices').doc(device._id || device.id).update({ status: 'qr_cancelled', updatedAt: nowIso() })
  return { cancelled: true }
}

async function markSyncSignal(ownerOpenId, source, action = 'desktop.sync', sourceDeviceId = '') {
  const id = `sync_signal_${hash(ownerOpenId).slice(0, 32)}`
  const changedAt = nowIso()
  const revision = uid('revision')
  const result = await db.collection('sync_signals').doc(id).update({
    source, action, sourceDeviceId, changedAt, revision, updatedAt: changedAt, version: _.inc(1)
  }).catch((error) => {
    if (/not exist|不存在|DATABASE_REQUEST_FAILED/i.test(safeMessage(error))) return { updated: 0 }
    throw error
  })
  if (Number(result && result.updated || 0) > 0) return { changedAt, revision }
  const workspace = await getDoc('workspaces', ownerOpenId)
  await setDoc('sync_signals', id, {
    id, kind: 'sync_signal', source, action, sourceDeviceId, changedAt,
    ownerOpenId, workspaceId: ownerOpenId, accessOpenIds: workspace && workspace.accessOpenIds || [],
    revision, createdAt: changedAt, updatedAt: changedAt, version: 1,
    deletedAt: '', sourceIds: []
  })
  return { changedAt, revision }
}

function sanitize(value, key = '') {
  if (SECRET_FIELDS.has(key)) return undefined
  if (Array.isArray(value)) return value.map((item) => sanitize(item)).filter((item) => item !== undefined)
  if (value && typeof value === 'object') {
    const output = {}
    for (const [childKey, childValue] of Object.entries(value)) {
      const cleaned = sanitize(childValue, childKey)
      if (cleaned !== undefined) output[childKey] = cleaned
    }
    return output
  }
  if (typeof value === 'string' && /^(?:[A-Z]:\\|\/Users\/|file:\/\/)/i.test(value)) return ''
  return value
}

function isUserAuthoredJournalDocument(value) {
  if (!value || value.entryKind !== 'journal_entry') return false
  const source = String(value.source || '').toLowerCase()
  if (USER_JOURNAL_SOURCES.has(source)) return true
  if (source !== 'codex' || CODEX_INTERNAL_KINDS.has(String(value.kind || '').toLowerCase())) return false
  return Boolean(
    String(value.journalTitle || '').trim() &&
    String(value.markdown || value.organizedContent || value.organizationSummary || value.journalSummary || '').trim()
  )
}

function sanitizeJournalDocument(value) {
  if (!isUserAuthoredJournalDocument(value)) return null
  const fields = [
    'id', 'entryKind', 'source', 'kind', 'intent', 'status',
    'occurredAt', 'createdAt', 'updatedAt', 'version', 'deletedAt',
    'journalTitle', 'journalSummary', 'journalType', 'markdown',
    'organizedContent', 'organizationSummary', 'organizationStatus', 'organizationHost', 'aiError',
    'checklistItems', 'journalSupplements', 'journalDate',
    'journalArchived', 'archivedAt', 'favoritedAt', 'hiddenAt',
    'trashedAt', 'purgeAt', 'trashOrigin'
  ]
  const selected = {}
  for (const field of fields) {
    if (value && value[field] !== undefined) selected[field] = value[field]
  }
  // User originals are primary data. Page byte limits reject an oversized
  // record explicitly; no serializer may silently drop its body.
  for (const field of ['rawContent', 'content']) {
    if (String(value.source || '').toLowerCase() === 'codex') break
    if (value && value[field] !== undefined) {
      selected[field] = String(value[field])
    }
  }
  selected.entryKind = 'journal_entry'
  Object.assign(selected, syncMetadata(value))
  if (String(value.source || '').toLowerCase() === 'codex' && selected.conflictVersions) {
    selected.conflictVersions = selected.conflictVersions.map((item) => {
      const { content, rawContent, rawInput, ...body } = item.body || {}
      return { ...item, body }
    })
  }
  return sanitize(selected)
}

function sanitizeDayRecordDocument(value) {
  const date = String(value && value.date || '')
  const summary = String(value && value.summary || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !summary) return null
  const periods = (Array.isArray(value.periods) ? value.periods : []).slice(0, 24).map((period, index) => ({
    id: String(period && period.id || `period-${index + 1}`).slice(0, 160),
    date: String(period && period.date || date).slice(0, 10),
    startTime: String(period && period.startTime || '').slice(0, 5),
    endTime: String(period && period.endTime || '').slice(0, 5),
    title: String(period && period.title || '').trim().slice(0, 160),
    summary: String(period && period.summary || '').trim().slice(0, 1200),
    status: ['completed', 'in_progress', 'blocked'].includes(period && period.status) ? period.status : 'completed',
    outcomes: (Array.isArray(period && period.outcomes) ? period.outcomes : []).map((item) => String(item).trim().slice(0, 300)).filter(Boolean).slice(0, 20),
    remaining: (Array.isArray(period && period.remaining) ? period.remaining : []).map((item) => String(item).trim().slice(0, 300)).filter(Boolean).slice(0, 20)
  })).filter((period) => period.title || period.summary)
  const manualInputs = (Array.isArray(value.manualInputs) ? value.manualInputs : []).map((item, index) => ({
    id: String(item && item.id || `diary-input-${index + 1}`).slice(0, 160),
    ...(item.conflictOf ? { conflictOf: item.conflictOf } : {}),
    content: String(item && item.content || ''),
    createdAt: String(item && item.createdAt || '').slice(0, 40),
    source: ['desktop', 'wechat', 'mobile'].includes(item && item.source) ? item.source : 'desktop'
  })).filter((item) => item.content)
  return sanitize({
    id: `day_records_${date}`,
    ...syncMetadata(value),
    date,
    headline: String(value.headline || '今日小记').slice(0, 120),
    summary,
    periods,
    synthesisSource: value.synthesisSource === 'llm' ? 'llm' : 'rules',
    synthesisUpdatedAt: String(value.synthesisUpdatedAt || value.updatedAt || '').slice(0, 40),
    organizedBy: ['deepseek', 'codex', 'rules'].includes(value.organizedBy) ? value.organizedBy : undefined,
    organizationStatus: ['organized', 'pending', 'fallback', 'failed'].includes(value.organizationStatus) ? value.organizationStatus : undefined,
    inputRevision: String(value.inputRevision || ''),
    organizationRevision: String(value.organizationRevision || ''),
    ...(value.manualInputs !== undefined ? { manualInputs } : {}),
    updatedAt: String(value.updatedAt || value.synthesisUpdatedAt || '').slice(0, 40)
  })
}

const SYNC_META_FIELDS = new Set([
  '_id', '_syncSequence', '_desktopContentHash', 'ownerOpenId', 'workspaceId', 'accessOpenIds',
  'cloudVersion', 'version', 'createdAt', 'updatedAt', 'sourceIds', 'sourceCaptureIds'
])

function stableComparable(value, key = '') {
  if (SYNC_META_FIELDS.has(key)) return undefined
  if (Array.isArray(value)) return value.map((item) => stableComparable(item)).filter((item) => item !== undefined)
  if (value && typeof value === 'object') {
    const output = {}
    for (const childKey of Object.keys(value).sort()) {
      const child = stableComparable(value[childKey], childKey)
      if (child !== undefined) output[childKey] = child
    }
    return output
  }
  return value
}

function sameSyncContent(left, right) {
  return JSON.stringify(stableComparable(left)) === JSON.stringify(stableComparable(right))
}

function documentForDesktop(document) {
  if (!document) return document
  const { _id, _syncSequence, _desktopContentHash, ownerOpenId, workspaceId, accessOpenIds, sourceIds, sourceCaptureIds, ...visible } = document
  return visible
}

function orderedDocument(collection, document) {
  if (collection === 'daily_tasks' && document.entryKind !== 'today_todo') return null
  if (collection === 'captures') return documentForDesktop(sanitizeJournalDocument({ ...document, id: document.id || document._id }))
  return documentForDesktop({ ...document, id: document.id || document._id })
}
const historyPage = createHistoryPager({ db, serialize: orderedDocument })
const changePage = createChangePager({ db, serialize: orderedDocument })
function requireOrderedSync() {
  if (!orderedSyncEnabled()) throw Object.assign(new Error('完整历史协议尚未启用或索引尚未验收'), { code: 'SYNC_PROTOCOL_NOT_ENABLED' })
}

async function authorize(token) {
  if (!token) throw Object.assign(new Error('缺少设备令牌'), { code: 'UNAUTHENTICATED' })
  const tokenHash = hash(token)
  const now = Date.now()
  const cached = authCache.get(tokenHash)
  let device = cached && cached.expiresAt > now ? cached.device : null
  if (!device) {
    const result = await db.collection('devices').where({ deviceTokenHash: tokenHash, status: 'paired', deletedAt: '' }).limit(1).get()
    device = result.data && result.data[0]
  }
  if (!device) throw Object.assign(new Error('设备令牌无效，请重新使用微信扫码登录'), { code: 'UNAUTHENTICATED' })
  const lastHeartbeatAt = Number(cached && cached.lastHeartbeatAt || Date.parse(device.lastSeenAt || '') || 0)
  if (now - lastHeartbeatAt >= DEVICE_HEARTBEAT_WRITE_INTERVAL_MS) {
    const seenAt = nowIso()
    await db.collection('devices').doc(device._id).update({ lastSeenAt: seenAt, updatedAt: seenAt })
    device = { ...device, lastSeenAt: seenAt, updatedAt: seenAt }
  }
  authCache.set(tokenHash, {
    device,
    expiresAt: now + AUTH_CACHE_TTL_MS,
    lastHeartbeatAt: Math.max(lastHeartbeatAt, Date.parse(device.lastSeenAt || '') || now)
  })
  return device
}

async function realtimeTicket(device, options = {}) {
  if (!ticketApp) return { available: false, reason: 'CUSTOM_LOGIN_NOT_CONFIGURED' }
  const customUserId = realtimeCustomUserId(device._id || device.id)
  const ticket = ticketApp.auth().createTicket(customUserId, {
    refresh: 60 * 60 * 1000,
    expire: Date.now() + 24 * 60 * 60 * 1000
  })
  return {
    available: true,
    envId: ENV_ID,
    ticket,
    customUserId,
    workspaceId: deviceWorkspaceId(device),
    ...(Number(options.protocol) === 2 && orderedSyncEnabled()
      ? { protocol: 2, signalId: headId(deviceWorkspaceId(device)), signalKind: 'sync_head' }
      : { signalId: `sync_signal_${hash(deviceWorkspaceId(device)).slice(0, 32)}`, signalKind: 'sync_signal' })
  }
}

async function bindRealtimeUid(device, uid) {
  const workspaceId = deviceWorkspaceId(device)
  const safeUid = String(uid || '').trim().slice(0, 128)
  if (!workspaceId || !safeUid || !/^[A-Za-z0-9_:@.\-+#~(){}\[\],<>]+$/.test(safeUid)) {
    throw Object.assign(new Error('Realtime user identity is invalid.'), { code: 'VALIDATION' })
  }
  const current = await getDoc('sync_access', safeUid)
  const at = nowIso()
  await setDoc('sync_access', safeUid, {
    ...current, id: safeUid, userId: device.userId || device.pairedByUserId || '',
    deviceId: device._id || device.id, activeWorkspaceId: workspaceId,
    createdAt: current && current.createdAt || at, updatedAt: at,
    version: Number(current && current.version || 0) + 1,
    deletedAt: '', source: 'security', sourceIds: []
  })
  return { bound: true, workspaceId, signalId: `sync_signal_${hash(workspaceId).slice(0, 32)}` }
}

function currentShanghaiDateKey() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function pullDocumentId(document) {
  return String(document && (document.id || document._id) || '')
}

function pullDocumentToken(document) {
  return [
    String(document && document.updatedAt || ''),
    String(document && document.version || ''),
    String(document && document._desktopContentHash || '')
  ].join('|')
}

function normalizePullPosition(position = {}) {
  const rawSeen = position && typeof position.seen === 'object' && !Array.isArray(position.seen)
    ? position.seen
    : {}
  const seen = {}
  for (const [id, token] of Object.entries(rawSeen).slice(-PULL_CURSOR_SEEN_LIMIT)) {
    if (id) seen[String(id)] = String(token || '')
  }
  return { at: String(position && position.at || ''), seen }
}

function normalizePullCursor(cursor) {
  if (cursor && typeof cursor === 'object' && Number(cursor.v) === PULL_CURSOR_VERSION) {
    return {
      v: PULL_CURSOR_VERSION,
      positions: Object.fromEntries(COLLECTIONS.map((collection) => [
        collection,
        normalizePullPosition(cursor.positions && cursor.positions[collection])
      ]))
    }
  }
  const legacyAt = typeof cursor === 'string' ? cursor : ''
  const legacyPositions = cursor && typeof cursor === 'object' && Number(cursor.v) === 2
    ? cursor.positions || {}
    : {}
  return {
    v: PULL_CURSOR_VERSION,
    positions: Object.fromEntries(COLLECTIONS.map((collection) => [collection, {
      at: String(legacyPositions[collection] && legacyPositions[collection].at || legacyAt),
      // Version 2 stored only a numeric skip. Replaying the small boundary is
      // required because an already-seen document may since have moved forward
      // after a phone status update.
      seen: {}
    }]))
  }
}

function pullDocumentAlreadySeen(document, position) {
  const at = String(document && document.updatedAt || '')
  if (!position.at || at !== position.at) return false
  const id = pullDocumentId(document)
  return Boolean(id && position.seen && position.seen[id] === pullDocumentToken(document))
}

function selectPullDocuments(documents, position) {
  return (documents || []).filter((document) => !pullDocumentAlreadySeen(document, position))
}

function nextPullPosition(position, documents) {
  if (!documents || !documents.length) return normalizePullPosition(position)
  const lastAt = String(documents[documents.length - 1].updatedAt || '')
  const seen = lastAt === position.at ? { ...(position.seen || {}) } : {}
  for (const document of documents) {
    if (String(document.updatedAt || '') !== lastAt) continue
    const id = pullDocumentId(document)
    if (id) seen[id] = pullDocumentToken(document)
  }
  return normalizePullPosition({ at: lastAt, seen })
}

function collectionPullScope(collection) {
  if (collection === 'captures') return { entryKind: 'journal_entry' }
  if (collection === 'daily_tasks') return { entryKind: 'today_todo' }
  return {}
}

async function pull(ownerOpenId, cursor = '', limit = 500) {
  const changes = []
  const bounded = Math.max(1, Math.min(Number(limit || 500), 1000))
  const nextCursor = normalizePullCursor(cursor)
  let hasMore = false
  for (const collection of COLLECTIONS) {
    const remaining = bounded - changes.length
    if (remaining <= 0) {
      hasMore = true
      break
    }
    const pageSize = Math.min(100, remaining)
    const position = normalizePullPosition(nextCursor.positions[collection])
    const scope = collectionPullScope(collection)
    const filter = position.at
      ? { ownerOpenId, ...scope, updatedAt: _.gte(position.at) }
      : { ownerOpenId, ...scope }
    let result = await db.collection(collection).where(filter).orderBy('updatedAt', 'asc').limit(pageSize).get()
    let documents = result.data || []
    let selected = selectPullDocuments(documents, position)
    // A boundary containing 100 equal-timestamp documents can fill a page with
    // already-seen rows. Only in that rare case issue one strict follow-up query;
    // ordinary syncs keep the original one-query-per-collection cost.
    if (
      position.at && documents.length >= pageSize && !selected.length &&
      documents.every((document) => String(document.updatedAt || '') === position.at)
    ) {
      result = await db.collection(collection).where({
        ownerOpenId, ...scope, updatedAt: _.gt(position.at)
      }).orderBy('updatedAt', 'asc').limit(pageSize).get()
      documents = result.data || []
      selected = documents
    }
    for (const document of selected) {
      if (collection === 'captures' && !isUserAuthoredJournalDocument(document)) continue
      changes.push({ collection, document: documentForDesktop(document) })
    }
    if (documents.length) {
      nextCursor.positions[collection] = nextPullPosition(position, documents)
    }
    if (documents.length >= pageSize) hasMore = true
  }
  return { changes, nextCursor, hasMore }
}

function mergeDiaryOriginals(existing, incoming) {
  return mergeOriginals(existing || [], incoming || [])
}

function diaryInputsRevision(inputs) {
  return hash(JSON.stringify((inputs || []).map(({ id, content }) => ({ id, content })).sort((a, b) => a.id.localeCompare(b.id))))
}

async function pushDiaryOperation(ownerOpenId, operation) {
  const data = sanitizeDayRecordDocument(operation.data)
  const id = String(operation.id || data?.id || '')
  if (!data) return { status: 'unchanged', value: { collection: 'day_records', id, excluded: true } }
  const storageId = cloudDocumentId(ownerOpenId, 'day_records', data.id)
  return db.runTransaction(async (tx) => {
    const ref = tx.collection('day_records').doc(storageId)
    const result = await ref.get()
    const current = Array.isArray(result.data) ? result.data[0] : result.data
    if (current && current.ownerOpenId !== ownerOpenId) throw Object.assign(new Error('日记不属于当前空间'), { code: 'FORBIDDEN' })
    const receipt = (status, document) => ({ status, value: { collection: 'day_records', id, version: Number(document.version || 1), document: documentForDesktop(document) } })
    const contentHash = String(operation.contentHash || '').slice(0, 64)
    if (current && contentHash && current._desktopContentHash === contentHash) return receipt('unchanged', current)
    if (current && operation.baseVersion !== undefined && Number(current.version || 1) !== Number(operation.baseVersion)) {
      return { status: 'conflicts', value: { collection: 'day_records', id, latest: documentForDesktop(current) } }
    }
    const merged = mergeRecord(current || {}, { ...data, ...(operation.deletedAt ? { deletedAt: operation.deletedAt } : {}) }, {
      preserveConflicts: operation.baseVersion === undefined || Boolean(data.conflictVersions?.length)
    })
    if (current && sameSyncContent(current, merged)) return receipt('unchanged', current)
    const next = {
      ...merged,
      ownerOpenId, workspaceId: ownerOpenId, id: data.id,
      createdAt: current?.createdAt || nowIso(), updatedAt: nowIso(),
      deletedAt: merged.deletedAt || '',
      version: Number(current?.version || 0) + 1, source: 'desktop', sourceIds: [],
      _desktopContentHash: contentHash
    }
    const { _id, ...document } = next
    if (Buffer.byteLength(JSON.stringify(document), 'utf8') > 800000) throw Object.assign(new Error('当天日记超过云存储容量，完整原文仍在电脑保留'), { code: 'DIARY_CAPACITY' })
    await ref.set(document)
    return receipt('applied', document)
  })
}

async function pushRecordOperation(ownerOpenId, operation) {
  const collection = operation.collection
  if (!['tasks', 'daily_tasks', 'captures'].includes(collection)) throw Object.assign(new Error('不支持的记录类型'), { code: 'VALIDATION' })
  const id = String(operation.id || operation.data?.id || '')
  if (!id || id.length > 160) throw Object.assign(new Error('记录编号无效，原文保留在本机'), { code: 'VALIDATION' })
  const incoming = collection === 'captures' ? sanitizeJournalDocument(operation.data || {}) : sanitize(operation.data || {})
  if (!incoming) return { status: 'unchanged', value: { collection, id, excluded: true } }
  delete incoming.sourceIds
  delete incoming.sourceCaptureIds
  const data = { ...incoming, id, ...(operation.deletedAt ? { deletedAt: operation.deletedAt } : {}) }
  return db.runTransaction(async (tx) => {
    const ref = tx.collection(collection).doc(cloudDocumentId(ownerOpenId, collection, id))
    const result = await ref.get()
    const current = Array.isArray(result.data) ? result.data[0] : result.data
    if (current && current.ownerOpenId !== ownerOpenId) throw Object.assign(new Error('记录不属于当前空间'), { code: 'FORBIDDEN' })
    const receipt = (status, document) => ({ status, value: { collection, id, version: Number(document.version || 1), document: documentForDesktop(document) } })
    const contentHash = String(operation.contentHash || '')
    if (current && contentHash && current._desktopContentHash === contentHash) return receipt('unchanged', current)
    if (current && operation.baseVersion !== undefined && Number(current.version || 1) !== Number(operation.baseVersion)) {
      return { status: 'conflicts', value: { collection, id, latest: documentForDesktop(current) } }
    }
    // A matching baseVersion alone never authorizes resurrection. A restore
    // must name the deletion it intentionally reverses.
    const merged = mergeRecord(current, data, { preserveConflicts: operation.baseVersion === undefined || Boolean(data.conflictVersions?.length) })
    if (current && sameSyncContent(current, merged)) return receipt('unchanged', current)
    const { _id, ...document } = {
      ...merged, id, ownerOpenId, workspaceId: ownerOpenId,
      createdAt: current?.createdAt || data.createdAt || nowIso(), updatedAt: nowIso(),
      version: Number(current?.version || 0) + 1, source: data.source || current?.source || 'desktop',
      sourceIds: [], deletedAt: merged.deletedAt || '', _desktopContentHash: contentHash
    }
    if (Buffer.byteLength(JSON.stringify(document), 'utf8') > 800000) throw Object.assign(new Error('记录及冲突原文超过云存储容量，完整内容仍保留在本机'), { code: 'RECORD_CAPACITY' })
    await ref.set(document)
    return receipt('applied', document)
  })
}

async function push(ownerOpenId, operations = [], sourceDeviceId = '') {
  if (!Array.isArray(operations) || operations.length > 200) throw Object.assign(new Error('单次同步最多 200 项'), { code: 'VALIDATION' })
  const applied = []
  const unchanged = []
  const conflicts = []
  // Keep version checks, but process independent documents in groups of ten.
  // A full first sync otherwise performs hundreds of database calls serially.
  for (let index = 0; index < operations.length; index += 10) {
    const group = operations.slice(index, index + 10)
    await Promise.all(group.map(async (operation) => {
      if (!COLLECTIONS.includes(operation.collection)) return
      if (operation.collection === 'day_records') {
        const result = await pushDiaryOperation(ownerOpenId, operation)
        ;({ applied, unchanged, conflicts })[result.status].push(result.value)
        return
      }
      const result = await pushRecordOperation(ownerOpenId, operation)
      ;({ applied, unchanged, conflicts })[result.status].push(result.value)
    }))
  }
  const syncReceipt = applied.some((item) => item.collection !== 'sync_state')
    ? await markSyncSignal(ownerOpenId, 'desktop', 'desktop.sync', sourceDeviceId)
    : null
  return { applied, unchanged, conflicts, syncReceipt }
}

async function syncHead(ownerOpenId, options = {}) {
  if (Number(options.protocol) === 2 && orderedSyncEnabled()) {
    const head = await readHead(db, ownerOpenId)
    return { ...head, protocol: 2, revision: `sequence-${head.sequence}`, quota: { functionCalls: 1, metadataReads: 1, businessReadQueries: 0, writes: 0 } }
  }
  const signalId = `sync_signal_${hash(ownerOpenId).slice(0, 32)}`
  const signal = await getDoc('sync_signals', signalId)
  return {
    revision: String(signal && signal.revision || 'initial'),
    changedAt: String(signal && signal.changedAt || ''),
    quota: { functionCalls: 1, metadataReads: 1, businessReadQueries: 0, writes: 0 }
  }
}

async function listWorkspaceTasks(ownerOpenId, limit = 500) {
  const documents = []
  const bounded = Math.max(1, Math.min(Number(limit || 500), 500))
  for (let offset = 0; offset < bounded; offset += 100) {
    const result = await db.collection('tasks').where({ ownerOpenId }).skip(offset).limit(Math.min(100, bounded - offset)).get()
    const page = result.data || []
    documents.push(...page)
    if (page.length < 100) break
  }
  return documents
}

async function replaceTaskBaseline(ownerOpenId, tasks = [], baselineId = '', sourceDeviceId = '') {
  if (!Array.isArray(tasks) || tasks.length > 500) {
    throw Object.assign(new Error('The initial task baseline can contain at most 500 tasks.'), { code: 'VALIDATION' })
  }
  const safeBaselineId = String(baselineId || '').trim().slice(0, 80)
  if (!safeBaselineId) throw Object.assign(new Error('The initial task baseline id is required.'), { code: 'VALIDATION' })
  // Older desktops still call this action. Preserve the reply shape, but
  // never infer deletion from absence in a possibly incomplete local list.
  const receiptId = `task_baseline_merge_v2_${hash(`${ownerOpenId}:${safeBaselineId}`).slice(0, 40)}`
  const receipt = await getDoc('sync_state', receiptId)
  if (receipt && receipt.result) return { ...receipt.result, reused: true }

  const currentTasks = await listWorkspaceTasks(ownerOpenId)
  const incomingById = new Map()
  for (const raw of tasks) {
    const id = String(raw && (raw.id || raw._id) || '').trim().slice(0, 120)
    if (!id) continue
    const data = sanitize(raw || {})
    delete data.cloudVersion
    incomingById.set(id, { ...data, id })
  }

  const changedAt = nowIso()
  let upserted = 0
  for (const [id, data] of incomingById) {
    const outcome = await pushRecordOperation(ownerOpenId, { collection: 'tasks', id, data })
    if (outcome.status === 'applied') upserted++
  }
  if (upserted) await markSyncSignal(ownerOpenId, 'desktop', 'desktop.task-baseline-merge', sourceDeviceId)
  const result = {
    baselineId: safeBaselineId,
    localCount: incomingById.size,
    cloudBefore: currentTasks.filter((task) => !task.deletedAt).length,
    upserted,
    removed: 0,
    removedIds: [],
    mergeOnly: true,
    changedAt,
    taskCursor: { at: '', offset: 0 }
  }
  await setDoc('sync_state', receiptId, {
    id: receiptId, ownerOpenId, workspaceId: ownerOpenId, baselineId: safeBaselineId, result,
    createdAt: changedAt, updatedAt: changedAt, version: 1,
    deletedAt: '', source: 'desktop', sourceIds: []
  })
  return result
}

async function importBatch(ownerOpenId, collection, documents, batchId, sourceDeviceId = '') {
  if (!COLLECTIONS.includes(collection)) throw Object.assign(new Error('不允许迁移该集合'), { code: 'VALIDATION' })
  if (!Array.isArray(documents) || documents.length > 100) throw Object.assign(new Error('迁移批次最多 100 条'), { code: 'VALIDATION' })
  const receiptId = `import_${hash(`${ownerOpenId}:${batchId}`).slice(0, 40)}`
  const receipt = await getDoc('sync_state', receiptId)
  if (receipt) return receipt.result
  const applied = []
  const conflicts = []
  const cleanedDocuments = documents.map((document) => {
    if (collection === 'captures' && !isUserAuthoredJournalDocument(document)) {
      throw Object.assign(new Error('只允许同步用户主动记录的灵光一现'), { code: 'VALIDATION' })
    }
    const id = String(document.id || document._id || '').replace(new RegExp(`^${hash(ownerOpenId).slice(0, 12)}_`), '').slice(0, 120)
    if (!id) throw Object.assign(new Error('迁移文档缺少 id'), { code: 'VALIDATION' })
    const data = collection === 'captures' ? sanitizeJournalDocument(document) : sanitize(document)
    return {
      id,
      data: {
        ...data,
        id,
        ownerOpenId,
        workspaceId: ownerOpenId,
        createdAt: data.createdAt || nowIso(),
        updatedAt: data.updatedAt || nowIso(),
        version: Number(data.version || 1),
        deletedAt: data.deletedAt || '',
        source: data.source || 'migration',
        sourceIds: data.sourceIds || []
      },
      baseVersion: document.baseVersion,
      contentHash: document.contentHash
    }
  })
  // Every imported document uses the same transactional merge as an ordinary
  // sync operation. Importing a stale backup must never replace a newer cloud
  // edit or resurrect a tombstone. The batch remains bounded so an interrupted
  // migration can be rerun with the same deterministic IDs and receive per-row
  // applied/unchanged/conflict results.
  for (let index = 0; index < cleanedDocuments.length; index += 10) {
    const group = cleanedDocuments.slice(index, index + 10)
    await Promise.all(group.map(async (document) => {
      const operation = {
        collection, id: document.id, data: document.data,
        ...(document.baseVersion !== undefined ? { baseVersion: document.baseVersion } : {}),
        ...(document.contentHash ? { contentHash: document.contentHash } : {}),
        ...(document.data.deletedAt ? { deletedAt: document.data.deletedAt } : {})
      }
      const outcome = collection === 'day_records'
        ? await pushDiaryOperation(ownerOpenId, operation)
        : await pushRecordOperation(ownerOpenId, operation)
      if (outcome.status === 'applied') applied.push(outcome.value)
      else if (outcome.status === 'conflicts') conflicts.push(outcome.value)
    }))
  }
  const result = { applied, conflicts }
  if (applied.length && collection !== 'sync_state') {
    await markSyncSignal(ownerOpenId, 'migration', 'desktop.import', sourceDeviceId)
  }
  await setDoc('sync_state', receiptId, {
    id: receiptId, ownerOpenId, batchId, result, createdAt: nowIso(), updatedAt: nowIso(),
    version: 1, deletedAt: '', source: 'migration', sourceIds: []
  })
  return result
}

async function status(ownerOpenId) {
  const counts = {}
  for (const collection of COLLECTIONS) {
    try {
      const result = await db.collection(collection).where(collection === 'captures' ? { ownerOpenId, entryKind: 'journal_entry' } : { ownerOpenId }).count()
      counts[collection] = result.total || 0
    } catch (error) { counts[collection] = -1 }
  }
  return { counts, checkedAt: nowIso() }
}

async function acknowledgeSync(ownerOpenId, device, payload = {}) {
  const signalId = `sync_signal_${hash(ownerOpenId).slice(0, 32)}`
  const receiptId = `desktop_receipt_${hash(ownerOpenId).slice(0, 32)}`
  const [signal, current] = await Promise.all([
    getDoc('sync_signals', signalId),
    getDoc('sync_state', receiptId)
  ])
  const appliedAt = nowIso()
  const receipt = {
    ...current,
    id: receiptId,
    kind: 'desktop_receipt',
    ownerOpenId,
    workspaceId: ownerOpenId,
    deviceId: device._id || device.id || '',
    appliedAt,
    revision: String(payload.revision || signal && signal.revision || ''),
    cloudChangedAt: String(payload.cloudChangedAt || signal && signal.changedAt || ''),
    createdAt: current && current.createdAt || appliedAt,
    updatedAt: appliedAt,
    version: Number(current && current.version || 0) + 1,
    deletedAt: '',
    source: 'desktop',
    sourceIds: []
  }
  await setDoc('sync_state', receiptId, receipt)
  return { appliedAt, revision: receipt.revision, cloudChangedAt: receipt.cloudChangedAt }
}

async function attachmentUploadInfo(ownerOpenId, payload) {
  const todoId = String(payload.todoId || '')
  const attachmentId = String(payload.attachmentId || '')
  const extension = String(payload.extension || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(todoId) || !/^[a-zA-Z0-9_-]{1,120}$/.test(attachmentId) || !['jpg', 'jpeg', 'png', 'webp'].includes(extension)) {
    throw Object.assign(new Error('附件上传参数无效'), { code: 'VALIDATION' })
  }
  const result = await db.collection('daily_tasks').doc(todoId).get()
  const todo = Array.isArray(result.data) ? result.data[0] : result.data
  if (!todo || todo.ownerOpenId !== ownerOpenId || todo.deletedAt || todo.trashedAt || todo.permanentlyPurgedAt) {
    throw Object.assign(new Error('附件所属待办不存在或不属于当前空间'), { code: 'FORBIDDEN' })
  }
  const cloudPath = `${attachmentPrefix(ownerOpenId)}/${todoId}/${attachmentId}.${extension === 'jpeg' ? 'jpg' : extension}`
  const metadata = await app.getUploadMetadata({ cloudPath })
  const data = metadata && metadata.data || metadata || {}
  return {
    cloudPath,
    fileID: data.fileId || data.fileID || '',
    uploadUrl: data.url || '',
    headers: {
      Signature: data.authorization || '',
      authorization: data.authorization || '',
      'x-cos-security-token': data.token || '',
      'x-cos-meta-fileid': data.cosFileId || '',
      key: encodeURIComponent(cloudPath)
    }
  }
}

async function attachmentTempUrls(ownerOpenId, payload) {
  return Array.isArray(payload.references)
    ? attachmentAccess.byReferences(ownerOpenId, payload.references)
    : attachmentAccess.legacyByFileIDs(ownerOpenId, payload.fileIDs || [])
}

async function handleRequest(rawEvent = {}) {
  try {
    const event = normalizeEvent(rawEvent)
    const action = String(event.action || '')
    const payload = event.payload || event
    const query = event.queryStringParameters || event.query || {}
    if (!action && query.code && query.state) {
      await completeQrCallback(query.code, query.state)
      return ok({ message: '微信登录成功，请返回主线笔记窗口。' })
    }
    if (action === 'login.qr.create') return ok(await createQrLogin(payload.deviceName))
    if (action === 'login.qr.callback') return ok(await completeQrCallback(payload.code, payload.state))
    if (action === 'login.qr.poll') return ok(await pollQrLogin(payload.sessionId, payload.pollToken))
    if (action === 'login.qr.cancel') return ok(await cancelQrLogin(payload.sessionId, payload.pollToken))
    const device = await authorize(tokenFrom(event))
    const workspaceId = deviceWorkspaceId(device)
    if (!workspaceId) throw Object.assign(new Error('The paired device has no workspace.'), { code: 'UNAUTHENTICATED' })
    if (action === 'sync.head') return ok(await syncHead(workspaceId, payload))
    if (action === 'sync.historyPage' || action === 'sync.changes') {
      requireOrderedSync()
      return ok(await (action === 'sync.historyPage' ? historyPage : changePage)(workspaceId, payload))
    }
    if (action === 'sync.backfillOrdered') {
      await requireDeviceRole(device, ['owner', 'admin'])
      return ok(await db.backfillOrdered(workspaceId, payload))
    }
    if (action === 'sync.pull') return ok(await pull(workspaceId, payload.cursor || '', payload.limit))
    if (action === 'sync.push') return ok(await push(workspaceId, payload.operations || [], device._id || device.id || ''))
    if (action === 'sync.replaceTasks') return ok(await replaceTaskBaseline(workspaceId, payload.tasks || [], payload.baselineId, device._id || device.id || ''))
    if (action === 'sync.ack') return ok(await acknowledgeSync(workspaceId, device, payload))
    if (action === 'sync.importBatch') return ok(await importBatch(workspaceId, payload.collection, payload.documents, payload.batchId, device._id || device.id || ''))
    if (action === 'sync.status') return ok(await status(workspaceId))
    if (action === 'attachment.uploadInfo') return ok(await attachmentUploadInfo(workspaceId, payload))
    if (action === 'attachment.tempUrls') return ok(await attachmentTempUrls(workspaceId, payload))
    if (action === 'realtime.ticket') return ok(await realtimeTicket(device, payload))
    if (action === 'realtime.bind') return ok(await bindRealtimeUid(device, payload.uid))
    if (action === 'sync.signal') {
      await markSyncSignal(workspaceId, 'desktop', 'desktop.signal', device._id || device.id || '')
      return ok({ signaledAt: nowIso() })
    }
    return fail('VALIDATION', `未知操作：${action}`)
  } catch (error) {
    console.error(error)
    return fail(error.code || 'SERVER_ERROR', safeMessage(error))
  }
}

exports.main = handleRequest
exports.__test = {
  attachmentTempUrls,
  push, pushRecordOperation,
  pushDiaryOperation, mergeDiaryOriginals, diaryInputsRevision,
  importBatch,
  backfillOrdered: db.backfillOrdered,
  attachmentUploadInfo,
  deviceWorkspaceId,
  cloudDocumentId,
  sanitize,
  isUserAuthoredJournalDocument,
  sanitizeJournalDocument,
  sanitizeDayRecordDocument,
  normalizePullCursor,
  normalizePullPosition,
  pullDocumentToken,
  selectPullDocuments,
  nextPullPosition,
  qrLoginConfigured,
  createQrLogin,
  pollQrLogin,
  collectionPullScope,
  realtimeCustomUserId,
  syncHead,
  AUTH_CACHE_TTL_MS,
  DEVICE_HEARTBEAT_WRITE_INTERVAL_MS
}

if (require.main === module) {
  const http = require('node:http')
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')
    if (request.method === 'GET' && request.url.split('?')[0] === '/events') {
      response.statusCode = 410
      response.end(JSON.stringify(fail('REALTIME_MOVED', 'Use native CloudBase database watch.')))
      return
    }
    if (request.method === 'GET' && request.url.split('?')[0] === '/health') {
      response.statusCode = 200
      response.end(JSON.stringify({ ok: true, service: 'desktopSync', version: releaseIdentity.backend.desktopSync,
        releaseSet: releaseIdentity.releaseSet, desktopVersion: releaseIdentity.desktopVersion,
        miniVersion: releaseIdentity.miniVersion }))
      return
    }
    if (request.method !== 'POST') {
      response.statusCode = 405
      response.end(JSON.stringify(fail('METHOD_NOT_ALLOWED', '仅支持 POST 请求')))
      return
    }
    try {
      let body = ''
      for await (const chunk of request) {
        body += chunk
        if (body.length > 2 * 1024 * 1024) throw Object.assign(new Error('请求体过大'), { code: 'PAYLOAD_TOO_LARGE' })
      }
      const event = body ? JSON.parse(body) : {}
      event.headers = request.headers
      const result = await handleRequest(event)
      response.statusCode = result.ok ? 200 : result.error && result.error.code === 'UNAUTHENTICATED' ? 401 : 400
      response.end(JSON.stringify(result))
    } catch (error) {
      response.statusCode = error && error.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400
      response.end(JSON.stringify(fail(error.code || 'BAD_REQUEST', safeMessage(error))))
    }
  })
  server.listen(9000, '0.0.0.0', () => console.log('desktopSync listening on 9000'))
}

