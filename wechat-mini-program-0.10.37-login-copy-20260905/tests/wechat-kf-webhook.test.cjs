const test = require('node:test')
const assert = require('node:assert/strict')
const { __test } = require('../cloudfunctions/wechatKfWebhook/index.js')

test('WeChat Customer Service callbacks verify and decrypt safely', () => {
  const token = 'customer-service-token'
  const timestamp = '1786118400000'
  const nonce = 'nonce-1'
  const corpId = 'ww1234567890abcdef'
  const aesKey = Buffer.alloc(32, 9).toString('base64').replace(/=$/, '')
  const xml = '<xml><Event><![CDATA[kf_msg_or_event]]></Event><Token><![CDATA[next-token]]></Token><OpenKfId><![CDATA[wk123]]></OpenKfId></xml>'
  const encrypted = __test.encryptWechatMessage(xml, corpId, aesKey, Buffer.alloc(16, 4))
  const signature = __test.messageSignature(token, timestamp, nonce, encrypted)
  assert.equal(__test.validMessageSignature(token, timestamp, nonce, encrypted, signature), true)
  assert.deepEqual(__test.decryptWechatMessage(encrypted, corpId, aesKey), { message: xml, receiveId: corpId })
})

test('one-time customer service scene token is strict', () => {
  const token = 'a'.repeat(36)
  assert.equal(__test.parseSceneToken(`mln_${token}`), token)
  assert.equal(__test.parseSceneToken(`another_${token}`), '')
  assert.equal(__test.parseSceneToken('mln_short'), '')
})

test('customer text and entry event normalize into stable fields', () => {
  const text = __test.normalizeKfMessage({
    msgid: 'msg-1', open_kfid: 'wk-1', external_userid: 'wm-1', send_time: 123,
    origin: 3, msgtype: 'text', text: { content: '计划买菜，买鸡蛋和牛奶' }
  })
  assert.equal(text.origin, 3)
  assert.equal(text.content, '计划买菜，买鸡蛋和牛奶')
  const entry = __test.normalizeKfMessage({
    msgid: 'event-1', open_kfid: 'wk-1', external_userid: 'wm-1', msgtype: 'event',
    event: { event_type: 'enter_session', scene_param: `mln_${'b'.repeat(36)}`, welcome_code: 'welcome-1' }
  })
  assert.equal(entry.eventType, 'enter_session')
  assert.equal(entry.welcomeCode, 'welcome-1')
})
