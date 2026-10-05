const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { _electron: electron } = require('playwright')

const ROOT = path.resolve(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PROFILE_ROOT = path.join(ROOT, '.tmp', 'rendered-wechat-login-profile')
const SCREENSHOT = path.join(ROOT, '.codex-qa', 'wechat-login-qr.png')

test('rendered desktop login window creates a scannable QR session', async () => {
  fs.mkdirSync(PROFILE_ROOT, { recursive: true })
  fs.mkdirSync(path.dirname(SCREENSHOT), { recursive: true })
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: ['.'],
    cwd: ROOT,
    env: {
      ...process.env,
      MAINLINE_MULTI_USER_DATA_ROOT: PROFILE_ROOT,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    }
  })
  try {
    const window = await app.firstWindow({ timeout: 30000 })
    await window.waitForLoadState('domcontentloaded')
    await assert.doesNotReject(() => window.locator('#startLoginButton').waitFor({ state: 'visible' }))
    assert.equal(
      await window.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
      'rgb(244, 245, 248)'
    )
    assert.equal(
      await window.locator('#startLoginButton').evaluate((element) => getComputedStyle(element).borderRadius),
      '11px'
    )
    assert.match(await window.locator('.helper').innerText(), /扫描电脑登录二维码/)

    await window.locator('#startLoginButton').click()
    await window.locator('#qrPanel').waitFor({ state: 'visible', timeout: 30000 })
    const qrSource = await window.locator('#loginQr').getAttribute('src')
    assert.match(String(qrSource || ''), /^data:image\/png;base64,/)
    assert.match(await window.locator('#accountMessage').innerText(), /扫描电脑登录二维码/)
    await window.screenshot({ path: SCREENSHOT, fullPage: true })
  } finally {
    await app.close()
  }
})
