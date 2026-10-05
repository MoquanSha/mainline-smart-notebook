const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const file = path.join(__dirname, '..', 'miniprogram', 'utils', 'home-connection-text.js')
const source = fs.readFileSync(file, 'utf8')
const compiled = { exports: {} }
new Function('module', 'exports', source)(compiled, compiled.exports)
const { parseHomeConnectionText } = compiled.exports

test('可从电脑复制的两行文本中识别地址和连接凭证', () => {
  const token = 'aBcD_0123456789-abcdefghijklmnopqrstuvwxyz'
  const result = parseHomeConnectionText(`家庭同步地址：https://home.example.com/\n设备连接凭证：${token}`)

  assert.deepEqual(result, {
    serverBaseUrl: 'https://home.example.com',
    token
  })
})

test('不完整文本不会被误认为连接信息', () => {
  assert.deepEqual(parseHomeConnectionText('只有一些普通笔记内容'), {
    serverBaseUrl: '',
    token: ''
  })
})

test('connecting a home server uses the shared primary receiver before mirror work', () => {
  const accountSource = fs.readFileSync(
    path.join(__dirname, '..', 'miniprogram', 'pages', 'account', 'index.js'),
    'utf8'
  )
  const primaryFlush = accountSource.indexOf("await app.requestSync('account-connect')")
  const mirrorFlush = accountSource.indexOf('await api.flushMirrorQueue()')

  assert.ok(primaryFlush >= 0)
  assert.ok(mirrorFlush > primaryFlush)
  assert.ok(!accountSource.includes('app.startHomeRealtimeSync()'), 'receive capability must be negotiated by the shared receiver')
})
