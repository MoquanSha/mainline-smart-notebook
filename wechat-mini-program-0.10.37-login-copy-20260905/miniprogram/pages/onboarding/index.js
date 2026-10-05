const api = require('../../utils/api')
const cache = require('../../utils/cache')
const config = require('../../config/env')

const CREATE_REQUEST_KEY = 'mainline.login.personalCreateRequestId'

function normalizedScene(value) {
  let scene = String(value || '')
  try { scene = decodeURIComponent(scene) } catch (_) {}
  return /^qr_login_[a-f0-9]{22}$/i.test(scene) ? scene : ''
}

function sceneFromDesktopQr(value) {
  const match = /^https:\/\/mainline-notebook\.local\/desktop-login\?scene=(qr_login_[a-f0-9]{22})$/i.exec(String(value || '').trim())
  return match ? normalizedScene(match[1]) : ''
}

Page({
  data: {
    stage: 'login',
    busy: false,
    error: '',
    scene: '',
    deviceName: '主线笔记 Windows'
  },

  onHide() {
    this.viewEpoch = (this.viewEpoch || 0) + 1
  },

  onUnload() {
    this.unloaded = true
    this.onHide()
  },

  currentScope() {
    try { return cache.scopeToken ? cache.scopeToken() : null } catch (_) { return null }
  },

  requestIsCurrent(scope, epoch) {
    if (this.unloaded || epoch !== (this.viewEpoch || 0)) return false
    try { return !cache.scopeToken || scope === cache.scopeToken() } catch (_) { return false }
  },

  onLoad(options = {}) {
    this.unloaded = false
    this.viewEpoch = (this.viewEpoch || 0) + 1
    const scene = normalizedScene(options.scene)
    this.setData({ scene })
    const cached = cache.read(cache.KEYS.bootstrap, null)
    if (cached && cached.account) {
      if (scene) this.prepareDesktopConfirmation(scene)
      else this.enterApp()
    }
  },

  async loginWithWechat() {
    if (this.data.busy) return
    const epoch = this.viewEpoch || 0
    const scope = this.currentScope()
    this.setData({ busy: true, error: '' })
    try {
      const bootstrap = await api.bootstrap()
      if (!this.requestIsCurrent(scope, epoch)) return
      if (bootstrap && bootstrap.account) {
        if (this.data.scene) await this.prepareDesktopConfirmation(this.data.scene)
        else this.enterApp()
        return
      }
      this.setData({ stage: 'create' })
    } catch (error) {
      if (this.requestIsCurrent(scope, epoch)) this.setData({ error: error.message || '微信身份确认失败，请重试。' })
    } finally {
      if (this.requestIsCurrent(scope, epoch)) this.setData({ busy: false })
    }
  },

  async scanDesktopLogin() {
    if (this.data.busy) return
    const epoch = this.viewEpoch || 0
    const scope = this.currentScope()
    this.setData({ error: '' })
    try {
      const result = await new Promise((resolve, reject) => wx.scanCode({
        onlyFromCamera: false,
        scanType: ['qrCode'],
        success: resolve,
        fail: reject
      }))
      const scene = sceneFromDesktopQr(result && result.result)
      if (!scene) throw new Error('这不是主线笔记电脑登录二维码。')
      if (!this.requestIsCurrent(scope, epoch)) return
      this.setData({ scene })
      await this.loginWithWechat()
    } catch (error) {
      if (!this.requestIsCurrent(scope, epoch)) return
      if (/cancel/i.test(String(error && error.errMsg || ''))) return
      this.setData({ error: error.message || '二维码读取失败，请重试。' })
    }
  },

  async createPersonalSpace() {
    if (this.data.busy) return
    const epoch = this.viewEpoch || 0
    const scope = this.currentScope()
    this.setData({ busy: true, error: '' })
    try {
      let requestId = String(wx.getStorageSync(CREATE_REQUEST_KEY) || '')
      if (!requestId) {
        requestId = cache.requestId('personal_workspace')
        wx.setStorageSync(CREATE_REQUEST_KEY, requestId)
      }
      const bootstrap = await api.call('workspace.createPersonal', { requestId }, { requestId })
      if (!this.requestIsCurrent(scope, epoch)) return
      cache.write(cache.KEYS.bootstrap, bootstrap)
      wx.removeStorageSync(CREATE_REQUEST_KEY)
      if (this.data.scene) await this.prepareDesktopConfirmation(this.data.scene)
      else this.enterApp()
    } catch (error) {
      if (this.requestIsCurrent(scope, epoch)) this.setData({ error: error.message || '个人空间创建失败，请重试。' })
    } finally {
      if (this.requestIsCurrent(scope, epoch)) this.setData({ busy: false })
    }
  },

  async prepareDesktopConfirmation(scene) {
    const epoch = this.viewEpoch || 0
    const scope = this.currentScope()
    this.setData({ stage: 'desktop', busy: true, error: '' })
    try {
      const preview = await api.call('login.mini.preview', { scene }, { forceRemote: true })
      if (!this.requestIsCurrent(scope, epoch)) return
      this.setData({ deviceName: preview.deviceName || '主线笔记 Windows' })
    } catch (error) {
      if (this.requestIsCurrent(scope, epoch)) this.setData({ stage: 'desktop-error', error: error.message || '二维码已失效，请回到电脑重新生成。' })
    } finally {
      if (this.requestIsCurrent(scope, epoch)) this.setData({ busy: false })
    }
  },

  async confirmDesktopLogin() {
    if (this.data.busy || !this.data.scene) return
    const epoch = this.viewEpoch || 0
    const scope = this.currentScope()
    this.setData({ busy: true, error: '' })
    try {
      await api.call('login.mini.complete', { scene: this.data.scene }, { forceRemote: true })
      if (!this.requestIsCurrent(scope, epoch)) return
      this.setData({ stage: 'desktop-success' })
    } catch (error) {
      if (this.requestIsCurrent(scope, epoch)) this.setData({ error: error.message || '电脑登录确认失败，请重新扫码。' })
    } finally {
      if (this.requestIsCurrent(scope, epoch)) this.setData({ busy: false })
    }
  },

  cancelDesktopLogin() {
    this.setData({ stage: 'desktop-cancelled' })
  },

  enterApp() {
    wx.reLaunch({ url: '/pages/home/index' })
  }
})
