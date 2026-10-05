const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8')

test('desktop QR login uses an in-mini-program scanner without six-digit pairing or OpenAPI token', () => {
  const source = read('cloudfunctions', 'desktopSync', 'index.js')
  assert.match(source, /createMiniProgramQrLogin/)
  assert.match(source, /loginMode: 'mini_program_scanner'/)
  assert.match(source, /mainline-notebook\.local\/desktop-login\?scene=/)
  assert.match(source, /qr_login_\$\{crypto\.randomBytes\(11\)/)
  const miniQrLogin = source.slice(source.indexOf('async function createMiniProgramQrLogin'), source.indexOf('async function createQrLogin'))
  assert.doesNotMatch(miniQrLogin, /miniQrCode|app\.callFunction/)
  assert.doesNotMatch(source, /pair\.exchange/)
})

test('mini-program confirmation binds the scanned WeChat identity to the pending device', () => {
  const server = read('cloudfunctions', 'notebookApi', 'index.js')
  const page = read('miniprogram', 'pages', 'account', 'index.js')
  const onboarding = read('miniprogram', 'pages', 'onboarding', 'index.js')
  assert.match(server, /action === 'login\.mini\.complete'/)
  assert.match(server, /status: 'qr_authorized'/)
  assert.match(page, /confirmDesktopQrLogin/)
  assert.match(onboarding, /confirmDesktopLogin/)
  assert.match(onboarding, /wx\.scanCode/)
  assert.match(page, /scanDesktopQrLogin/)
  assert.match(onboarding, /action === 'login\.mini\.complete'|api\.call\('login\.mini\.complete'/)
  assert.doesNotMatch(page, /onLoad[\s\S]{0,500}completeDesktopQrLogin\(/)
})

test('desktop login requires a visible confirm or cancel decision on the phone', () => {
  const wxml = read('miniprogram', 'pages', 'onboarding', 'index.wxml')
  assert.match(wxml, /允许这台电脑登录/)
  assert.match(wxml, /bindtap="confirmDesktopLogin"/)
  assert.match(wxml, /bindtap="cancelDesktopLogin"/)
})
