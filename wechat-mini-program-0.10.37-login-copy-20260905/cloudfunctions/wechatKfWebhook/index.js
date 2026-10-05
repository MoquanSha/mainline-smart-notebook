'use strict'

const crypto = require('crypto')
const tcb = require('@cloudbase/node-sdk')

const ENV_ID = process.env.CLOUDBASE_ENV_ID || process.env.TCB_ENV || process.env.SCF_NAMESPACE || 'YOUR_CLOUDBASE_ENV_ID'
const TOKEN = process.env.WECHAT_KF_TOKEN || ''
const AES_KEY = process.env.WECHAT_KF_AES_KEY || ''
const CORP_ID = process.env.WECHAT_KF_CORP_ID || ''
const KF_SECRET = process.env.WECHAT_KF_SECRET || ''
const BRIDGE_SECRET = process.env.WECHAT_BRIDGE_SECRET || ''
const ORGANIZER_URL = process.env.WECHAT_ORGANIZER_URL || 'https://YOUR_CLOUDBASE_DOMAIN/wechat-webhook'

const app = tcb.init({ env: ENV_ID, timeout: 25000 })
const { withSyncSequence } = require('./sync-database')
const db = withSyncSequence(app.database())
let accessTokenCache = { value: '', expiresAt: 0 }

function nowIso() { return new Date().toISOString() }
function hash(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex') }
function uid(prefix) { return `${prefix}_${Date.now()}_${crypto.randomBytes(5).toString('hex')}` }
function decodeXml(value) {
  return String(value || '').replace(/^<!\[CDATA\[|\]\]>$/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}
function xmlField(xml, name) {
  const match = String(xml || '').match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'i'))
  return match ? decodeXml(match[1]) : ''
}
function queryOf(event) { return event.queryStringParameters || event.query || {} }
function methodOf(event) { return String(event.httpMethod || event.requestContext && event.requestContext.httpMethod || 'POST').toUpperCase() }
function bodyOf(event) {
  const body = event.body || event.rawBody || ''
  return event.isBase64Encoded ? Buffer.from(body, 'base64').toString('utf8') : String(body)
}
function response(statusCode, body, contentType = 'text/plain; charset=utf-8') {
  return { statusCode, headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store' }, body }
}
function messageSignature(token, timestamp, nonce, encrypted) {
  return crypto.createHash('sha1').update([token, timestamp, nonce, encrypted].sort().join('')).digest('hex')
}
function validMessageSignature(token, timestamp, nonce, encrypted, signature) {
  if (!token || !timestamp || !nonce || !encrypted || !signature) return false
  const expected = messageSignature(token, timestamp, nonce, encrypted)
  return expected.length === String(signature).length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)))
}
function aesKeyBuffer(aesKey = AES_KEY) {
  const normalized = String(aesKey || '').trim().replace(/=+$/, '')
  if (!/^[A-Za-z0-9+/]{43}$/.test(normalized)) throw new Error('invalid WeCom EncodingAESKey')
  const key = Buffer.from(`${normalized}=`, 'base64')
  if (key.length !== 32) throw new Error('invalid WeCom AES key length')
  return key
}
function pkcs7Unpad(buffer) {
  if (!buffer.length) throw new Error('empty encrypted message')
  const padLength = buffer[buffer.length - 1]
  if (padLength < 1 || padLength > 32 || padLength > buffer.length) throw new Error('invalid PKCS#7 padding')
  return buffer.subarray(0, buffer.length - padLength)
}
function pkcs7Pad(buffer) {
  const remainder = buffer.length % 32
  const padLength = remainder ? 32 - remainder : 32
  return Buffer.concat([buffer, Buffer.alloc(padLength, padLength)])
}
function decryptWechatMessage(encrypted, corpId = CORP_ID, aesKey = AES_KEY) {
  const key = aesKeyBuffer(aesKey)
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
  decipher.setAutoPadding(false)
  const plain = pkcs7Unpad(Buffer.concat([decipher.update(Buffer.from(String(encrypted || ''), 'base64')), decipher.final()]))
  if (plain.length < 20) throw new Error('invalid WeCom encrypted payload')
  const messageLength = plain.readUInt32BE(16)
  const messageEnd = 20 + messageLength
  if (messageEnd > plain.length) throw new Error('invalid WeCom message length')
  const message = plain.subarray(20, messageEnd).toString('utf8')
  const receiveId = plain.subarray(messageEnd).toString('utf8')
  if (corpId && receiveId !== corpId) throw new Error('WeCom CorpID mismatch')
  return { message, receiveId }
}
function encryptWechatMessage(message, corpId = CORP_ID, aesKey = AES_KEY, randomBytes = crypto.randomBytes(16)) {
  const key = aesKeyBuffer(aesKey)
  const messageBuffer = Buffer.from(String(message || ''), 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(messageBuffer.length, 0)
  const plain = pkcs7Pad(Buffer.concat([Buffer.from(randomBytes).subarray(0, 16), length, messageBuffer, Buffer.from(corpId, 'utf8')]))
  const cipher = crypto.createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64')
}
function bridgeSignature(secret, timestamp, body) {
  return crypto.createHmac('sha256', String(secret || '')).update(`${timestamp}.${body}`).digest('hex')
}
function parseSceneToken(sceneParam) {
  const match = String(sceneParam || '').match(/^mln_([a-f0-9]{36})$/i)
  return match ? match[1].toLowerCase() : ''
}
function normalizeKfMessage(message = {}) {
  const msgType = String(message.msgtype || '')
  return {
    messageId: String(message.msgid || ''),
    openKfId: String(message.open_kfid || ''),
    externalUserId: String(message.external_userid || ''),
    sendTime: String(message.send_time || ''),
    origin: Number(message.origin || 0),
    type: msgType,
    content: msgType === 'text' ? String(message.text && message.text.content || '').trim() : '',
    eventType: msgType === 'event' ? String(message.event && message.event.event_type || '') : '',
    sceneParam: msgType === 'event' ? String(message.event && message.event.scene_param || '') : '',
    welcomeCode: msgType === 'event' ? String(message.event && message.event.welcome_code || '') : ''
  }
}
async function getDoc(collection, id) {
  try {
    const result = await db.collection(collection).doc(id).get()
    return result && result.data && (Array.isArray(result.data) ? result.data[0] : result.data) || null
  } catch (_) { return null }
}
async function setDoc(collection, id, value) {
  const { _id, ...payload } = value
  return db.collection(collection).doc(id).set(payload)
}
async function wecomJson(url, options = {}) {
  const result = await fetch(url, options)
  const json = await result.json()
  if (!result.ok || Number(json.errcode || 0) !== 0) throw new Error(`WeCom API ${json.errcode || result.status}: ${json.errmsg || 'request failed'}`)
  return json
}
async function getAccessToken() {
  if (accessTokenCache.value && accessTokenCache.expiresAt > Date.now() + 120000) return accessTokenCache.value
  if (!CORP_ID || !KF_SECRET) throw new Error('WeChat Customer Service credentials are not configured')
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(CORP_ID)}&corpsecret=${encodeURIComponent(KF_SECRET)}`
  const result = await wecomJson(url)
  accessTokenCache = { value: result.access_token, expiresAt: Date.now() + Number(result.expires_in || 7200) * 1000 }
  return accessTokenCache.value
}
async function postKf(path, payload) {
  const accessToken = await getAccessToken()
  return wecomJson(`https://qyapi.weixin.qq.com/cgi-bin/kf/${path}?access_token=${encodeURIComponent(accessToken)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  })
}
async function bindCustomer(externalUserId, sceneParam) {
  const token = parseSceneToken(sceneParam)
  if (!externalUserId || !token) return null
  const result = await db.collection('identity_bind_codes').where({
    codeHash: hash(token), provider: 'wechat_kf', status: 'active', deletedAt: ''
  }).limit(1).get()
  const bind = result.data && result.data[0]
  if (!bind || new Date(bind.expiresAt).getTime() <= Date.now()) return null
  const at = nowIso()
  const identityId = `identity_wechat_kf_${hash(externalUserId).slice(0, 32)}`
  await setDoc('identities', identityId, {
    id: identityId, provider: 'wechat_kf', providerUserId: externalUserId,
    providerUserHash: hash(externalUserId).slice(0, 48), userId: bind.userId,
    activeWorkspaceId: bind.workspaceId, createdAt: at, updatedAt: at,
    version: 1, deletedAt: '', source: 'wechat_kf', sourceIds: [bind._id || bind.id]
  })
  await db.collection('identity_bind_codes').doc(bind._id).update({
    status: 'consumed', consumedAt: at, updatedAt: at, version: Number(bind.version || 1) + 1
  })
  return { userId: bind.userId, workspaceId: bind.workspaceId }
}
async function callOrganizer(message) {
  const body = JSON.stringify({
    kind: 'internal.journal_ingest', provider: 'wechat_kf',
    providerUserId: message.externalUserId, messageId: message.messageId,
    createdAt: message.sendTime, content: message.content
  })
  const timestamp = String(Date.now())
  const result = await fetch(ORGANIZER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Mainline-Timestamp': timestamp,
      'X-Mainline-Signature': bridgeSignature(BRIDGE_SECRET, timestamp, body)
    },
    body
  })
  const json = await result.json()
  if (!result.ok || !json.ok) {
    if (json.retryable === false) return { ok: true, rejected: true, reply: String(json.error || '这条消息内容过长，请拆分后重试。') }
    throw new Error(json.error || `organizer returned ${result.status}`)
  }
  return json
}
async function sendText(openKfId, externalUserId, content) {
  if (!openKfId || !externalUserId || !content) return
  return postKf('send_msg', {
    touser: externalUserId, open_kfid: openKfId, msgid: uid('reply'),
    msgtype: 'text', text: { content: String(content).slice(0, 1800) }
  })
}
async function sendWelcome(welcomeCode, content) {
  if (!welcomeCode || !content) return
  return postKf('send_msg_on_event', { code: welcomeCode, msgtype: 'text', text: { content: String(content).slice(0, 1800) } })
}
async function processKfMessage(rawMessage) {
  const message = normalizeKfMessage(rawMessage)
  if (message.type === 'event' && message.eventType === 'enter_session') {
    const bound = await bindCustomer(message.externalUserId, message.sceneParam)
    if (message.welcomeCode) {
      await sendWelcome(message.welcomeCode, bound
        ? '已经连接到你的主线笔记。直接发计划、清单或进展，我会保留原话并整理到小程序；不确定时才进入“待确认”。'
        : '请从“主线随行笔记”小程序首页点击“和主线助手聊聊”，这样我才能连接到你的工作区。')
    }
    return
  }
  if (message.origin !== 3 || !message.externalUserId) return
  if (message.type !== 'text') {
    await sendText(message.openKfId, message.externalUserId, '这条图片或语音我已经收到。当前内测先补一句文字说明，我就能准确整理进灵光一现。')
    return
  }
  const organized = await callOrganizer(message)
  await sendText(message.openKfId, message.externalUserId, organized.reply || '已经记下。')
}
async function syncMessages(openKfId, callbackToken) {
  const stateId = `wechat_kf_cursor_${hash(openKfId).slice(0, 32)}`
  const state = await getDoc('sync_state', stateId)
  let cursor = String(state && state.cursor || '')
  let token = String(callbackToken || '')
  let page = 0
  do {
    const result = await postKf('sync_msg', { cursor, token, limit: 100, voice_format: 0, open_kfid: openKfId })
    for (const message of result.msg_list || []) await processKfMessage(message)
    cursor = String(result.next_cursor || cursor)
    token = ''
    page += 1
    if (!result.has_more || page >= 5) break
  } while (true)
  const at = nowIso()
  await setDoc('sync_state', stateId, {
    ...state, id: stateId, cursor, openKfId, createdAt: state && state.createdAt || at,
    updatedAt: at, version: Number(state && state.version || 0) + 1,
    deletedAt: '', source: 'wechat_kf', sourceIds: []
  })
}

exports.main = async (event = {}) => {
  try {
    const query = queryOf(event)
    const body = bodyOf(event)
    const encrypted = xmlField(body, 'Encrypt') || query.echostr || ''
    const signature = query.msg_signature || query.signature || ''
    if (!validMessageSignature(TOKEN, query.timestamp, query.nonce, encrypted, signature)) return response(403, 'invalid message signature')
    const decrypted = decryptWechatMessage(encrypted).message
    if (methodOf(event) === 'GET') return response(200, decrypted)
    const eventType = xmlField(decrypted, 'Event')
    if (eventType === 'kf_msg_or_event') {
      await syncMessages(xmlField(decrypted, 'OpenKfId'), xmlField(decrypted, 'Token'))
    }
    return response(200, 'success')
  } catch (error) {
    console.error(error)
    const statusCode = Number(error && error.statusCode) || (methodOf(event) === 'GET' ? 200 : 500)
    return response(statusCode, methodOf(event) === 'GET' ? queryOf(event).echostr || '' : 'temporary failure')
  }
}

exports.__test = {
  messageSignature, validMessageSignature, encryptWechatMessage, decryptWechatMessage,
  xmlField, bridgeSignature, parseSceneToken, normalizeKfMessage
}

if (require.main === module) {
  const http = require('node:http')
  const server = http.createServer(async (request, responseStream) => {
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1')
      let body = ''
      for await (const chunk of request) {
        body += chunk
        if (body.length > 1024 * 1024) throw Object.assign(new Error('payload too large'), { statusCode: 413 })
      }
      const result = await exports.main({
        httpMethod: request.method,
        path: url.pathname,
        queryStringParameters: Object.fromEntries(url.searchParams.entries()),
        headers: request.headers,
        body
      })
      responseStream.writeHead(result.statusCode || 200, result.headers || {})
      responseStream.end(result.body || '')
    } catch (error) {
      responseStream.writeHead(error.statusCode || 500, { 'Content-Type': 'text/plain; charset=utf-8' })
      responseStream.end(error.message || 'internal error')
    }
  })
  server.listen(Number(process.env.PORT || 9000), '0.0.0.0')
}

