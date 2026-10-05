const config = require('./config/env')
const api = require('./utils/api')
const cache = require('./utils/cache')

const LEGACY_PAGE_REDIRECTS = {
  'pages/timeline/index': '/pages/home/index',
  'pages/records/index': '/pages/archive/index'
}

function canRetryReceive(error) {
  if (!error || error.retryable === false) return false
  const code = String(error.code || '')
  if (/UNAUTH|FORBIDDEN|PERMISSION|WORKSPACE|SCOPE|CONNECTION_CHANGED|HISTORY_|CURSOR|CAPACITY|STORAGE|VALIDATION|CONFLICT|PROTOCOL/.test(code)) return false
  if (/permission|denied|unauthor|权限|无权/i.test(error.message || error.errMsg || '')) return false
  return error.retryable === true || /NETWORK|OFFLINE|TIMEOUT/.test(code)
}

App({
  onLaunch() {
    if (config.cloudSyncEnabled === true && wx.cloud) {
      const options = { traceUser: true }
      if (config.envId) options.env = config.envId
      wx.cloud.init(options)
    }
  },
  onShow() {
    this.appVisible = true
    const scope = this.currentScopeToken()
    if (this.activeScope !== scope) {
      this.stopRealtimeSync()
      this.cancelReceiveRetry()
      this.receiveRetryCount = 0
      this.activeScope = scope
      this.startupSyncDone = false
      this.receiveAgain = ''
    }
    const cachedBootstrap = cache.read(cache.KEYS.bootstrap, null)
    if (!cachedBootstrap || !cachedBootstrap.account) return
    if (!this.startupSyncDone && this.syncPromise) {
      this.startupSyncDone = true
      this.foregroundSyncPending = true
      return this.requestForegroundSync()
    }
    if (this.startupSyncDone) return this.requestForegroundSync()
    this.startupSyncDone = true
    this.requestSync('app-start').catch(() => {})
  },
  onHide() {
    this.appVisible = false
    this.foregroundSyncPending = true
    this.stopRealtimeSync()
    this.cancelReceiveRetry()
    clearTimeout(this.receiveTimer)
    this.receiveTimer = null
    // WeChat may suspend the process shortly after it enters the background.
    // Only make a best-effort sync when this session has durable local changes;
    // an unfinished request stays in the queue for the next launch/manual sync.
    if (api.hasPendingQueue()) api.flushDirtyQueueNow({ reason: 'app-hide' }).catch(() => {})
  },
  requestForegroundSync() {
    if (!this.foregroundSyncPending || !this.appVisible) return null
    if (this.foregroundSyncPromise) return this.foregroundSyncPromise
    this.foregroundSyncPending = false
    const previousSync = this.syncPromise
      ? this.syncPromise.catch(() => {})
      : Promise.resolve()
    this.foregroundSyncPromise = previousSync
      .then(() => {
        // A foreground intent may have waited behind an older in-flight call.
        // Recheck now, before starting any cloud reads.
        if (!this.appVisible) { this.foregroundSyncPending = true; return null }
        this.foregroundSyncPending = false
        return this.requestSync('app-foreground')
      })
      .catch(() => {})
      .finally(() => { this.foregroundSyncPromise = null })
    return this.foregroundSyncPromise
  },
  onPageNotFound(event = {}) {
    const missingPath = String(event.path || '').replace(/^\/+/, '')
    const target = LEGACY_PAGE_REDIRECTS[missingPath] || '/pages/home/index'
    wx.reLaunch({ url: target })
  },
  subscribeSync(listener) {
    this.syncListeners.add(listener)
    return () => this.syncListeners.delete(listener)
  },
  notifySyncListeners(event) {
    const scope = this.currentScopeToken()
    if (event && event.type === 'sync-cycle' && this.appVisible && api.organizePendingDiaries) {
      // Upload receipts and receive completion are the triggers. No idle timer.
      api.organizePendingDiaries().catch(() => {})
      if (api.organizePendingJournals) api.organizePendingJournals().catch(() => {})
    }
    clearTimeout(this.syncNotifyTimer)
    this.syncNotifyTimer = setTimeout(() => {
      if (scope !== this.currentScopeToken()) return
      this.syncListeners.forEach((listener) => {
        try { listener(event) } catch (_) {}
      })
    }, 250)
  },
  rememberLocalSyncRevision(revision) {
    if (!revision) return
    this.localSyncRevisions.add(revision)
    setTimeout(() => this.localSyncRevisions.delete(revision), 10 * 1000)
  },
  requestSync(reason = 'manual') {
    const scope = this.currentScopeToken()
    if (this.syncPromise) {
      if (this.syncPromiseScope === scope) return this.syncPromise
      return this.syncPromise.catch(() => {}).then(() => this.requestSync(reason))
    }
    this.cancelReceiveRetry()
    this.syncPromiseScope = scope
    let continuation = false
    this.syncPromise = api.syncNow({ includeBootstrap: true, shouldContinue: () => this.appVisible && scope === this.currentScopeToken() })
      .then((result) => {
        const scopedResult = { ...result, scopeToken: scope }
        if (scope !== this.currentScopeToken()) return scopedResult
        if (result.remoteFresh) this.globalData.lastSyncAt = new Date().toISOString()
        const receiveFailure = result.receiveError || result.history?.error
        if (receiveFailure) this.scheduleReceiveRetry(receiveFailure)
        else if (result.remoteFresh) { this.receiveRetryCount = 0; this.globalData.receiveError = '' }
        continuation = Boolean(result.history && result.history.pending && !result.history.error)
        this.notifySyncListeners({ type: 'sync-cycle', reason, result: scopedResult })
        return scopedResult
      })
      .catch((error) => {
        if (scope === this.currentScopeToken()) {
          this.scheduleReceiveRetry(error)
          this.notifySyncListeners({ type: 'sync-error', reason, error })
        }
        throw error
      })
      .finally(() => {
        this.syncPromise = null
        if (scope !== this.currentScopeToken()) return
        const nextReason = this.receiveAgain || (continuation ? 'history-continue' : '')
        this.receiveAgain = ''
        if (nextReason) this.scheduleReceive(nextReason)
      })
    return this.syncPromise
  },
  startRealtimeSync(channelId, workspaceId) {
    if (!channelId || !workspaceId) return
    const scope = this.currentScopeToken()
    const current = cache.currentScope ? cache.currentScope() : null
    if (current && current.workspaceId !== workspaceId) return
    if ((this.syncWatcher || this.syncRetryTimer) && this.syncChannel === channelId && this.watchScope === scope) return
    this.stopRealtimeSync()
    this.syncChannel = channelId
    this.syncWorkspaceId = workspaceId
    this.watchScope = scope
    this.globalData.realtimeConnected = false
    // Only the committed sequence channel is enabled for receiving. Old cloud
    // versions continue lifecycle/manual sync while a compatible rollout runs.
    if (!this.appVisible || !channelId.startsWith('sync_head_') || config.cloudSyncEnabled !== true || !wx.cloud || !wx.cloud.database) return
    const generation = this.watchGeneration
    let failedWatch = false
    const currentWatch = () => this.appVisible && generation === this.watchGeneration && scope === this.currentScopeToken()
    const failed = (error) => {
      if (!currentWatch() || failedWatch) return
      failedWatch = true
      this.globalData.realtimeConnected = false
      this.closeSyncWatcher()
      this.globalData.receiveError = String(error && error.message || error && error.errMsg || '实时连接中断')
      if (/permission|denied|unauthor|权限|无权/i.test(this.globalData.receiveError)) return
      const delay = Math.min(60000, 2000 * 2 ** Math.min(this.syncRetryCount++, 5))
      this.syncRetryTimer = setTimeout(() => {
        this.syncRetryTimer = null
        if (currentWatch()) this.startRealtimeSync(channelId, workspaceId)
      }, delay)
    }
    try {
      const watcher = wx.cloud.database().collection('sync_signals').where({ _id: channelId, workspaceId }).watch({
        onChange: (snapshot) => {
          if (!currentWatch() || failedWatch) return
          this.globalData.realtimeConnected = true
          this.globalData.receiveError = ''
          this.syncRetryCount = 0
          const sequence = Number(snapshot && snapshot.docs && snapshot.docs[0] && snapshot.docs[0].sequence || 0)
          const progress = cache.read(cache.KEYS.historyTransfer, {}) || {}
          if (progress.protocol !== 2 || progress.phase !== 'idle' || sequence > Number(progress.sequence || 0)) this.scheduleReceive('cloud-change')
        },
        onError: failed
      })
      // SDK callbacks may report a startup failure before watch() returns.
      // Do not retain that dead watcher or accept later events from it.
      if (failedWatch || !currentWatch()) {
        try { Promise.resolve(watcher.close()).catch(() => {}) } catch (_) {}
      } else this.syncWatcher = watcher
    } catch (error) { failed(error) }
  },
  currentScopeToken() {
    return cache.scopeToken ? cache.scopeToken() : ''
  },
  onScopeChanged() {
    this.stopRealtimeSync()
    this.cancelReceiveRetry()
    this.receiveRetryCount = 0
    clearTimeout(this.receiveTimer)
    this.receiveTimer = null
    this.receiveAgain = ''
    this.activeScope = this.currentScopeToken()
    this.syncRetryCount = 0
    this.startupSyncDone = false
    this.foregroundSyncPending = true
    const bootstrap = cache.read(cache.KEYS.bootstrap, null)
    if (this.appVisible && bootstrap && bootstrap.account) this.requestForegroundSync().catch(() => {})
  },
  scheduleReceive(reason) {
    if (!this.appVisible) { this.foregroundSyncPending = true; return }
    if (this.syncPromise) { this.receiveAgain = reason; return }
    if (this.receiveTimer) return
    const scope = this.currentScopeToken()
    this.receiveTimer = setTimeout(() => {
      this.receiveTimer = null
      if (this.appVisible && scope === this.currentScopeToken()) this.requestSync(reason).catch(() => {})
    }, 200)
  },
  cancelReceiveRetry() {
    clearTimeout(this.receiveRetryTimer)
    this.receiveRetryTimer = null
  },
  scheduleReceiveRetry(error) {
    this.globalData.receiveError = String(error?.message || error?.code || '接收尚未完成')
    if (!this.appVisible || !canRetryReceive(error) || this.receiveRetryTimer) return
    const scope = this.currentScopeToken()
    const target = cache.attachmentConnectionId ? cache.attachmentConnectionId() : ''
    const delay = Math.min(60000, 2000 * 2 ** Math.min(this.receiveRetryCount++, 5))
    this.receiveRetryTimer = setTimeout(() => {
      this.receiveRetryTimer = null
      try {
        if (this.appVisible && scope === this.currentScopeToken() && target === (cache.attachmentConnectionId ? cache.attachmentConnectionId() : '')) {
          this.requestSync('receive-retry').catch(() => {})
        }
      } catch (failure) { this.globalData.receiveError = failure.message || '本机同步进度无法读取，请检查存储空间' }
    }, delay)
  },
  closeSyncWatcher() {
    const watcher = this.syncWatcher
    this.syncWatcher = null
    if (watcher) {
      try { Promise.resolve(watcher.close()).catch(() => {}) } catch (_) {}
    }
  },
  stopRealtimeSync() {
    if (this.syncRetryTimer) clearTimeout(this.syncRetryTimer)
    this.syncRetryTimer = null
    this.watchGeneration++
    this.closeSyncWatcher()
    this.stopHomeRealtimeSync()
    this.globalData.realtimeConnected = false
  },
  startHomeRealtimeSync(options = {}) {
    if (!this.appVisible || !api.watchHomeChanges) return
    const scope = this.currentScopeToken()
    const target = cache.attachmentConnectionId ? cache.attachmentConnectionId() : ''
    if (this.homeWatcher && !this.homeWatcher.closed && this.homeWatchScope === scope && this.homeWatchTarget === target) return
    this.stopRealtimeSync()
    this.homeWatchScope = scope
    this.homeWatchTarget = target
    const generation = this.watchGeneration
    const homeGeneration = this.homeWatchGeneration
    const currentWatch = () => this.appVisible && generation === this.watchGeneration && homeGeneration === this.homeWatchGeneration && scope === this.currentScopeToken() &&
      target === (cache.attachmentConnectionId ? cache.attachmentConnectionId() : '')
    this.globalData.realtimeConnected = false
    let stopped = false
    const watcher = api.watchHomeChanges(() => {
      if (currentWatch() && !stopped) this.scheduleReceive('home-change')
    }, (connected, error) => {
      if (!currentWatch() || stopped) return
      this.globalData.realtimeConnected = connected
      this.globalData.receiveError = connected ? '' : String(error?.message || '电脑变更通知已断开')
      if (!connected && error?.retryable === false) stopped = true
    }, { socket: true, revision: options.revision })
    if (!currentWatch() || stopped || watcher.closed) {
      try { watcher.close() } catch (_) {}
    } else this.homeWatcher = watcher
  },
  stopHomeRealtimeSync() {
    const hadHomeWatcher = Boolean(this.homeWatcher)
    this.homeWatchGeneration++
    if (this.homeRetryTimer) clearTimeout(this.homeRetryTimer)
    this.homeRetryTimer = null
    if (this.homeWatcher) { try { this.homeWatcher.close() } catch (_) {} }
    this.homeWatcher = null
    this.homeWatchScope = ''
    this.homeWatchTarget = ''
    if (hadHomeWatcher || config.cloudSyncEnabled !== true) this.globalData.realtimeConnected = false
  },
  syncListeners: new Set(),
  syncWatcher: null,
  syncChannel: '',
  syncWorkspaceId: '',
  syncRetryTimer: null,
  syncRetryCount: 0,
  watchGeneration: 0,
  watchScope: '',
  activeScope: '',
  receiveTimer: null,
  receiveRetryTimer: null,
  receiveRetryCount: 0,
  receiveAgain: '',
  syncSignalTimer: null,
  syncNotifyTimer: null,
  syncPromise: null,
  foregroundSyncPromise: null,
  foregroundSyncPending: false,
  startupSyncDone: false,
  homeWatcher: null,
  homeWatchGeneration: 0,
  homeWatchScope: '',
  homeWatchTarget: '',
  homeRetryTimer: null,
  appVisible: false,
  lastSyncRevision: '',
  localSyncRevisions: new Set(),
  globalData: {
    productName: '主线笔记',
    clientVersion: config.clientVersion,
    realtimeConnected: false,
    lastSyncAt: ''
  }
})
