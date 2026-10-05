const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { __test } = require('../cloudfunctions/wechatWebhook/index.js')
const { cloudRuntime } = require('./helpers/cloud-runtime.cjs')

test('official account signature follows the WeChat SHA-1 rule', () => {
  const token = 'beta-token'
  const timestamp = '1720000000'
  const nonce = 'abc123'
  const signature = crypto.createHash('sha1').update([token, timestamp, nonce].sort().join('')).digest('hex')
  assert.equal(__test.validSignature(token, timestamp, nonce, signature), true)
  assert.equal(__test.validSignature(token, timestamp, nonce, 'wrong'), false)
})

test('plain XML messages preserve text content', () => {
  const xml = '<xml><FromUserName><![CDATA[user-open-id]]></FromUserName><Content><![CDATA[今天整理申请材料]]></Content></xml>'
  assert.equal(__test.xmlField(xml, 'FromUserName'), 'user-open-id')
  assert.equal(__test.xmlField(xml, 'Content'), '今天整理申请材料')
})

test('encrypted official-account messages verify and round-trip safely', () => {
  const token = 'beta-token'
  const timestamp = '1720000000'
  const nonce = 'abc123'
  const appId = 'wx1234567890abcdef'
  const aesKey = Buffer.alloc(32, 7).toString('base64').replace(/=$/, '')
  const xml = '<xml><FromUserName><![CDATA[user-open-id]]></FromUserName><Content><![CDATA[计划买菜，买鸡蛋和牛奶]]></Content></xml>'
  const encrypted = __test.encryptWechatMessage(xml, appId, aesKey, Buffer.alloc(16, 3))
  const signature = __test.messageSignature(token, timestamp, nonce, encrypted)
  assert.equal(__test.validMessageSignature(token, timestamp, nonce, encrypted, signature), true)
  assert.equal(__test.validMessageSignature(token, timestamp, nonce, encrypted, 'wrong'), false)
  assert.deepEqual(__test.decryptWechatMessage(encrypted, appId, aesKey), { message: xml, appId })
  assert.throws(() => __test.decryptWechatMessage(encrypted, 'another-app-id', aesKey), /AppID mismatch/)
})

test('公众号买菜消息会整理成 Markdown 可勾选清单', () => {
  const action = __test.ruleJournalAction('计划买菜，买西红柿、鸡蛋、牛奶', [])
  assert.equal(action.operation, 'create')
  assert.equal(action.type, 'checklist')
  assert.deepEqual(action.items, ['西红柿', '鸡蛋', '牛奶'])
  const markdown = __test.markdownOf(action.title, action.summary, action.items.map((text) => ({ text, done: false })))
  assert.match(markdown, /## 买菜清单/)
  assert.match(markdown, /- \[ \] 鸡蛋/)
})

test('公众号可以追加和勾选已有清单', () => {
  const entries = [{
    id: 'journal_1', journalTitle: '买菜清单',
    checklistItems: [{ id: 'item_egg', text: '鸡蛋', done: false }]
  }]
  const append = __test.ruleJournalAction('再加一盒酸奶', entries)
  assert.equal(append.operation, 'append')
  assert.deepEqual(append.items, ['一盒酸奶'])
  const check = __test.ruleJournalAction('鸡蛋买好了', entries)
  assert.equal(check.operation, 'check')
  assert.equal(check.targetItemId, 'item_egg')
})

test('internal organizer bridge rejects stale or altered requests', () => {
  const secret = 'bridge-secret'
  const body = JSON.stringify({ kind: 'internal.journal_ingest', content: '今天买菜' })
  const timestamp = String(Date.now())
  const signature = __test.bridgeSignature(secret, timestamp, body)
  assert.equal(__test.validBridgeSignature(secret, timestamp, body, signature), true)
  assert.equal(__test.validBridgeSignature(secret, timestamp, `${body}x`, signature), false)
  assert.equal(__test.validBridgeSignature(secret, String(Date.now() - 10 * 60 * 1000), body, signature), false)
})

test('重复回调租约只在处理中窗口内生效，完成事件永久去重', () => {
  const now = Date.parse('2026-09-25T12:00:00.000Z')
  assert.equal(__test.webhookEventIsActive({ status: 'processing', claimedAt: '2026-09-25T11:59:00.000Z' }, now), true)
  assert.equal(__test.webhookEventIsActive({ status: 'processing', claimedAt: '2026-09-25T11:56:00.000Z' }, now), false)
  assert.equal(__test.webhookEventIsActive({ status: 'done', claimedAt: '2026-09-25T11:59:00.000Z' }, now), false)
})

test('入口容量检查拒绝超大原文而不截断', () => {
  assert.equal(__test.captureFitsCapacity({ rawContent: 'a'.repeat(799000) }), true)
  assert.equal(__test.captureFitsCapacity({ rawContent: 'a'.repeat(801000) }), false)
  assert.throws(() => __test.assertRecordCapacity({ rawContent: 'a'.repeat(801000) }), { code: 'RECORD_TOO_LARGE' })
})

test('公众号长原文保留完整尾部，短摘要只用于展示', async () => {
  const runtime = cloudRuntime()
  const content = `今天记录一段较长的经历。${'正文内容 '.repeat(2600)}尾部标记-不得丢失`
  const result = await runtime.webhook.captureMessage({ userId: 'user-long', activeWorkspaceId: 'space-long' }, {
    messageId: 'long-message-1', from: 'wx-long', createdAt: '2026-09-25T00:00:00.000Z', content
  }, 'wechat_mp')
  assert.ok(result.captureId)
  const row = runtime.rows.get(`captures/${result.captureId}`)
  assert.equal(row.rawContent, content)
  assert.equal(row.content, content)
  assert.match(row.rawContent, /尾部标记-不得丢失$/)
  assert.ok(String(row.journalSummary || '').length <= 500)
})

test('公众号追加同时提交目标记录和消息回执，容量失败时两者都不变', async () => {
  const runtime = cloudRuntime(), owner = 'space-webhook'
  const target = {
    id: 'journal-target', ownerOpenId: owner, workspaceId: owner, journalTitle: '买菜清单', journalSummary: '',
    checklistItems: [{ id: 'item-egg', text: '鸡蛋', done: false }], version: 2,
    createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z', deletedAt: ''
  }
  const capture = {
    id: 'message-1', ownerOpenId: owner, workspaceId: owner, rawContent: '再加一盒酸奶', content: '再加一盒酸奶',
    createdAt: '2026-09-25T00:01:00.000Z', updatedAt: '2026-09-25T00:01:00.000Z', version: 1, deletedAt: ''
  }
  runtime.rows.set('captures/' + target.id, target)
  const action = { operation: 'append', targetEntryId: target.id, items: ['一盒酸奶'], needsConfirmation: false }
  const applied = await runtime.webhook.applyJournalAction({ userId: 'user-a', activeWorkspaceId: owner }, capture, action, [target], 'wechat_mp')
  assert.deepEqual(applied.entry.checklistItems.map((item) => item.text), ['鸡蛋', '一盒酸奶'])
  assert.equal(runtime.rows.get('captures/' + target.id).checklistItems.length, 2)
  assert.equal(runtime.rows.get('captures/' + capture.id).linkedJournalId, target.id)
  assert.equal(runtime.metrics.transactions, 1)
  const before = structuredClone(runtime.rows.get('captures/' + target.id))
  const oversized = { ...target, checklistItems: [{ id: 'large', text: 'x'.repeat(810000), done: false }] }
  await assert.rejects(runtime.webhook.applyJournalAction({ userId: 'user-a', activeWorkspaceId: owner }, { ...capture, id: 'message-2' }, action, [oversized], 'wechat_mp'), { code: 'RECORD_TOO_LARGE' })
  assert.deepEqual(runtime.rows.get('captures/' + target.id), before)
  assert.equal(runtime.rows.has('captures/message-2'), false)
})

test('过期的微信整理租约不自动再次调用模型，而是把原文标为需明确重试', async () => {
  const runtime = cloudRuntime(), owner = 'space-webhook-retry', messageId = 'msg-unknown'
  const digest = (value) => crypto.createHash('sha256').update(String(value || '')).digest('hex')
  const eventId = `wechat_mp_event_${digest(messageId).slice(0, 40)}`
  const captureId = `capture_wechat_mp_${digest(messageId).slice(0, 32)}`
  runtime.rows.set('webhook_events/' + eventId, {
    id: eventId, status: 'processing', claimedAt: '2020-01-01T00:00:00.000Z', ownerOpenId: owner,
    workspaceId: owner, captureId, provider: 'wechat_mp', messageId
  })
  runtime.rows.set('captures/' + captureId, {
    id: captureId, ownerOpenId: owner, workspaceId: owner, rawContent: '一段待整理原文', content: '一段待整理原文',
    status: 'unprocessed', organizationStatus: 'organizing', version: 1, deletedAt: ''
  })
  const result = await runtime.webhook.captureMessage({ userId: 'user-a', activeWorkspaceId: owner }, {
    messageId, from: 'wx-user', createdAt: '2026-09-25T00:00:00.000Z', content: '一段待整理原文'
  }, 'wechat_mp')
  assert.equal(result.duplicate, true)
  assert.equal(result.pendingRetry, true)
  assert.equal(runtime.rows.get('captures/' + captureId).organizationStatus, 'failed')
  assert.equal(runtime.rows.get('webhook_events/' + eventId).status, 'awaiting_retry')
})
