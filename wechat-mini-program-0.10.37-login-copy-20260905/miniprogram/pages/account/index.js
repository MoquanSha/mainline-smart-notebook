const api = require('../../utils/api')
const cache = require('../../utils/cache')
const config = require('../../config/env')
const { parseHomeConnectionText } = require('../../utils/home-connection-text.js')
const syncFeedback = require('../../utils/sync-feedback')

function sceneFromDesktopQr(value) {
  const match = /^https:\/\/mainline-notebook\.local\/desktop-login\?scene=(qr_login_[a-f0-9]{22})$/i.exec(String(value || '').trim())
  return match ? match[1] : ''
}

Page({
  data: {
    loading: true,
    cloudSyncEnabled: config.cloudSyncEnabled === true,
    onboardingRequired: false,
    account: null,
    members: [],
    code: '',
    displayName: '',
    joining: false,
    invite: null,
    creatingInvite: false,
    bindCode: null,
    officialAccountReady: false,
    officialAccountUnavailable: false,
    hybridMode: 'local',
    hybridLabel: '电脑本地同步',
    serverBaseUrl: '',
    homeToken: '',
    homeTesting: false,
    homeConnected: false,
    homeConfigured: false,
    connectionDetailsOpen: false,
    homeStatus: '尚未连接电脑',
    pendingLocal: 0,
    pendingCloud: 0,
    homeRecoveryCount: 0,
    homeUnscopedCount: 0,
    homeRecovering: false,
    homeRecoveryMessage: '',
    recoveringCloud: false,
    desktopQrStatus: '',
    desktopQrMessage: ''
  },
  onLoad(options = {}) {
    this.focusSection = options.section || ''
    const rawScene = options.scene || ''
    let scene = String(rawScene)
    try { scene = decodeURIComponent(scene) } catch (_) {}
    if (/^qr_login_[a-f0-9]{22}$/i.test(scene)) {
      this.pendingDesktopQrScene = scene
      this.setData({ desktopQrStatus: 'pending', desktopQrMessage: '是否允许这台电脑登录你的个人空间？' })
    }
  },
  async confirmDesktopQrLogin() {
    const scene = this.pendingDesktopQrScene
    if (!scene) return
    const current = this.pageGuard()
    if (this.desktopQrCompleting) return
    this.desktopQrCompleting = true
    this.setData({ desktopQrStatus: 'working', desktopQrMessage: '正在确认电脑登录…' })
    try {
      const response = await wx.cloud.callFunction({
        name: config.apiFunction,
        data: { action: 'login.mini.complete', payload: { scene }, clientVersion: config.clientVersion }
      })
      const result = response && response.result
      if (!result || result.ok === false) {
        throw new Error(result && result.error && result.error.message || '电脑登录确认失败')
      }
      if (!current()) return
      this.setData({ desktopQrStatus: 'success', desktopQrMessage: '电脑已授权，可以返回电脑端。' })
      wx.showToast({ title: '电脑登录已确认', icon: 'success' })
      await this.refresh()
    } catch (error) {
      if (current()) this.setData({ desktopQrStatus: 'error', desktopQrMessage: error.message || '二维码已失效，请回到电脑重新生成。' })
    } finally { this.desktopQrCompleting = false }
  },
  async scanDesktopQrLogin() {
    const current = this.pageGuard()
    try {
      const result = await new Promise((resolve, reject) => wx.scanCode({
        onlyFromCamera: false,
        scanType: ['qrCode'],
        success: resolve,
        fail: reject
      }))
      const scene = sceneFromDesktopQr(result && result.result)
      if (!scene) throw new Error('这不是主线笔记电脑登录二维码。')
      const preview = await api.call('login.mini.preview', { scene }, { forceRemote: true })
      if (!current()) return
      this.pendingDesktopQrScene = scene
      this.setData({
        desktopQrStatus: 'pending',
        desktopQrMessage: `是否允许${preview.deviceName || '这台电脑'}登录你的个人空间？`
      })
    } catch (error) {
      if (!current()) return
      if (/cancel/i.test(String(error && error.errMsg || ''))) return
      wx.showToast({ title: error.message || '二维码读取失败', icon: 'none' })
    }
  },
  cancelDesktopQrLogin() {
    this.pendingDesktopQrScene = ''
    this.setData({ desktopQrStatus: 'cancelled', desktopQrMessage: '已取消，这台电脑没有获得访问权限。' })
  },
  onShow() {
    const scope = cache.scopeToken()
    const previousScope = this.pageScope
    this.viewEpoch = (this.viewEpoch || 0) + 1
    if (previousScope !== undefined && previousScope !== scope) {
      this.pendingDesktopQrScene = ''
      this.desktopQrCompleting = false
      this.setData({ account: null, members: [], invite: null, bindCode: null, desktopQrStatus: '', desktopQrMessage: '' })
    }
    this.pageScope = scope
    this.setData({ homeTesting: false, homeRecovering: false, homeRecoveryMessage: '' })
    const current = api.homeConnection()
    this.applyHybridStatus({
      ...api.getHybridStatus(),
      serverBaseUrl: current.serverBaseUrl,
      token: current.token
    })
    const cached = cache.read(cache.KEYS.bootstrap, null)
    this.setData({ loading: false, onboardingRequired: Boolean(cached?.onboardingRequired), account: cached?.account || null })
  },
  onHide() { this.viewEpoch = (this.viewEpoch || 0) + 1 },
  onUnload() { this.onHide() },
  pageGuard() {
    const scope = cache.scopeToken(), epoch = this.viewEpoch || 0
    return () => { try { return scope === cache.scopeToken() && epoch === (this.viewEpoch || 0) } catch (_) { return false } }
  },
  applyHybridStatus(status = {}) {
    const homeConfigured = status.homeConfigured === true
    const recovery = api.previewHomeRecovery()
    this.setData({
      hybridMode: status.mode || 'local',
      hybridLabel: status.label || '电脑本地同步',
      serverBaseUrl: status.serverBaseUrl !== undefined ? status.serverBaseUrl : this.data.serverBaseUrl,
      homeToken: status.token !== undefined ? status.token : this.data.homeToken,
      homeConnected: status.homeReachable === true,
      homeConfigured,
      connectionDetailsOpen: homeConfigured ? this.data.connectionDetailsOpen : true,
      homeStatus: status.homeReachable === true
        ? '电脑连接可用，待传内容按各自结果确认'
        : status.homeConfigured
          ? '连接信息已保存，电脑离线时操作会留在手机'
          : '尚未连接电脑',
      pendingLocal: Number(status.pendingLocal || 0),
      pendingCloud: Number(status.pendingCloud || 0),
      homeRecoveryCount: recovery.items.length,
      homeUnscopedCount: recovery.unscoped
    })
  },
  async refresh() {
    const current = this.pageGuard()
    this.setData({ loading: true })
    try {
      const bootstrap = await api.bootstrap()
      if (!current()) return
      if (bootstrap.onboardingRequired) {
        this.setData({ loading: false, onboardingRequired: true, account: null, members: [] })
        return
      }
      const scope = cache.scopeToken()
      const memberData = api.getHybridStatus().mode === 'cloud'
        ? await api.call('workspace.members')
        : { members: [] }
      if (!current() || scope !== cache.scopeToken()) return
      this.setData({ loading: false, onboardingRequired: false, account: bootstrap.account, members: memberData.members || [] })
      this.applyHybridStatus(api.getHybridStatus())
    } catch (error) {
      if (!current()) return
      const cached = cache.read(cache.KEYS.bootstrap, null)
      this.setData({
        loading: false,
        onboardingRequired: cached ? Boolean(cached.onboardingRequired) : this.data.onboardingRequired,
        account: cached && cached.account || this.data.account
      })
      this.applyHybridStatus(api.getHybridStatus())
    }
  },
  onCodeInput(event) { this.setData({ code: event.detail.value.toUpperCase() }) },
  onNameInput(event) { this.setData({ displayName: event.detail.value }) },
  async join() {
    if (this.data.code.trim().length < 6 || this.data.joining) return
    const current = this.pageGuard()
    this.setData({ joining: true })
    try {
      await api.call('workspace.join', { code: this.data.code, displayName: this.data.displayName })
      if (!current()) return
      wx.showToast({ title: '已加入内测', icon: 'success' })
      await this.refresh()
    } catch (error) {
      if (current()) wx.showToast({ title: error.message || '邀请码无效', icon: 'none' })
    } finally { if (current()) this.setData({ joining: false }) }
  },
  async createInvite() {
    if (this.data.creatingInvite) return
    const current = this.pageGuard()
    this.setData({ creatingInvite: true })
    try {
      const invite = await api.call('workspace.inviteCreate', { role: 'member', validHours: 72, maxUses: 1 })
      if (!current()) return
      this.setData({ invite })
    } catch (error) {
      if (current()) wx.showToast({ title: error.message || '创建邀请码失败', icon: 'none' })
    } finally { if (current()) this.setData({ creatingInvite: false }) }
  },
  copyInvite() {
    if (this.data.invite && this.data.invite.code) wx.setClipboardData({ data: this.data.invite.code })
  },
  async switchWorkspace(event) {
    const workspaceId = event.currentTarget.dataset.id
    const current = this.pageGuard()
    try {
      await api.call('workspace.switch', { workspaceId })
      if (!current()) return
      await this.refresh()
      if (!current()) return
      wx.reLaunch({ url: '/pages/home/index' })
      wx.showToast({ title: '已切换', icon: 'success' })
    } catch (error) { if (current()) wx.showToast({ title: error.message || '切换失败', icon: 'none' }) }
  },
  async removeMember(event) {
    const userId = event.currentTarget.dataset.id
    const current = this.pageGuard()
    const allowed = await new Promise((resolve) => wx.showModal({
      title: '移出工作区', content: '该成员将不能继续读取或修改这个工作区。',
      confirmColor: '#b23a3a', success: ({ confirm }) => resolve(confirm)
    }))
    if (!allowed || !current()) return
    try {
      await api.call('workspace.memberRemove', { userId })
      if (!current()) return
      await this.refresh()
    } catch (error) { if (current()) wx.showToast({ title: error.message || '移除失败', icon: 'none' }) }
  },
  async createBindCode() {
    const current = this.pageGuard()
    try {
      const bindCode = await api.call('identity.createBindCode')
      if (!current()) return
      this.setData({ bindCode })
    } catch (error) { if (current()) wx.showToast({ title: error.message || '生成绑定码失败', icon: 'none' }) }
  },
  copyBindCommand() {
    const code = this.data.bindCode && this.data.bindCode.code
    if (!code) return
    wx.setClipboardData({ data: `绑定 ${code}` })
  },
  onHomeUrlInput(event) { this.setData({ serverBaseUrl: event.detail.value }) },
  onHomeTokenInput(event) { this.setData({ homeToken: event.detail.value }) },
  toggleConnectionDetails() {
    this.setData({ connectionDetailsOpen: !this.data.connectionDetailsOpen })
  },
  importHomeConnection() {
    const current = this.pageGuard()
    wx.getClipboardData({
      success: ({ data }) => {
        if (!current()) return
        const candidate = parseHomeConnectionText(data)
        if (!candidate.serverBaseUrl || !candidate.token) {
          wx.showToast({ title: '没有识别到完整连接信息', icon: 'none' })
          return
        }
        this.setData({
          serverBaseUrl: candidate.serverBaseUrl,
          homeToken: candidate.token
        }, () => { if (current()) this.saveHomeConnection() })
      },
      fail: () => { if (current()) wx.showToast({ title: '无法读取剪贴板', icon: 'none' }) }
    })
  },
  async saveHomeConnection() {
    if (this.data.homeTesting) return
    const candidate = {
      serverBaseUrl: String(this.data.serverBaseUrl || '').trim().replace(/\/$/, ''),
      token: String(this.data.homeToken || '').trim()
    }
    if (!/^https:\/\//i.test(candidate.serverBaseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(candidate.serverBaseUrl)) {
      return wx.showToast({ title: '请输入 HTTPS 地址', icon: 'none' })
    }
    if (candidate.token.length < 32) return wx.showToast({ title: '连接凭证不完整', icon: 'none' })
    return this.connectHome(candidate)
  },
  async testHomeConnection() {
    const current = api.homeConnection()
    if (!current.serverBaseUrl || !current.token || this.data.homeTesting) return
    return this.connectHome(current)
  },
  async connectHome(candidate) {
    const pageCurrent = this.pageGuard()
    let target = null, verified = false
    const current = () => pageCurrent() && (!verified || target === cache.currentHomeTarget())
    this.setData({ homeTesting: true, homeStatus: '正在连接并同步…' })
    try {
      await api.testHomeConnection(candidate)
      if (!pageCurrent()) return
      target = cache.currentHomeTarget(); verified = true
      this.applyHybridStatus({ ...api.getHybridStatus(), homeReachable: true })
      const app = getApp()
      const result = app?.requestSync ? await app.requestSync('account-connect') : await api.syncNow({ includeBootstrap: true })
      if (!current()) return
      await api.flushMirrorQueue()
      if (!current()) return
      const transport = api.getHybridStatus()
      this.applyHybridStatus(transport)
      const feedback = syncFeedback.fromCache(cache, transport, result)
      this.setData({ homeStatus: feedback.message })
      wx.showToast({ title: feedback.pending ? '仍有待传内容，请查看提示' : feedback.tone === 'error' ? '接收未完成，请查看提示' : '连接检查完成', icon: 'none' })
    } catch (error) {
      if (current()) this.setData({ homeStatus: error.message || '连接或同步未完成，原内容已保留' })
    } finally { if (pageCurrent()) this.setData({ homeTesting: false }) }
  },
  async recoverHomeTarget() {
    if (this.data.homeRecovering) return
    const current = this.pageGuard()
    this.setData({ homeRecovering: true, homeRecoveryMessage: '' })
    try {
      const review = api.previewHomeRecovery()
      if (!review.items.length) return
      const allowed = await new Promise((resolve) => wx.showModal({
        title: '确认待传目标',
        content: `将这 ${review.items.length} 条当前账号的旧待传操作改为发往 ${api.homeConnection().serverBaseUrl}。会先核验电脑是否登录同一账号。原文不变，确认后不会立即上传；归属不明的内容仍保留待恢复。`,
        confirmText: '核验并确认', success: result => resolve(result.confirm === true), fail: () => resolve(false)
      }))
      if (!allowed || !current()) return
      const result = await api.confirmHomeRecovery(review)
      if (!current() || review.target !== cache.currentHomeTarget()) return
      this.applyHybridStatus(api.getHybridStatus())
      this.setData({ homeRecoveryMessage: `已确认 ${result.rebound} 条待传目标。${result.skipped ? `${result.skipped} 条在确认期间发生变化，已保留待重新查看。` : ''}点击“立即同步”后再上传。` })
    } catch (error) {
      if (current()) this.setData({ homeRecoveryMessage: error.message || '目标确认未完成，旧内容仍保留在手机' })
    } finally { if (current()) this.setData({ homeRecovering: false }) }
  },
  async recoverCloud() {
    if (this.data.recoveringCloud) return
    const current = this.pageGuard()
    this.setData({ recoveringCloud: true })
    try {
      const result = await api.maybeRecoverCloud({ force: true })
      if (!current()) return
      this.applyHybridStatus(api.getHybridStatus())
      wx.showToast({ title: result.recovered ? '云端已恢复' : '云端额度仍不可用', icon: 'none' })
    } catch (error) {
      if (current()) wx.showToast({ title: error.message || '云端恢复未完成', icon: 'none' })
    } finally {
      if (current()) this.setData({ recoveringCloud: false })
    }
  },
  onOfficialAccountLoad() {
    this.setData({ officialAccountReady: true, officialAccountUnavailable: false })
  },
  onOfficialAccountError() {
    this.setData({ officialAccountReady: false, officialAccountUnavailable: true })
  }
})
