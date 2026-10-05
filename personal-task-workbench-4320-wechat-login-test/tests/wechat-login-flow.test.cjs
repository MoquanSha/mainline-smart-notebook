const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const cloudSync = require(path.join(ROOT, 'electron', 'cloud-sync.cjs'))

function response(data, ok = true) {
  return {
    ok,
    status: ok ? 200 : 400,
    async json() { return data }
  }
}

test('desktop QR login creates a bounded session and waits for phone authorization', async () => {
  const originalFetch = global.fetch
  const requests = []
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body)
    requests.push(body)
    if (body.action === 'login.qr.create') {
      return response({ ok: true, data: {
        sessionId: 'session_test',
        pollToken: 'poll_test',
        expiresAt: '2026-09-14T08:00:00.000Z',
        loginUrl: 'https://example.test/login'
      } })
    }
    return response({ ok: true, data: { status: 'waiting' } })
  }
  try {
    const session = await cloudSync.startLogin({
      endpoint: 'https://example.test/desktop-sync',
      deviceName: '主线笔记登录测试版 Windows'
    })
    assert.equal(session.sessionId, 'session_test')
    assert.equal(requests[0].action, 'login.qr.create')
    assert.equal(requests[0].payload.deviceName, '主线笔记登录测试版 Windows')
    await assert.rejects(() => cloudSync.exchangeLogin(session), { code: 'LOGIN_WAITING' })
    assert.equal(requests[1].action, 'login.qr.poll')
    assert.equal(requests[1].payload.pollToken, 'poll_test')
  } finally {
    global.fetch = originalFetch
  }
})

test('desktop account window uses explicit phone confirmation and bounded backoff', () => {
  const account = fs.readFileSync(path.join(ROOT, 'electron', 'account.js'), 'utf8')
  const html = fs.readFileSync(path.join(ROOT, 'electron', 'account.html'), 'utf8')
  assert.match(account, /AUTO_CHECK_DELAYS_MS = \[3000, 5000, 8000, 15000, 30000, 60000\]/)
  assert.match(account, /expiresAt = startedAt \+ 10 \* 60 \* 1000/)
  assert.match(html, /扫描电脑登录二维码/)
  assert.match(account, /手机尚未确认/)
  assert.match(account, /cancelLogin/)
})

test('desktop login rejects an authorized response without complete user identity', async () => {
  const originalFetch = global.fetch
  global.fetch = async () => response({ ok: true, data: { status: 'authorized', token: 'token-only' } })
  try {
    await assert.rejects(() => cloudSync.exchangeLogin({
      endpoint: 'https://example.test/desktop-sync',
      sessionId: 'session_test',
      pollToken: 'poll_test'
    }), /完整的用户与工作区身份/)
  } finally {
    global.fetch = originalFetch
  }
})
