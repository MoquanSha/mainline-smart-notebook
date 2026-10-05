'use strict'

const crypto = require('crypto')
const tcb = require('@cloudbase/node-sdk')

const ENV_ID = process.env.CLOUDBASE_ENV_ID || process.env.TCB_ENV || process.env.SCF_NAMESPACE || 'YOUR_CLOUDBASE_ENV_ID'
const TOKEN = process.env.WECHAT_MP_TOKEN || ''
const AES_KEY = process.env.WECHAT_MP_AES_KEY || ''
const APP_ID = process.env.WECHAT_MP_APPID || ''
const BRIDGE_SECRET = process.env.WECHAT_BRIDGE_SECRET || ''
const app = tcb.init({ env: ENV_ID, timeout: 25000 })
const { withSyncSequence } = require('./sync-database')
const db = withSyncSequence(app.database())
const WEBHOOK_EVENT_LEASE_MS = 2 * 60 * 1000
const MAX_RECORD_BYTES = 800000

function nowIso() { return new Date().toISOString() }
function hash(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex') }
function uid(prefix) { return `${prefix}_${Date.now()}_${crypto.randomBytes(5).toString('hex')}` }
function escapeXml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}
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
function headerOf(event, name) {
  const headers = event.headers || {}
  const expected = String(name || '').toLowerCase()
  const key = Object.keys(headers).find((item) => String(item).toLowerCase() === expected)
  return key ? String(headers[key] || '') : ''
}
function bridgeSignature(secret, timestamp, body) {
  return crypto.createHmac('sha256', String(secret || '')).update(`${timestamp}.${body}`).digest('hex')
}
function validBridgeSignature(secret, timestamp, body, signature, now = Date.now()) {
  if (!secret || !timestamp || !signature) return false
  const sentAt = Number(timestamp)
  if (!Number.isFinite(sentAt) || Math.abs(now - sentAt) > 5 * 60 * 1000) return false
  const expected = bridgeSignature(secret, timestamp, body)
  if (expected.length !== String(signature).length) return false
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)))
}
function validSignature(token, timestamp, nonce, signature) {
  if (!token || !timestamp || !nonce || !signature) return false
  return crypto.createHash('sha1').update([token, timestamp, nonce].sort().join('')).digest('hex') === signature
}
function messageSignature(token, timestamp, nonce, encrypted) {
  return crypto.createHash('sha1').update([token, timestamp, nonce, encrypted].sort().join('')).digest('hex')
}
function validMessageSignature(token, timestamp, nonce, encrypted, signature) {
  if (!token || !timestamp || !nonce || !encrypted || !signature) return false
  const expected = messageSignature(token, timestamp, nonce, encrypted)
  if (expected.length !== String(signature).length) return false
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)))
}
function aesKeyBuffer(aesKey = AES_KEY) {
  const normalized = String(aesKey || '').trim().replace(/=+$/, '')
  if (!/^[A-Za-z0-9+/]{43}$/.test(normalized)) throw new Error('invalid WeChat EncodingAESKey')
  const key = Buffer.from(`${normalized}=`, 'base64')
  if (key.length !== 32) throw new Error('invalid WeChat AES key length')
  return key
}
function pkcs7Pad(buffer) {
  const amount = 32 - (buffer.length % 32 || 32)
  const padLength = amount === 0 ? 32 : amount
  return Buffer.concat([buffer, Buffer.alloc(padLength, padLength)])
}
function pkcs7Unpad(buffer) {
  if (!buffer.length) throw new Error('empty encrypted message')
  const padLength = buffer[buffer.length - 1]
  if (padLength < 1 || padLength > 32 || padLength > buffer.length) throw new Error('invalid PKCS#7 padding')
  return buffer.subarray(0, buffer.length - padLength)
}
function encryptWechatMessage(message, appId = APP_ID, aesKey = AES_KEY, randomBytes = crypto.randomBytes(16)) {
  if (!appId) throw new Error('WECHAT_MP_APPID is required for encrypted callbacks')
  const key = aesKeyBuffer(aesKey)
  const messageBuffer = Buffer.from(String(message || ''), 'utf8')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(messageBuffer.length, 0)
  const plain = pkcs7Pad(Buffer.concat([Buffer.from(randomBytes).subarray(0, 16), length, messageBuffer, Buffer.from(appId, 'utf8')]))
  const cipher = crypto.createCipheriv('aes-256-cbc', key, key.subarray(0, 16))
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64')
}
function decryptWechatMessage(encrypted, appId = APP_ID, aesKey = AES_KEY) {
  const key = aesKeyBuffer(aesKey)
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, key.subarray(0, 16))
  decipher.setAutoPadding(false)
  const plain = pkcs7Unpad(Buffer.concat([decipher.update(Buffer.from(String(encrypted || ''), 'base64')), decipher.final()]))
  if (plain.length < 20) throw new Error('invalid WeChat encrypted payload')
  const messageLength = plain.readUInt32BE(16)
  const messageEnd = 20 + messageLength
  if (messageEnd > plain.length) throw new Error('invalid WeChat message length')
  const message = plain.subarray(20, messageEnd).toString('utf8')
  const payloadAppId = plain.subarray(messageEnd).toString('utf8')
  if (appId && payloadAppId !== appId) throw new Error('WeChat AppID mismatch')
  return { message, appId: payloadAppId }
}
function response(statusCode, body, contentType = 'text/plain; charset=utf-8') {
  return { statusCode, headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store' }, body }
}
function textReply(toUser, fromUser, content) {
  return `<xml><ToUserName><![CDATA[${toUser}]]></ToUserName><FromUserName><![CDATA[${fromUser}]]></FromUserName><CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${String(content || '').replace(/\]\]>/g, ']] >')}]]></Content></xml>`
}
function encryptedReply(plainXml, timestamp = String(Math.floor(Date.now() / 1000)), nonce = crypto.randomBytes(8).toString('hex')) {
  const encrypted = encryptWechatMessage(plainXml)
  const signature = messageSignature(TOKEN, timestamp, nonce, encrypted)
  return `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt><MsgSignature><![CDATA[${signature}]]></MsgSignature><TimeStamp>${timestamp}</TimeStamp><Nonce><![CDATA[${nonce}]]></Nonce></xml>`
}
async function getDoc(collection, id) {
  try {
    const result = await db.collection(collection).doc(id).get()
    return result && result.data && (Array.isArray(result.data) ? result.data[0] : result.data) || null
  } catch (error) { return null }
}
function dataOf(result) {
  return Array.isArray(result && result.data) ? result.data[0] : result && result.data
}
async function setDoc(collection, id, value) {
  const { _id, ...payload } = value
  if (['captures', 'proposals'].includes(collection)) assertRecordCapacity(payload)
  return db.collection(collection).doc(id).set(payload)
}
function webhookEventIsActive(event, now = Date.now()) {
  if (!event || event.status !== 'processing') return false
  const claimedAt = Date.parse(String(event.claimedAt || ''))
  return Number.isFinite(claimedAt) && now - claimedAt >= 0 && now - claimedAt < WEBHOOK_EVENT_LEASE_MS
}
async function reserveWebhookEvent(eventId, metadata) {
  return db.runTransaction(async (tx) => {
    const ref = tx.collection('webhook_events').doc(eventId)
    const current = dataOf(await ref.get()) || null
    if (current && (current.status === 'done' || current.status === 'awaiting_retry' || webhookEventIsActive(current))) {
      return { duplicate: true, event: current }
    }
    const at = nowIso()
    const next = {
      ...(current || {}), ...metadata, id: eventId, status: 'processing', claimedAt: at,
      createdAt: current && current.createdAt || at, updatedAt: at,
      version: Number(current && current.version || 0) + 1, deletedAt: '',
      source: metadata.provider || 'wechat_webhook', sourceIds: current && current.sourceIds || []
    }
    await ref.set(next)
    return { duplicate: false, reserved: true, reclaimed: Boolean(current && current.status === 'processing'), event: next }
  })
}
function captureFitsCapacity(capture) {
  return Buffer.byteLength(JSON.stringify(capture), 'utf8') <= MAX_RECORD_BYTES
}
function assertRecordCapacity(value) {
  if (!captureFitsCapacity(value)) throw Object.assign(new Error('记录超过 CloudBase 单条容量，原文未截断，请拆分后重试'), { code: 'RECORD_TOO_LARGE', retryable: false })
}
async function markSyncSignal(workspaceId, action) {
  const id = `sync_signal_${hash(workspaceId).slice(0, 32)}`
  const current = await getDoc('sync_signals', id)
  const workspace = await getDoc('workspaces', workspaceId)
  const at = nowIso()
  await setDoc('sync_signals', id, {
    ...current, id, kind: 'sync_signal', action, ownerOpenId: workspaceId, workspaceId,
    accessOpenIds: workspace && workspace.accessOpenIds || [], changedAt: at,
    revision: uid('revision'), createdAt: current && current.createdAt || at,
    updatedAt: at, version: Number(current && current.version || 0) + 1,
    deletedAt: '', source: String(action || '').split('.')[0] || 'wechat', sourceIds: []
  })
}
async function bindIdentity(fromOpenId, code) {
  const result = await db.collection('identity_bind_codes').where({
    codeHash: hash(String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '')),
    provider: 'wechat_mp', status: 'active', deletedAt: ''
  }).limit(1).get()
  const bind = result.data && result.data[0]
  if (!bind || new Date(bind.expiresAt).getTime() <= Date.now()) return null
  const at = nowIso()
  const identityId = `identity_wechat_mp_${hash(fromOpenId).slice(0, 32)}`
  await setDoc('identities', identityId, {
    id: identityId, provider: 'wechat_mp', providerUserId: fromOpenId,
    providerUserHash: hash(fromOpenId).slice(0, 48), userId: bind.userId,
    activeWorkspaceId: bind.workspaceId, createdAt: at, updatedAt: at,
    version: 1, deletedAt: '', source: 'wechat_mp', sourceIds: [bind._id || bind.id]
  })
  await db.collection('identity_bind_codes').doc(bind._id).update({ status: 'consumed', consumedAt: at, updatedAt: at, version: Number(bind.version || 1) + 1 })
  return { userId: bind.userId, workspaceId: bind.workspaceId }
}

function shanghaiDayKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date)
}

function parseJson(text) {
  const source = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const first = source.indexOf('{')
  const last = source.lastIndexOf('}')
  if (first < 0 || last <= first) throw new Error('model did not return JSON')
  return JSON.parse(source.slice(first, last + 1))
}

function cleanTitle(value) {
  return String(value || '').replace(/^[\s#>*\-\d.、）)]+/, '')
    .replace(/^(今天|今日|现在)?\s*(我)?\s*(想|要|需要|打算|计划|准备|记一下|记录一下)\s*/i, '')
    .replace(/[：:，,。！!；;]+$/, '').trim().slice(0, 48)
}

function titleFromContent(value, listSignal = false) {
  let title = cleanTitle(String(value || '').replace(/\s+/g, ' ').trim().split(/[\n。！？；;]/)[0])
  title = title
    .replace(/^(?:你|我)?(?:把|将|给我|帮我|觉得|希望|要求|需要)\s*/i, '')
    .replace(/^(?:这个|这里|然后|此外|而且|其实|就是|如果|那么)+\s*/i, '')
    .trim()
  if (!title) return listSignal ? '待办清单' : '未命名笔记'
  return title.length > 22 ? `${title.slice(0, 22)}…` : title
}

function normalizedText(value) {
  return String(value || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function splitItems(value) {
  const text = String(value || '').trim().slice(0, 8000)
  const explicit = text.replace(/\r\n?/g, '\n').split(/\n+/)
    .filter((line) => /^\s*(?:[-*•]|\d+[.、）)]|[□☐])\s*/.test(line))
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.、）)]|[□☐])\s*/, '').trim()).filter(Boolean)
  if (explicit.length >= 2) return [...new Set(explicit)].slice(0, 30)
  const segments = text.split(/[，,、；;\n]+/).map((item) => item.trim()).filter(Boolean)
  if (segments.length < 2) return []
  return [...new Set(segments.slice(1).flatMap((item) => item.split(/(?:以及|还有|和|跟)/))
    .map((item) => item.replace(/^(?:再|另外|还)?(?:需要|要|想|准备|打算)?(?:买|带|准备|采购|记录)\s*/, '').replace(/[。！!]+$/, '').trim())
    .filter((item) => item && item.length <= 80))].slice(0, 30)
}

function markdownOf(title, summary, items = []) {
  const heading = `## ${title || '今日记录'}`
  return items.length ? `${heading}\n\n${items.map((item) => `- [${item.done ? 'x' : ' '}] ${item.text}`).join('\n')}` : `${heading}\n\n${summary || ''}`.trim()
}

function findChecklistTarget(entries, text) {
  const source = String(text || '').replace(/\s+/g, '')
  for (const entry of entries || []) {
    for (const item of entry.checklistItems || []) {
      const itemText = String(item.text || '').replace(/\s+/g, '')
      if (itemText && (source.includes(itemText) || itemText.includes(source))) return { entry, item }
    }
  }
  return null
}

function ruleJournalAction(content, recentEntries = []) {
  // Keep the complete input for rule classification. The capture is written
  // before organization, so a bounded display summary must never become a
  // silently truncated source for the journal entry.
  const raw = String(content || '').trim()
  const completed = /(?:买好|买了|完成|搞定|做完|勾选|打勾)/.test(raw) && !/(?:没|未|取消)/.test(raw)
  const reopened = /(?:还没|未完成|取消勾选|取消完成|没买)/.test(raw)
  const target = (completed || reopened) ? findChecklistTarget(recentEntries, raw) : null
  if (target) return { operation: completed ? 'check' : 'uncheck', targetEntryId: target.entry.id, targetItemId: target.item.id, targetItemText: target.item.text, title: target.entry.journalTitle, type: 'checklist', items: [], summary: '', needsConfirmation: false, organizedBy: 'rules' }

  const latestChecklist = (recentEntries || []).find((entry) => (entry.checklistItems || []).length)
  if (/^(?:再加|另外|还要|补充|加上|再)/.test(raw) && latestChecklist) {
    let items = splitItems(`补充，${raw.replace(/^(?:再加|另外|还要|补充|加上|再)\s*/, '')}`)
    if (!items.length) items = [raw.replace(/^(?:再加|另外|还要|补充|加上|再)\s*/, '').trim()].filter(Boolean)
    return { operation: 'append', targetEntryId: latestChecklist.id, title: latestChecklist.journalTitle, type: 'checklist', items, summary: '', needsConfirmation: false, organizedBy: 'rules' }
  }

  const grocery = /(买菜|采购|购物|要买|购买清单)/.test(raw)
  const listSignal = grocery || /(清单|待办|材料|行李)/.test(raw) || /(?:^|\n)\s*(?:[-*•]|\d+[.、）)]|[□☐])\s*/m.test(raw)
  const items = listSignal ? splitItems(raw) : []
  const title = grocery ? '买菜清单' : titleFromContent(raw, listSignal)
  return {
    operation: 'create', targetEntryId: '', targetItemId: '', targetItemText: '',
    title,
    type: items.length ? 'checklist' : /(计划|准备|安排)/.test(raw) ? 'plan' : 'note',
    items, summary: items.length ? `共 ${items.length} 项，可以在小程序逐项勾选。` : raw.replace(/\s+/g, ' ').slice(0, 500),
    needsConfirmation: false, organizedBy: 'rules'
  }
}

function normalizeAgentAction(value, rawContent, recentEntries = []) {
  const fallback = ruleJournalAction(rawContent, recentEntries)
  const operations = ['create', 'append', 'check', 'uncheck']
  const operation = operations.includes(value && value.operation) ? value.operation : fallback.operation
  const validEntryIds = new Set((recentEntries || []).map((entry) => entry.id))
  const targetEntryId = validEntryIds.has(String(value && value.targetEntryId || '')) ? String(value.targetEntryId) : fallback.targetEntryId
  const targetEntry = (recentEntries || []).find((entry) => entry.id === targetEntryId)
  const items = Array.isArray(value && value.items) ? value.items.slice(0, 30).map((item) => String(typeof item === 'string' ? item : item && item.text || '').trim().slice(0, 120)).filter(Boolean) : fallback.items
  const targetText = String(value && value.targetItemText || fallback.targetItemText || '').trim()
  const targetItem = targetEntry && (targetEntry.checklistItems || []).find((item) => item.id === value.targetItemId || (targetText && (String(item.text).includes(targetText) || targetText.includes(String(item.text)))))
  if (['append', 'check', 'uncheck'].includes(operation) && !targetEntry) return fallback
  if (['check', 'uncheck'].includes(operation) && !targetItem) return fallback
  const candidateTitle = /^(随手记|今日记录|今日笔记|笔记|记录)$/i.test(cleanTitle(value && value.title))
    ? fallback.title
    : cleanTitle(value && value.title) || targetEntry && targetEntry.journalTitle || fallback.title
  const candidateSummary = String(value && value.summary || fallback.summary).trim().slice(0, 500)
  return {
    operation, targetEntryId, targetItemId: targetItem && targetItem.id || '', targetItemText: targetItem && targetItem.text || targetText,
    title: candidateTitle,
    type: ['checklist', 'plan', 'note'].includes(value && value.type) ? value.type : fallback.type,
    items, summary: normalizedText(candidateSummary) === normalizedText(candidateTitle) ? '' : candidateSummary,
    needsConfirmation: Boolean(value && value.needsConfirmation), organizedBy: 'deepseek'
  }
}

const JOURNAL_AGENT_PROMPT = `你是“主线随行笔记”的微信聊天助手。用户用口语记录今天的计划、清单、进展，并可能继续追加或勾选已有清单。根据最近笔记判断操作：create 新建；append 追加到已有清单；check 勾选已有项；uncheck 取消勾选。不得新增原文没有的事实，不确定目标时 needsConfirmation=true，不要擅自修改。购物、准备物品和步骤列表用 checklist。title 必须是具体主题或动作，禁止使用“随手记”“今日记录”“笔记”“记录”等泛化标题。summary 与 title 或原文没有实质区别时返回空字符串。输出严格 JSON：{"operation":"create|append|check|uncheck","targetEntryId":"","targetItemText":"","title":"","type":"checklist|plan|note","items":[""],"summary":"","needsConfirmation":false}`

async function recentJournalEntries(workspaceId) {
  const result = await db.collection('captures').where({
    ownerOpenId: workspaceId, entryKind: 'journal_entry', journalDate: shanghaiDayKey(), deletedAt: ''
  }).orderBy('occurredAt', 'desc').limit(12).get()
  return result.data || []
}

async function understandJournalMessage(content, entries) {
  const fallback = ruleJournalAction(content, entries)
  try {
    const modelCall = app.ai().createModel('cloudbase').generateText({
      model: 'deepseek-v4-flash', temperature: 0.1,
      messages: [
        { role: 'system', content: JOURNAL_AGENT_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            message: content,
            recent: entries.map((entry) => ({
              id: entry.id,
              title: entry.journalTitle,
              type: entry.journalType,
              items: (entry.checklistItems || []).map((item) => ({ id: item.id, text: item.text, done: item.done }))
            }))
          })
        }
      ]
    })
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('AI timeout')), 2200))
    const response = await Promise.race([modelCall, timeout])
    return normalizeAgentAction(parseJson(response.text), content, entries)
  } catch (_) {
    return fallback
  }
}

async function applyJournalAction(identity, capture, action, entries, provider = 'wechat_mp') {
  const at = nowIso()
  const meta = {
    ownerOpenId: identity.activeWorkspaceId, workspaceId: identity.activeWorkspaceId,
    createdAt: capture.createdAt, updatedAt: at, version: Number(capture.version || 1) + 1,
    deletedAt: '', source: provider, sourceIds: capture.sourceIds || []
  }
  if (action.needsConfirmation) return { entry: null, needsConfirmation: true }
  if (action.operation === 'create') {
    const checklistItems = action.items.map((text) => ({ id: uid('journal_item'), text, done: false, createdAt: at, completedAt: '' }))
    const entry = {
      ...capture, ...meta, entryKind: 'journal_entry', kind: 'journal_entry', status: 'processed', organizationStatus: 'organized',
      journalDate: shanghaiDayKey(), journalTitle: action.title || '今日记录', journalSummary: action.summary,
      journalType: checklistItems.length ? 'checklist' : action.type, checklistItems,
      markdown: markdownOf(action.title || '今日记录', action.summary, checklistItems), organizedBy: action.organizedBy
    }
    assertRecordCapacity(entry)
    await setDoc('captures', capture.id, entry)
    return { entry, needsConfirmation: false }
  }
  const target = entries.find((entry) => entry.id === action.targetEntryId)
  if (!target) return { entry: null, needsConfirmation: true }
  let checklistItems = (target.checklistItems || []).map((item) => ({ ...item }))
  if (action.operation === 'append') {
    const existing = new Set(checklistItems.map((item) => String(item.text).replace(/\s+/g, '')))
    for (const text of action.items) {
      if (!existing.has(text.replace(/\s+/g, ''))) checklistItems.push({ id: uid('journal_item'), text, done: false, createdAt: at, completedAt: '' })
    }
  } else {
    checklistItems = checklistItems.map((item) => item.id === action.targetItemId ? { ...item, done: action.operation === 'check', completedAt: action.operation === 'check' ? at : '' } : item)
  }
  const entry = {
    ...target, checklistItems, markdown: markdownOf(target.journalTitle, target.journalSummary, checklistItems),
    updatedAt: at, version: Number(target.version || 1) + 1,
    sourceIds: [...new Set([...(target.sourceIds || []), capture.id])]
  }
  const processedCapture = { ...capture, entryKind: 'journal_message', status: 'processed', organizationStatus: 'organized', linkedJournalId: target.id, updatedAt: at, version: Number(capture.version || 1) + 1 }
  assertRecordCapacity(entry)
  assertRecordCapacity(processedCapture)
  await db.runTransaction(async (tx) => {
    const { _id: targetId, ...targetPayload } = entry
    const { _id: captureDocumentId, ...capturePayload } = processedCapture
    await tx.collection('captures').doc(target.id).set(targetPayload)
    await tx.collection('captures').doc(capture.id).set(capturePayload)
  })
  return { entry, needsConfirmation: false }
}

function journalReply(action, entry) {
  if (!entry) return '我还不能确定要修改哪一条笔记，已经放进“待确认”，你可以在小程序里看一下。'
  if (action.operation === 'check') return `已勾选「${action.targetItemText}」\n清单：${entry.journalTitle}`
  if (action.operation === 'uncheck') return `已取消勾选「${action.targetItemText}」\n清单：${entry.journalTitle}`
  if (action.operation === 'append') return `已补充到「${entry.journalTitle}」\n${action.items.map((item) => `☐ ${item}`).join('\n')}`.slice(0, 500)
  const items = entry.checklistItems || []
  return items.length ? `已整理成「${entry.journalTitle}」\n${items.slice(0, 8).map((item) => `☐ ${item.text}`).join('\n')}\n可在小程序“灵光一现”逐项勾选。`.slice(0, 500) : `已写入灵光一现\n「${entry.journalTitle}」\n${entry.journalSummary}`.slice(0, 500)
}

async function captureMessage(identity, message, provider = 'wechat_mp') {
  const messageId = String(message.messageId || hash(`${message.from}:${message.createdAt}:${message.content}`).slice(0, 32))
  const providerKey = String(provider || 'wechat_mp').replace(/[^a-z0-9_]/gi, '_').slice(0, 20)
  const eventId = `${providerKey}_event_${hash(messageId).slice(0, 40)}`
  const at = nowIso()
  const captureId = `capture_${providerKey}_${hash(messageId).slice(0, 32)}`
  const meta = {
    ownerOpenId: identity.activeWorkspaceId, workspaceId: identity.activeWorkspaceId,
    createdAt: at, updatedAt: at, version: 1, deletedAt: '', source: provider, sourceIds: [eventId]
  }
  const capture = {
    id: captureId, userId: identity.userId, rawContent: message.content, content: message.content,
    occurredAt: at, kind: 'journal_message', entryKind: 'journal_message', status: 'unprocessed', organizationStatus: 'organizing', ...meta
  }
  if (!captureFitsCapacity(capture)) {
    return { rejected: true, error: '内容超过当前记录容量，原文未截断，请拆分后重试。' }
  }
  const reservation = await reserveWebhookEvent(eventId, {
    messageId, provider, userId: identity.userId,
    ownerOpenId: identity.activeWorkspaceId, workspaceId: identity.activeWorkspaceId, captureId
  })
  if (reservation.duplicate) return { duplicate: true }
  if (reservation.reclaimed) {
    const previous = await getDoc('captures', captureId)
    if (previous && previous.ownerOpenId === identity.activeWorkspaceId) {
      const at = nowIso()
      if (previous.organizationStatus === 'organized' || previous.organizationStatus === 'pending_confirmation') {
        await setDoc('webhook_events', eventId, { ...(reservation.event || {}), id: eventId, captureId,
          status: 'done', processedAt: previous.updatedAt || at, updatedAt: at, deletedAt: '', source: provider })
        return { duplicate: true, captureId, entry: previous }
      }
      await db.runTransaction(async (tx) => {
        const captureRef = tx.collection('captures').doc(captureId)
        const current = dataOf(await captureRef.get()) || previous
        if (current && current.ownerOpenId === identity.activeWorkspaceId && current.organizationStatus !== 'organized' && current.organizationStatus !== 'pending_confirmation') {
          const { _id, ...capturePayload } = {
            ...current, status: 'processed', organizationStatus: 'failed',
            aiError: '上次微信消息整理结果未确认，原文已保留；请在灵光一现中明确重试',
            updatedAt: at, version: Number(current.version || 1) + 1
          }
          await captureRef.set(capturePayload)
        }
        const eventRef = tx.collection('webhook_events').doc(eventId)
        const event = { ...(reservation.event || {}), id: eventId, captureId, status: 'awaiting_retry',
          errorCode: 'AI_CALL_UNKNOWN', error: '整理结果未确认，需要用户明确重试', updatedAt: at, retryAfter: 0 }
        await eventRef.set(event)
      })
      await markSyncSignal(identity.activeWorkspaceId, `${provider}.journal.pending`)
      return { duplicate: true, pendingRetry: true, captureId }
    }
  }
  await setDoc('captures', captureId, capture)
  const entries = await recentJournalEntries(identity.activeWorkspaceId)
  const action = await understandJournalMessage(message.content, entries)
  const applied = await applyJournalAction(identity, capture, action, entries, provider)
  let proposalId = ''
  if (applied.needsConfirmation) {
    proposalId = `proposal_${providerKey}_${hash(messageId).slice(0, 32)}`
    await setDoc('proposals', proposalId, {
      id: proposalId, type: 'note', status: 'pending', title: action.title || message.content.slice(0, 80),
      detail: action.summary || message.content, owner: 'me', priority: 'normal', captureIds: [captureId],
      needsConfirmation: true, suggestedHandling: 'ask_user', usefulness: 0.72,
      confirmationQuestion: '这条消息应该新建笔记，还是补充到已有清单？',
      uncertaintyReason: '微信聊天中缺少明确的目标笔记。', ...meta
    })
    await setDoc('captures', captureId, { ...capture, status: 'processed', organizationStatus: 'pending_confirmation', updatedAt: nowIso(), version: 2 })
  }
  await setDoc('webhook_events', eventId, {
    ...(reservation.event || {}), id: eventId, messageId, provider, userId: identity.userId,
    ownerOpenId: identity.activeWorkspaceId, workspaceId: identity.activeWorkspaceId,
    captureId, proposalId, journalEntryId: applied.entry && applied.entry.id || '', action: action.operation,
    status: 'done', processedAt: nowIso(), updatedAt: nowIso(), deletedAt: '', source: provider
  })
  await markSyncSignal(identity.activeWorkspaceId, `${provider}.journal`)
  return { captureId, proposalId, entry: applied.entry, action }
}

async function handleInternalJournal(payload) {
  const provider = String(payload.provider || '')
  const providerUserId = String(payload.providerUserId || '')
  const content = String(payload.content || '').trim()
  if (!['wechat_kf'].includes(provider) || !providerUserId || !content) {
    return { ok: false, error: 'invalid internal journal payload' }
  }
  const identityResult = await db.collection('identities').where({ provider, providerUserId, deletedAt: '' }).limit(1).get()
  const identity = identityResult.data && identityResult.data[0]
  if (!identity) return { ok: false, unbound: true, reply: '请先从小程序首页打开“主线助手”完成连接。' }
  const result = await captureMessage(identity, {
    from: providerUserId,
    createdAt: String(payload.createdAt || ''),
    messageId: String(payload.messageId || ''),
    content
  }, provider)
  if (result.rejected) return { ok: false, error: result.error, retryable: false }
  return {
    ok: true,
    duplicate: Boolean(result.duplicate),
    reply: result.duplicate ? '这条消息已经记过了。' : journalReply(result.action, result.entry)
  }
}

async function handleMessage(xml) {
  const message = {
    to: xmlField(xml, 'ToUserName'), from: xmlField(xml, 'FromUserName'),
    type: xmlField(xml, 'MsgType'), content: xmlField(xml, 'Content').trim(),
    messageId: xmlField(xml, 'MsgId'), createdAt: xmlField(xml, 'CreateTime')
  }
  if (message.type !== 'text') return textReply(message.from, message.to, '目前内测版只接收文字记录。')
  const bindMatch = message.content.match(/^(?:绑定|BIND)\s*([A-Z0-9]{6,10})$/i)
  if (bindMatch) {
    const bound = await bindIdentity(message.from, bindMatch[1])
    return textReply(message.from, message.to, bound ? '绑定成功。之后发来的文字会由 AI 整理进小程序“灵光一现”；不确定的内容才会进入“AI 建议”。' : '绑定码无效或已过期，请在小程序重新生成。')
  }
  const identityResult = await db.collection('identities').where({ provider: 'wechat_mp', providerUserId: message.from, deletedAt: '' }).limit(1).get()
  const identity = identityResult.data && identityResult.data[0]
  if (!identity) return textReply(message.from, message.to, '请先在小程序“账号与工作区”生成绑定码，再发送“绑定 绑定码”。')
  const result = await captureMessage(identity, message)
  if (result.rejected) return textReply(message.from, message.to, result.error)
  return textReply(message.from, message.to, result.duplicate ? '这条消息已经记过了。' : journalReply(result.action, result.entry))
}

exports.main = async (event = {}) => {
  try {
    const query = queryOf(event)
    const body = bodyOf(event)
    if ((headerOf(event, 'content-type') || '').toLowerCase().includes('application/json')) {
      const timestamp = headerOf(event, 'x-mainline-timestamp')
      const signature = headerOf(event, 'x-mainline-signature')
      if (!validBridgeSignature(BRIDGE_SECRET, timestamp, body, signature)) {
        return response(403, JSON.stringify({ ok: false, error: 'invalid bridge signature' }), 'application/json; charset=utf-8')
      }
      const payload = JSON.parse(body || '{}')
      if (payload.kind !== 'internal.journal_ingest') {
        return response(400, JSON.stringify({ ok: false, error: 'unknown internal event' }), 'application/json; charset=utf-8')
      }
      return response(200, JSON.stringify(await handleInternalJournal(payload)), 'application/json; charset=utf-8')
    }
    const encrypted = xmlField(body, 'Encrypt') || query.echostr || ''
    const encryptedMode = query.encrypt_type === 'aes' || Boolean(xmlField(body, 'Encrypt'))
    if (encryptedMode) {
      if (!AES_KEY || !APP_ID) return response(503, 'encrypted callback is not configured')
      if (!validMessageSignature(TOKEN, query.timestamp, query.nonce, encrypted, query.msg_signature)) return response(403, 'invalid message signature')
      const decrypted = decryptWechatMessage(encrypted).message
      if (methodOf(event) === 'GET') return response(200, decrypted)
      const reply = await handleMessage(decrypted)
      return response(200, encryptedReply(reply, query.timestamp || undefined, query.nonce || undefined), 'application/xml; charset=utf-8')
    }
    if (!validSignature(TOKEN, query.timestamp, query.nonce, query.signature)) return response(403, 'invalid signature')
    if (methodOf(event) === 'GET') return response(200, escapeXml(query.echostr || ''))
    return response(200, await handleMessage(body), 'application/xml; charset=utf-8')
  } catch (error) {
    console.error(error)
    const statusCode = Number(error && error.statusCode) || (methodOf(event) === 'GET' ? 200 : 500)
    return response(statusCode, methodOf(event) === 'GET' ? escapeXml(queryOf(event).echostr || '') : 'temporary failure')
  }
}

exports.__test = {
  validSignature, messageSignature, validMessageSignature, encryptWechatMessage, decryptWechatMessage,
  xmlField, textReply, splitItems, ruleJournalAction, normalizeAgentAction, markdownOf,
  bridgeSignature, validBridgeSignature, webhookEventIsActive, captureFitsCapacity, assertRecordCapacity,
  captureMessage, applyJournalAction
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
        queryStringParameters: Object.fromEntries(url.searchParams.entries()),
        headers: request.headers,
        body
      })
      responseStream.statusCode = result.statusCode || 200
      for (const [name, value] of Object.entries(result.headers || {})) responseStream.setHeader(name, value)
      responseStream.end(result.body || '')
    } catch (error) {
      responseStream.statusCode = error.statusCode || 500
      responseStream.end('success')
    }
  })
  server.listen(Number(process.env.PORT || 9000), '0.0.0.0')
}

