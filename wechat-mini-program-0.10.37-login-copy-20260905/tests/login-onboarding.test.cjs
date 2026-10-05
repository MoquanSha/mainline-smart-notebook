const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.resolve(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8')

test('first page is the explicit WeChat identity login flow', () => {
  const app = JSON.parse(read('miniprogram', 'app.json'))
  const page = read('miniprogram', 'pages', 'onboarding', 'index.wxml')
  assert.equal(app.pages[0], 'pages/onboarding/index')
  assert.match(page, /微信身份登录/)
  assert.match(page, /创建个人空间/)
  assert.match(page, /不读取手机号、头像或昵称/)
  assert.doesNotMatch(page, /输入邀请码/)
})

test('personal workspace creation is explicit and deterministic', () => {
  const server = read('cloudfunctions', 'notebookApi', 'index.js')
  const page = read('miniprogram', 'pages', 'onboarding', 'index.js')
  assert.match(server, /action === 'workspace\.createPersonal'/)
  assert.match(server, /workspace_\$\{hashId\(openId, 32\)\}/)
  assert.match(server, /name: '个人空间'/)
  assert.match(server, /return ok\(await personalWorkspaceBootstrap\(created\)\)/)
  assert.match(server, /businessReadQueries: 0/)
  assert.match(page, /api\.call\('workspace\.createPersonal'/)
  assert.match(page, /CREATE_REQUEST_KEY/)
})

test('identity lookup alone does not create a workspace', () => {
  const server = read('cloudfunctions', 'notebookApi', 'index.js')
  const principal = server.slice(server.indexOf('async function principalForOpenId'), server.indexOf('async function createPersonalWorkspace'))
  assert.doesNotMatch(principal, /createInitialWorkspace/)
  assert.match(principal, /return null/)
})

test('existing local account skips onboarding without another login request', () => {
  const page = read('miniprogram', 'pages', 'onboarding', 'index.js')
  assert.match(page, /cached && cached\.account/)
  assert.match(page, /this\.enterApp\(\)/)
})

function loadOnboarding({ cachedBootstrap = null, scannedValue = '' } = {}) {
  const source = read('miniprogram', 'pages', 'onboarding', 'index.js')
  const storage = new Map()
  const calls = []
  const launches = []
  let definition
  const api = {
    async bootstrap() {
      calls.push({ action: 'bootstrap' })
      return { onboardingRequired: true, account: null }
    },
    async call(action, payload, options) {
      calls.push({ action, payload, options })
      return {
        onboardingRequired: false,
        account: {
          user: { id: 'user_wechat_test', displayName: '微信用户' },
          workspaceId: 'workspace_wechat_test',
          workspaces: [{ id: 'workspace_wechat_test', name: '个人空间', active: true }]
        }
      }
    }
  }
  const cache = {
    KEYS: { bootstrap: 'bootstrap' },
    read(key, fallback) { return key === 'bootstrap' ? (cachedBootstrap || fallback) : fallback },
    write(key, value) { storage.set(key, value) },
    requestId() { return 'personal_workspace_request_1' }
  }
  const context = {
    require(request) {
      if (request === '../../utils/api') return api
      if (request === '../../utils/cache') return cache
      if (request === '../../config/env') return {}
      throw new Error(`Unexpected require: ${request}`)
    },
    Page(value) { definition = value },
    wx: {
      getStorageSync(key) { return storage.get(key) || '' },
      setStorageSync(key, value) { storage.set(key, value) },
      removeStorageSync(key) { storage.delete(key) },
      scanCode(options) { options.success({ result: scannedValue }) },
      reLaunch(options) { launches.push(options.url) }
    },
    decodeURIComponent,
    Promise
  }
  vm.runInNewContext(source, context, { filename: 'miniprogram/pages/onboarding/index.js' })
  const page = {
    ...definition,
    data: { ...definition.data },
    setData(patch) { Object.assign(this.data, patch) }
  }
  return { page, calls, launches, storage }
}

test('new WeChat user explicitly creates one personal workspace before entering the app', async () => {
  const runtime = loadOnboarding()
  runtime.page.onLoad.call(runtime.page, {})
  assert.equal(runtime.page.data.stage, 'login')
  assert.deepEqual(runtime.launches, [])

  await runtime.page.loginWithWechat.call(runtime.page)
  assert.equal(runtime.page.data.stage, 'create')
  assert.deepEqual(runtime.calls.map((item) => item.action), ['bootstrap'])

  await runtime.page.createPersonalSpace.call(runtime.page)
  assert.deepEqual(runtime.calls.map((item) => item.action), ['bootstrap', 'workspace.createPersonal'])
  assert.equal(runtime.calls[1].payload.requestId, 'personal_workspace_request_1')
  assert.deepEqual(runtime.launches, ['/pages/home/index'])
  assert.equal(runtime.storage.has('mainline.login.personalCreateRequestId'), false)
  assert.equal(runtime.storage.get('bootstrap').account.workspaceId, 'workspace_wechat_test')
})

test('cached existing account enters the app without a CloudBase login call', () => {
  const runtime = loadOnboarding({
    cachedBootstrap: { account: { workspaceId: 'workspace_existing' } }
  })
  runtime.page.onLoad.call(runtime.page, {})
  assert.deepEqual(runtime.calls, [])
  assert.deepEqual(runtime.launches, ['/pages/home/index'])
})

test('desktop QR is scanned inside the mini-program before explicit authorization', async () => {
  const runtime = loadOnboarding({
    scannedValue: 'https://mainline-notebook.local/desktop-login?scene=qr_login_0123456789abcdef012345'
  })
  await runtime.page.scanDesktopLogin.call(runtime.page)
  assert.equal(runtime.page.data.scene, 'qr_login_0123456789abcdef012345')
  assert.equal(runtime.page.data.stage, 'create')
  assert.deepEqual(runtime.calls.map((item) => item.action), ['bootstrap'])
})
