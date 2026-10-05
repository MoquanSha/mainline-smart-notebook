const api = require('../../utils/api')
const cache = require('../../utils/cache')
const syncFeedback = require('../../utils/sync-feedback')
const localTodoState = require('../../utils/local-todo-state')
const completionCalendar = require('./completion-calendar')
const presentation = require('./presentation')
const {
  pinTier,
  sortTodayTodos,
  nextSortRank,
  applyOrderedIds,
  samePinTier
} = require('../../utils/sync-policy')

const MAX_IMAGES = 6
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const COMPRESS_ABOVE_BYTES = 3 * 1024 * 1024
const DEVICE_STATUS_CACHE_MS = 5 * 60 * 1000

function shanghaiDateKey(value = Date.now()) {
  const date = new Date(Number(value) + 8 * 60 * 60 * 1000)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

function shortDate(value = '') {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value))
  return match ? `${Number(match[2])}月${Number(match[3])}日` : ''
}

function instantDate(value = '') {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? shanghaiDateKey(timestamp) : ''
}

function proposedDateFor(todo = {}) {
  const dates = []
  const addDate = (value = '') => {
    const text = String(value || '')
    const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : instantDate(text)
    if (date) dates.push(date)
  }
  addDate(todo.originDate)
  addDate(todo.proposedAt)
  addDate(todo.createdAt)
  addDate(todo.date)
  const rationaleMatch = String(todo.planRationale || '').match(/\d{4}-\d{2}-\d{2}/)
  addDate(rationaleMatch ? rationaleMatch[0] : '')
  return dates.sort()[0] || ''
}

function present(todo, readonly = false) {
  const proposedDate = proposedDateFor(todo)
  const completedDate = instantDate(todo.completedAt)
  const comments = presentation.presentComments(todo.comments)
  return {
    ...todo,
    meta: '今日',
    priorityLabel: todo.priority === 'high' ? '优先处理' : '',
    carriedLabel: todo.source === 'carry_over' ? '从昨天顺延' : '',
    hasDetail: Boolean(todo.description && todo.description !== todo.title),
    comments,
    photoAttachments: presentation.collectPhotoAttachments(comments),
    commentCount: comments.length,
    commentLabel: comments.length ? `笔记 · ${comments.length}` : '笔记',
    scheduledLabel: todo.date > shanghaiDateKey() ? shortDate(todo.date) : '',
    completedDate,
    dateMeta: [proposedDate ? `提出 ${shortDate(proposedDate)}` : '', completedDate ? `完成 ${shortDate(completedDate)}` : ''].filter(Boolean).join(' · '),
    readonly
  }
}

function presentBundle(data = {}) {
  const all = sortTodayTodos(data.todos || []).map((todo) => present(todo))
  const completionHistory = (Array.isArray(data.completedHistory) ? data.completedHistory : all.filter((item) => item.status === 'done'))
    .map((todo) => present(todo, true))
    .sort((left, right) => String(right.completedAt || '').localeCompare(String(left.completedAt || '')))
  return {
    todos: all.filter((item) => item.status === 'planned'),
    completed: all.filter((item) => item.status === 'done'),
    scheduled: (data.scheduled || []).map((todo) => present(todo, true))
      .sort((left, right) => String(left.date || '').localeCompare(String(right.date || '')) || String(right.createdAt || '').localeCompare(String(left.createdAt || ''))),
    completionHistory,
    history: (data.history || []).map((group) => ({
      ...group,
      todos: (group.todos || []).map((todo) => present(todo, true))
    }))
  }
}

function imageType(path = '') {
  const extension = path.split('.').pop().toLowerCase()
  if (extension === 'png') return { extension: 'png', mimeType: 'image/png' }
  if (extension === 'webp') return { extension: 'webp', mimeType: 'image/webp' }
  return { extension: 'jpg', mimeType: 'image/jpeg' }
}

function randomId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

function syncTimeLabel(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function todoStateFromRows(rows = []) {
  const all = sortTodayTodos(rows).map((todo) => present(todo))
  return {
    todos: all.filter((item) => item.status === 'planned'),
    completed: all.filter((item) => item.status === 'done')
  }
}

function mergeTodoRows(incomingRows = [], currentRows = []) {
  const merged = new Map((incomingRows || []).filter((row) => row && row.id).map((row) => [row.id, row]))
  for (const current of currentRows || []) {
    if (!current || !current.id) continue
    const incoming = merged.get(current.id)
    if (!incoming || current.pending || Number(current.version || 0) > Number(incoming.version || 0)) merged.set(current.id, current)
  }
  return [...merged.values()]
}

Page({
  data: {
    loading: true,
    offline: false,
    draft: '',
    saving: false,
    todos: [],
    completed: [],
    scheduled: [],
    history: [],
    todayDate: shanghaiDateKey(),
    targetDate: shanghaiDateKey(),
    completedQueryDate: '',
    completedResults: [],
    completionHistory: [],
    completionDates: [],
    completionMonth: shanghaiDateKey().slice(0, 7),
    completionMonthLabel: '',
    completionCalendar: [],
    completionWeekdays: ['一', '二', '三', '四', '五', '六', '日'],
    completionCanPrevious: false,
    completionCanNext: false,
    completionCalendarOpen: false,
    completedLoading: false,
    showCompleted: false,
    showHistory: false,
    openComments: {},
    openCompletionNotes: {},
    openHistoryNotes: {},
    commentDrafts: {},
    commentImages: {},
    commentSubmissions: {},
    photoScope: '',
    commentSaving: {},
    draggingTodoId: '',
    dragTargetTodoId: '',
    pendingCount: 0,
    storagePrefix: '',
    onboardingRequired: false,
    account: null,
    activeWorkspace: null,
    syncMessage: '正在连接云端',
    syncTone: 'idle',
    openingAssistant: false,
    syncingComputer: false,
    computerConnected: false,
    lastComputerSyncAt: ''
  },
  onLoad() {
    this.unloaded = false
    this.pageScope = this.currentScope()
    const app = getApp()
    this.unsubscribeSync = app.subscribeSync((event) => this.handleRealtimeSync(event))

    // Never leave the first screen dependent on an in-flight cloud request.
    // App.onShow may have started the initial sync before this page subscribes;
    // render the durable cache (or an editable empty page) immediately, then
    // join that same request instead of creating a second snapshot read.
    const cached = cache.read(cache.KEYS.todayTodos, null)
    if (cached && !Array.isArray(cached)) this.apply(cached, false)
    else {
      this.apply({ todos: [], history: [] }, true)
      this.setSyncStatus('已打开手机内容 · 后台检查同步', 'syncing')
    }
    if (app.syncPromise && typeof app.syncPromise.then === 'function') {
      const scope = this.currentScope()
      app.syncPromise.then((result) => {
        if (this.requestIsCurrent(scope, result)) this.applySyncResult(result)
      }).catch((error) => {
        if (!this.requestIsCurrent(scope)) return
        this.setData({ loading: false })
        this.renderSyncFeedback(null, error)
      })
    } else if (!cached || Array.isArray(cached)) {
      this.refresh({ silent: true })
    }
  },
  onUnload() {
    this.unloaded = true
    if (this.unsubscribeSync) this.unsubscribeSync()
    if (this.syncStatusTimer) clearTimeout(this.syncStatusTimer)
  },
  onShow() {
    const scope = this.currentScope()
    if (this.pageScope !== undefined && this.pageScope !== scope) {
      this.lastSyncResult = null
      this.lastSyncError = null
      this._pendingCloudReceivedAt = ''
      this._todoDrag = null
      this._choosingImages = false
      this.setData({ draft: '', todos: [], completed: [], scheduled: [], history: [], completionHistory: [],
        completedResults: [], commentDrafts: {}, commentImages: {}, commentSubmissions: {}, commentSaving: {}, openComments: {},
        account: null, activeWorkspace: null, saving: false, syncingComputer: false, computerConnected: false })
    }
    this.pageScope = scope
    this.setData({ photoScope: scope })
    const draft = cache.read(cache.KEYS.homeDraftState, {})
    this.draftRevision = Number(draft.revision || 0)
    this.commentRevisions = draft.commentRevisions || {}
    this.setData({ draft: draft.content || '', commentDrafts: draft.comments || {},
      commentImages: draft.images || {}, commentSubmissions: draft.submissions || {} })
    const cached = cache.read(cache.KEYS.todayTodos, null)
    if (cached && !Array.isArray(cached)) this.apply(cached, false)
    this.renderSyncFeedback()
  },
  currentScope() { return cache.scopeToken ? cache.scopeToken() : '' },
  requestIsCurrent(scope, result) {
    return !this.unloaded && scope === this.currentScope() && (!result?.scopeToken || result.scopeToken === scope)
  },
  renderSyncFeedback(result, error) {
    if (result !== undefined) this.lastSyncResult = result
    if (error !== undefined || result !== undefined) this.lastSyncError = error || null
    const status = syncFeedback.fromCache(cache, api.getHybridStatus(), this.lastSyncResult, this.lastSyncError)
    this.setData({ offline: status.offline })
    this.setSyncStatus(status.message, status.tone)
  },
  apply(data, offline) {
    const transport = api.getHybridStatus()
    const messages = {
      cloud: '云端数据已加载 · 手机可独立使用',
      home: '云端额度不足 · 已由家庭服务器接管',
      local: '已保存在手机 · 等待家庭服务器上线',
      recovering: '正在恢复云端并合并操作'
    }
    const source = Array.isArray(data.completedHistory)
      ? data
      : { ...data, completedHistory: this.data.completionHistory.length ? this.data.completionHistory : undefined }
    const bundle = presentBundle(source)
    const completionView = completionCalendar.buildCompletionView(
      bundle.completionHistory,
      this.data.completedQueryDate,
      this.data.completionMonth,
      shanghaiDateKey()
    )
    this.setData({
      ...bundle,
      ...completionView,
      loading: false,
      offline,
      syncMessage: offline ? (messages[transport.mode] || '正在使用手机缓存') : messages[transport.mode],
      syncTone: transport.mode === 'local' || offline ? 'offline' : transport.mode === 'home' ? 'syncing' : 'ok'
    })
  },
  setSyncStatus(message, tone = 'syncing') {
    this.setData({ syncMessage: message, syncTone: tone })
  },
  markPhoneSaved(detail = '') {
    this.setSyncStatus(`已保存在手机${detail ? ` · ${detail}` : ''}`, 'syncing')
  },
  markCloudReceived(data = {}) {
    const receipt = data.syncReceipt || {}
    this._pendingCloudReceivedAt = receipt.cloudReceivedAt || new Date().toISOString()
    const transport = api.getHybridStatus()
    this.setData({ offline: transport.mode === 'local' })
    if (transport.mode === 'home') this.setSyncStatus('已保存到家庭服务器 · 待额度恢复后回灌云端', 'syncing')
    else if (transport.mode === 'local') this.setSyncStatus('已保存在手机 · 等待家庭服务器上线', 'offline')
    else this.setSyncStatus('已保存到云端 · 手机可直接使用', 'ok')
  },
  reconcileTodos(rows, scheduled = this.data.scheduled) {
    if (!Array.isArray(rows)) return
    const visible = todoStateFromRows(rows)
    const scheduledRows = (scheduled || []).map((todo) => present(todo, true))
      .sort((left, right) => String(left.date || '').localeCompare(String(right.date || '')) || String(right.createdAt || '').localeCompare(String(left.createdAt || '')))
    this.setData({
      ...visible,
      scheduled: scheduledRows,
      ...completionCalendar.buildCompletionView(
        this.data.completionHistory,
        this.data.completedQueryDate,
        this.data.completionMonth,
        this.data.todayDate
      )
    })
    const cached = cache.read(cache.KEYS.todayTodos, {})
    cache.write(cache.KEYS.todayTodos, { ...cached, todos: rows, scheduled })
  },
  persistVisibleTodos(todos = this.data.todos, completed = this.data.completed, scheduled = this.data.scheduled, completionHistory = this.data.completionHistory) {
    const merged = localTodoState.mergeVisibleState(cache.read(cache.KEYS.todayTodos, {}), todos, completed)
    cache.write(
      cache.KEYS.todayTodos,
      { ...merged, scheduled, completedHistory: completionHistory }
    )
  },
  applyBootstrap(bootstrap = {}) {
    this.setData({
      pendingCount: bootstrap.counts && bootstrap.counts.proposals || 0,
      storagePrefix: bootstrap.storagePrefix || this.data.storagePrefix || '',
      onboardingRequired: false,
      account: bootstrap.account || this.data.account || null,
      activeWorkspace: bootstrap.account && (
        (bootstrap.account.workspaces || []).find((workspace) => workspace.active)
        || (bootstrap.account.workspaces || [])[0]
        || null
      ) || this.data.activeWorkspace || null
    })
  },
  applySyncResult(result) {
    if (!result || !this.requestIsCurrent(this.currentScope(), result)) return
    const bootstrap = result.bootstrap || cache.read(cache.KEYS.bootstrap, {})
    if (bootstrap.onboardingRequired) {
      this.setData({ loading: false, offline: false, onboardingRequired: true, account: null })
      return
    }
    if (result.data) this.apply(result.data, false)
    this.applyBootstrap(bootstrap)
    this.renderSyncFeedback(result)
  },
  async handleRealtimeSync(event = {}) {
    if (event.type === 'sync-cycle' && event.result) this.applySyncResult(event.result)
    else if (event.type === 'sync-error') {
      this.renderSyncFeedback(null, event.error || new Error('云端接收尚未完成'))
    }
    else if (event.type === 'transport-state') {
      this.renderSyncFeedback()
    }
  },
  async refresh(options = {}) {
    const scope = this.currentScope()
    const cached = cache.read(cache.KEYS.todayTodos, null)
    const hasVisibleData = this.data.todos.length || this.data.completed.length || this.data.history.length
    if (!options.silent && !hasVisibleData) {
      const immediate = cached && !Array.isArray(cached) ? cached : { todos: [], history: [] }
      this.apply(immediate, true)
      this.setSyncStatus('已打开手机内容 · 后台检查同步', 'syncing')
    }
    try {
      const result = await getApp().requestSync(options.silent ? 'home-silent-refresh' : 'home-refresh')
      if (!this.requestIsCurrent(scope, result)) return
      this.applySyncResult(result)
    } catch (error) {
      if (!this.requestIsCurrent(scope)) return
      this.setData({ loading: false })
      this.renderSyncFeedback(null, error)
    }
  },
  async refreshDeviceStatus(options = {}) {
    const scope = this.currentScope()
    try {
      const cachedAt = Number(cache.read(cache.KEYS.deviceStatusAt, 0))
      let status = !options.force && cachedAt && Date.now() - cachedAt < DEVICE_STATUS_CACHE_MS
        ? cache.read(cache.KEYS.deviceStatus, null)
        : null
      if (!status) {
        if (!this.deviceStatusPromise || this.deviceStatusPromiseScope !== scope) {
          const promise = Promise.resolve(cache.read(cache.KEYS.deviceStatus, null))
            .then((nextStatus) => {
              if (!this.requestIsCurrent(scope)) return null
              cache.write(cache.KEYS.deviceStatus, nextStatus)
              cache.write(cache.KEYS.deviceStatusAt, Date.now())
              return nextStatus
            })
            .finally(() => {
              if (this.deviceStatusPromise === promise) {
                this.deviceStatusPromise = null
                this.deviceStatusPromiseScope = ''
              }
            })
          this.deviceStatusPromise = promise
          this.deviceStatusPromiseScope = scope
        }
        status = await this.deviceStatusPromise
      }
      if (!this.requestIsCurrent(scope) || !status) return null
      const lastSyncAt = status.lastSyncAt || ''
      const waiting = status.lastSyncStatus === 'waiting'
      const connected = Boolean(status.connected)
      const paired = Boolean(status.paired || status.deviceCount)
      const desktopAppliedAt = status.desktopAppliedAt || ''
      const pendingAt = this._pendingCloudReceivedAt || ''
      const pendingApplied = Boolean(pendingAt && desktopAppliedAt && Date.parse(desktopAppliedAt) >= Date.parse(pendingAt))
      this.setData({
        computerConnected: connected,
        syncingComputer: waiting,
        lastComputerSyncAt: lastSyncAt
      })
      if (pendingApplied) {
        this._pendingCloudReceivedAt = ''
        this.setSyncStatus(`已保存到云端 · 电脑已补齐 · ${syncTimeLabel(desktopAppliedAt)}`, 'ok')
      } else if (pendingAt && connected) this.setSyncStatus('已保存到云端 · 电脑正在补齐', 'ok')
      else if (pendingAt && paired) this.setSyncStatus('已保存到云端 · 电脑下次上线自动补齐', 'ok')
      else if (pendingAt) this.setSyncStatus('已保存到云端 · 手机可直接使用', 'ok')
      else if (waiting && connected) this.setSyncStatus('云端数据可用 · 电脑正在补齐', 'ok')
      else if (connected && status.lastSyncStatus === 'applied') this.setSyncStatus(`云端数据可用 · 电脑已同步 · ${syncTimeLabel(desktopAppliedAt || lastSyncAt)}`, 'ok')
      else if (connected) this.setSyncStatus('云端数据可用 · 电脑在线', 'ok')
      else if (paired) this.setSyncStatus('云端数据可用 · 电脑下次上线自动补齐', 'ok')
      else this.setSyncStatus('云端数据可用 · 手机可独立使用', 'ok')
      return status
    } catch (_) {
      return null
    }
  },
  scheduleDeviceStatusCheck(delay = 1200, attempt = 0) {
    if (this.syncStatusTimer) clearTimeout(this.syncStatusTimer)
    const scope = this.currentScope()
    this.syncStatusTimer = setTimeout(async () => {
      if (!this.requestIsCurrent(scope)) return
      const status = await this.refreshDeviceStatus({ force: true })
      if (!this.requestIsCurrent(scope)) return
      if (status && status.connected && ['waiting', 'cloud_received'].includes(status.lastSyncStatus) && attempt < 2) this.scheduleDeviceStatusCheck(2200, attempt + 1)
      else this.setData({ syncingComputer: false })
    }, delay)
  },
  saveDraft(patch = {}) {
    cache.write(cache.KEYS.homeDraftState, { content: this.data.draft, comments: this.data.commentDrafts,
      images: this.data.commentImages, submissions: this.data.commentSubmissions,
      commentRevisions: this.commentRevisions || {}, revision: this.draftRevision || 0, ...patch })
  },
  onInput(event) {
    this.draftRevision = Number(this.draftRevision || 0) + 1
    this.setData({ draft: event.detail.value })
    try { this.saveDraft() } catch (error) { this.renderSyncFeedback(null, error) }
  },
  onTargetDateChange(event) { this.setData({ targetDate: event.detail.value || this.data.todayDate }) },
  async addTodo() {
    const scope = this.currentScope()
    const submittedText = this.data.draft
    const revision = this.draftRevision || 0
    const content = this.data.draft.trim()
    if (!content || this.data.saving) return
    const parts = api.splitTodayTodoInput(content)
    if (!parts.length) {
      this.setSyncStatus('待办内容太短，请写得更具体一些', 'error')
      return
    }
    const targetDate = this.data.targetDate || this.data.todayDate
    const payload = api.prepareTodayTodoPayload(content, targetDate)
    const nextRank = nextSortRank([...this.data.todos, ...this.data.completed])
    const optimisticRows = parts.map((item, index) => present({
      id: payload.clientItems[index].id,
      entryKind: 'today_todo', date: targetDate, title: item.title, rawInput: item.raw,
      description: item.raw === item.title ? '' : item.raw.slice(0, 500), source: targetDate > this.data.todayDate ? 'scheduled' : 'manual', priority: 'normal',
      status: 'planned', pinned: false, comments: [], version: 1, pending: true,
      sortRank: nextRank - index,
      proposedAt: new Date().toISOString(), createdAt: new Date().toISOString()
    }))
    const snapshot = { todos: this.data.todos, completed: this.data.completed, scheduled: this.data.scheduled }
    const scheduled = targetDate > this.data.todayDate
      ? [...optimisticRows, ...this.data.scheduled].sort((left, right) => String(left.date || '').localeCompare(String(right.date || '')))
      : this.data.scheduled
    const nextTodos = targetDate > this.data.todayDate ? this.data.todos : sortTodayTodos([...optimisticRows, ...this.data.todos])
    this.setData({ saving: true, todos: nextTodos, scheduled })
    this.setSyncStatus('正在保存待办', 'syncing')
    try {
      this.saveDraft()
      const data = await api.call('todayTodo.add', payload, { queueOnFailure: true })
      if (!this.requestIsCurrent(scope)) return
      if (data.queued) {
        const currentRows = [...this.data.todos, ...this.data.completed]
        const queuedRows = mergeTodoRows(data.todos || nextTodos, currentRows)
        this.reconcileTodos(queuedRows, this.data.scheduled.length ? this.data.scheduled : (data.scheduled || scheduled))
        this.setData({ offline: false })
        this.setSyncStatus('已保存在手机 · 正在安全同步', 'syncing')
      }
      else {
        const currentRows = [...this.data.todos, ...this.data.completed]
        this.reconcileTodos(mergeTodoRows(data.todos || [], currentRows), data.scheduled || this.data.scheduled || scheduled)
        this.markCloudReceived(data)
      }
      if ((this.draftRevision || 0) === revision && this.data.draft === submittedText) {
        cache.write(cache.KEYS.homeDraftState, { content: '', comments: this.data.commentDrafts, revision: revision + 1 })
        this.draftRevision = revision + 1
        this.setData({ draft: '' })
      }
    } catch (error) {
      if (!this.requestIsCurrent(scope)) return
      this.setData(snapshot)
      this.renderSyncFeedback(null, error)
    } finally {
      if (this.requestIsCurrent(scope)) this.setData({ saving: false })
    }
  },
  async mutate(event) {
    const scope = this.currentScope()
    const { id, action, version } = event.currentTarget.dataset
    const target = this.data.todos.find((todo) => todo.id === id)
    if (!target) return
    const snapshot = { todos: this.data.todos, completed: this.data.completed, completionHistory: this.data.completionHistory }
    const nextTodos = this.data.todos.filter((todo) => todo.id !== id)
    const completedTarget = action === 'complete'
      ? present({ ...target, status: 'done', pinned: false, priorityPinned: false, pinnedAt: '', completedAt: new Date().toISOString() })
      : null
    const nextCompleted = action === 'complete'
      ? sortTodayTodos([completedTarget, ...this.data.completed])
      : this.data.completed
    const nextCompletionHistory = completedTarget
      ? [completedTarget, ...this.data.completionHistory.filter((todo) => todo.id !== id)]
      : this.data.completionHistory
    const completionView = completionCalendar.buildCompletionView(nextCompletionHistory, this.data.completedQueryDate, this.data.completionMonth, this.data.todayDate)
    this.setData({ todos: nextTodos, completed: nextCompleted, ...completionView })
    this.persistVisibleTodos(nextTodos, nextCompleted, this.data.scheduled, nextCompletionHistory)
    const labels = { complete: '已完成，正在后台保存', defer: '已顺延到明天，正在后台保存', delete: '已移出今天，正在后台保存' }
    this.markPhoneSaved(labels[action].replace('，正在后台保存', ''))
    try {
      const data = await api.mutateTodayTodo(`todayTodo.${action}`, { todoId: id, baseVersion: version }, { queueOnFailure: true })
      if (!this.requestIsCurrent(scope)) return
      if (data.queued) {
        this.setData({ offline: false })
        this.setSyncStatus('已保存在手机 · 正在安全同步', 'syncing')
      } else {
        this.reconcileTodos(data.todos)
        this.markCloudReceived(data)
      }
    } catch (error) {
      if (!this.requestIsCurrent(scope)) return
      this.setData({ ...snapshot, ...completionCalendar.buildCompletionView(snapshot.completionHistory, this.data.completedQueryDate, this.data.completionMonth, this.data.todayDate) })
      this.persistVisibleTodos(snapshot.todos, snapshot.completed, this.data.scheduled, snapshot.completionHistory)
      this.setSyncStatus(error.message || '保存失败，已恢复原状态', 'error')
    }
  },
  async reopenTodo(event) {
    const scope = this.currentScope()
    const { id, version } = event.currentTarget.dataset
    const target = this.data.completed.find((todo) => todo.id === id)
    if (!target) return
    const snapshot = { todos: this.data.todos, completed: this.data.completed, completionHistory: this.data.completionHistory }
    const nextCompleted = this.data.completed.filter((todo) => todo.id !== id)
    const nextTodos = sortTodayTodos([{ ...target, status: 'planned', completedAt: '', sortRank: nextSortRank(this.data.todos) }, ...this.data.todos])
    const nextCompletionHistory = this.data.completionHistory.filter((todo) => todo.id !== id)
    const completionView = completionCalendar.buildCompletionView(nextCompletionHistory, this.data.completedQueryDate, this.data.completionMonth, this.data.todayDate)
    this.setData({ todos: nextTodos, completed: nextCompleted, ...completionView })
    this.persistVisibleTodos(nextTodos, nextCompleted, this.data.scheduled, nextCompletionHistory)
    this.markPhoneSaved('已撤回完成')
    try {
      const data = await api.mutateTodayTodo('todayTodo.reopen', { todoId: id, baseVersion: version }, { queueOnFailure: true })
      if (!this.requestIsCurrent(scope)) return
      if (data.queued) this.setSyncStatus('已保存在手机 · 正在安全同步', 'syncing')
      else {
        this.reconcileTodos(data.todos)
        this.markCloudReceived(data)
      }
    } catch (error) {
      if (!this.requestIsCurrent(scope)) return
      this.setData({ ...snapshot, ...completionCalendar.buildCompletionView(snapshot.completionHistory, this.data.completedQueryDate, this.data.completionMonth, this.data.todayDate) })
      this.persistVisibleTodos(snapshot.todos, snapshot.completed, this.data.scheduled, snapshot.completionHistory)
      this.setSyncStatus(error.message || '撤回失败，已恢复原状态', 'error')
    }
  },
  selectCompletionDate(event) {
    const date = String(event.currentTarget.dataset.date || '')
    if (!this.data.completionDates.includes(date)) return
    this.setData({
      ...completionCalendar.buildCompletionView(this.data.completionHistory, date, this.data.completionMonth, this.data.todayDate),
      completionCalendarOpen: false
    })
  },
  clearCompletionDate() {
    this.setData({
      ...completionCalendar.buildCompletionView(this.data.completionHistory, '', this.data.completionMonth, this.data.todayDate),
      completionCalendarOpen: false
    })
  },
  toggleCompletionCalendar() { this.setData({ completionCalendarOpen: !this.data.completionCalendarOpen }) },
  shiftCompletionMonth(event) {
    const offset = Number(event.currentTarget.dataset.offset || 0)
    if ((offset < 0 && !this.data.completionCanPrevious) || (offset > 0 && !this.data.completionCanNext)) return
    const month = completionCalendar.shiftMonth(this.data.completionMonth, offset)
    this.setData(completionCalendar.buildCompletionView(this.data.completionHistory, this.data.completedQueryDate, month, this.data.todayDate))
  },
  async setPin(event) {
    const scope = this.currentScope()
    const { id, version, pinned } = event.currentTarget.dataset
    const target = this.data.todos.find((todo) => todo.id === id)
    if (!target) return
    const snapshot = this.data.todos
    const willPin = !pinned
    const autoPinHighPriorityTodos = api.autoPinHighPriorityTodosEnabled()
    const changed = {
      ...target,
      pinned: willPin,
      priorityPinned: willPin && target.priority === 'high' && autoPinHighPriorityTodos,
      pinnedAt: willPin ? new Date().toISOString() : '',
      sortRank: nextSortRank(snapshot)
    }
    const next = sortTodayTodos(snapshot.map((todo) => todo.id === id ? changed : todo))
    this.setData({ todos: next })
    this.persistVisibleTodos(next, this.data.completed)
    this.markPhoneSaved(willPin ? '已置顶' : '已取消置顶')
    try {
      const data = await api.mutateTodayTodo('todayTodo.setPin', {
        todoId: id,
        pinned: willPin,
        baseVersion: version,
        autoPinHighPriorityTodos
      }, { queueOnFailure: true })
      if (!this.requestIsCurrent(scope)) return
      if (data.queued) {
        this.setData({ offline: false })
        this.setSyncStatus('已保存在手机 · 正在安全同步', 'syncing')
      } else {
        this.reconcileTodos(data.todos)
        this.markCloudReceived(data)
      }
    } catch (error) {
      if (!this.requestIsCurrent(scope)) return
      this.setData({ todos: snapshot })
      this.persistVisibleTodos(snapshot, this.data.completed)
      this.setSyncStatus(error.message || '置顶保存失败，已恢复原状态', 'error')
    }
  },
  startTodoDrag(event) {
    const id = event.currentTarget.dataset.id
    const todos = this.data.todos || []
    if (!id || todos.length < 2) return
    const item = todos.find((todo) => todo.id === id)
    if (!item) return
    this._todoDrag = {
      id,
      pinTier: pinTier(item),
      initialTodos: todos,
      initialIds: todos.map((todo) => todo.id),
      currentIds: todos.map((todo) => todo.id),
      rects: []
    }
    this.setData({ draggingTodoId: id, dragTargetTodoId: '' })
    wx.vibrateShort({ type: 'light' })
    wx.createSelectorQuery().in(this).selectAll('.todo-card').boundingClientRect((rects) => {
      if (this._todoDrag && this._todoDrag.id === id) this._todoDrag.rects = rects || []
    }).exec()
  },
  moveTodoDrag(event) {
    const drag = this._todoDrag
    const touch = event.touches && event.touches[0]
    if (!drag || !touch || !drag.rects.length) return
    const y = Number(touch.clientY)
    let targetIndex = drag.rects.findIndex((rect) => y >= rect.top && y <= rect.bottom)
    if (targetIndex < 0) {
      targetIndex = drag.rects.reduce((best, rect, index) => {
        const distance = Math.abs(y - (rect.top + rect.height / 2))
        return distance < best.distance ? { index, distance } : best
      }, { index: -1, distance: Number.POSITIVE_INFINITY }).index
    }
    const target = this.data.todos[targetIndex]
    const fromIndex = this.data.todos.findIndex((todo) => todo.id === drag.id)
    const dragged = this.data.todos[fromIndex]
    if (!target || target.id === drag.id || fromIndex < 0 || !samePinTier(dragged, target) || pinTier(target) !== drag.pinTier) return
    const next = [...this.data.todos]
    const moved = next.splice(fromIndex, 1)[0]
    next.splice(targetIndex, 0, moved)
    drag.currentIds = next.map((todo) => todo.id)
    this.setData({ todos: next, dragTargetTodoId: target.id })
  },
  async finishTodoDrag() {
    const scope = this.currentScope()
    const drag = this._todoDrag
    if (!drag) return
    this._todoDrag = null
    this.setData({ draggingTodoId: '', dragTargetTodoId: '' })
    if (drag.currentIds.join('|') === drag.initialIds.join('|')) return
    const rankedTodos = sortTodayTodos(applyOrderedIds(this.data.todos, drag.currentIds))
    const orderedIds = rankedTodos.map((todo) => todo.id)
    this.setData({ todos: rankedTodos })
    this.persistVisibleTodos(rankedTodos, this.data.completed)
    this.markPhoneSaved('新顺序已生效')
    const versions = {}
    for (const todo of rankedTodos) versions[todo.id] = todo.version
    try {
      const data = await api.mutateTodayTodo('todayTodo.reorder', { orderedIds, versions }, { queueOnFailure: true })
      if (!this.requestIsCurrent(scope)) return
      if (data.queued) {
        this.setData({ offline: false })
        this.setSyncStatus('已保存在手机 · 正在安全同步', 'syncing')
      } else {
        this.reconcileTodos(data.todos)
        this.markCloudReceived(data)
      }
    } catch (error) {
      if (!this.requestIsCurrent(scope)) return
      this.setData({ todos: drag.initialTodos })
      this.persistVisibleTodos(drag.initialTodos, this.data.completed)
      this.setSyncStatus(error.message || '顺序保存失败，已恢复原顺序', 'error')
    }
  },
  cancelTodoDrag() {
    if (!this._todoDrag) return
    const initialTodos = this._todoDrag.initialTodos
    this._todoDrag = null
    this.setData({ todos: initialTodos, draggingTodoId: '', dragTargetTodoId: '' })
  },
  toggleComments(event) {
    const id = event.currentTarget.dataset.id
    this.setData({ [`openComments.${id}`]: !this.data.openComments[id] })
  },
  toggleCompletionNotes(event) {
    const id = event.currentTarget.dataset.id
    this.setData({ [`openCompletionNotes.${id}`]: !this.data.openCompletionNotes[id] })
  },
  toggleHistoryNotes(event) {
    const id = event.currentTarget.dataset.id
    this.setData({ [`openHistoryNotes.${id}`]: !this.data.openHistoryNotes[id] })
  },
  onCommentInput(event) {
    const id = event.currentTarget.dataset.id
    this.commentRevisions = { ...this.commentRevisions, [id]: Number(this.commentRevisions?.[id] || 0) + 1 }
    this.setData({ [`commentDrafts.${id}`]: event.detail.value })
    try { this.saveDraft() } catch (error) { this.renderSyncFeedback(null, error) }
  },
  async chooseCommentImages(event) {
    const scope = this.currentScope()
    const todoId = event.currentTarget.dataset.id
    if (this._choosingImages) return
    const existing = this.data.commentImages[todoId] || []
    const remaining = MAX_IMAGES - existing.length
    if (remaining <= 0) return wx.showToast({ title: '每条笔记最多 6 张图片', icon: 'none' })
    this._choosingImages = true
    try {
      const result = await wx.chooseMedia({ count: remaining, mediaType: ['image'], sourceType: ['album', 'camera'] })
      if (!this.requestIsCurrent(scope)) return
      for (const file of result.tempFiles || []) {
        let filePath = file.tempFilePath
        let size = Number(file.size || 0)
        if (size > COMPRESS_ABOVE_BYTES) {
          const compressed = await wx.compressImage({ src: filePath, quality: 72 })
          if (!this.requestIsCurrent(scope)) return
          filePath = compressed.tempFilePath
          const info = await new Promise((resolve, reject) => wx.getFileInfo({ filePath, success: resolve, fail: reject }))
          if (!this.requestIsCurrent(scope)) return
          size = Number(info.size || 0)
        }
        if (size <= 0 || size > MAX_IMAGE_BYTES) throw new Error('图片为空或压缩后仍超过 10 MB')
        const prepared = await api.saveImage(todoId, { id: randomId('todo-image'), filePath, size,
          fileName: filePath.split('/').pop() || '笔记图片.jpg' }, imageType(filePath).mimeType, this.data.storagePrefix)
        if (!this.requestIsCurrent(scope)) return
        const current = this.data.commentImages[todoId] || []
        if (current.length >= MAX_IMAGES) break
        this.setData({ [`commentImages.${todoId}`]: [...current, prepared] })
        this.saveDraft()
      }
    } catch (error) {
      if (!this.requestIsCurrent(scope)) return
      this.renderSyncFeedback(null, error)
      if (!String(error.errMsg || '').includes('cancel')) wx.showToast({ title: error.message || '无法读取图片', icon: 'none' })
    } finally {
      this._choosingImages = false
    }
  },
  removePendingImage(event) {
    const { id, imageId } = event.currentTarget.dataset
    const images = { ...this.data.commentImages, [id]: (this.data.commentImages[id] || []).filter((image) => image.id !== imageId) }
    try {
      this.saveDraft({ images })
      this.setData({ commentImages: images })
    } catch (error) { this.renderSyncFeedback(null, error) }
  },
  async uploadCommentImage(todoId, image) {
    const type = imageType(image.localFilePath || image.filePath)
    // Cloud transfer belongs to the durable mutation queue, never to the editor.
    return api.saveImage(todoId, image, image.mimeType || type.mimeType, this.data.storagePrefix)
  },
  async addComment(event) {
    const scope = this.currentScope()
    const { id, version } = event.currentTarget.dataset
    const content = String(this.data.commentDrafts[id] || '')
    const images = this.data.commentImages[id] || []
    const previous = this.data.commentSubmissions[id]
    if ((!previous && !content.trim() && !images.length) || this.data.commentSaving[id]) return
    let submission = previous || {
      revision: Number(this.commentRevisions?.[id] || 0), images,
      createdAt: new Date().toISOString(),
      payload: { todoId: id, commentId: randomId('todo_comment_client'), requestId: cache.requestId('comment'), content,
        attachments: [], baseVersion: version }
    }
    this.setData({ [`commentSaving.${id}`]: true })
    this.setSyncStatus('正在保存笔记与图片', 'syncing')
    try {
      this.setData({ [`commentSubmissions.${id}`]: submission })
      this.saveDraft()
      if (!submission.prepared) {
        const attachments = []
        for (const image of submission.images) {
          attachments.push(await this.uploadCommentImage(id, image))
          if (!this.requestIsCurrent(scope)) return
        }
        submission = { ...submission, prepared: true, payload: { ...submission.payload, attachments } }
        this.setData({ [`commentSubmissions.${id}`]: submission })
        this.saveDraft()
      }
      const data = await api.mutateTodayTodo('todayTodo.commentAdd', submission.payload, { queueOnFailure: true })
      if (!this.requestIsCurrent(scope)) return
      const payload = submission.payload
      const returned = (data.todos || []).find((row) => row.id === id)
      const comment = (returned?.comments || []).find((row) => row.id === payload.commentId) || {
        id: payload.commentId, content: payload.content, rawContent: payload.content, createdAt: submission.createdAt,
        pending: Boolean(data.queued), attachments: payload.attachments.map((item) => ({ ...item, previewUrl: item.localFilePath || item.previewUrl || '' }))
      }
      // Add only this comment to the latest view. Never restore a pre-request list.
      const todos = this.data.todos.map((todo) => {
        if (todo.id !== id || todo.deletedAt) return todo
        const comments = [...(todo.comments || [])]
        const index = comments.findIndex((row) => row.id === comment.id)
        if (index < 0) comments.push(comment)
        else if (!data.queued) comments[index] = comment
        return present({ ...todo, version: Math.max(Number(todo.version || 0), Number(returned?.version || 0)), comments })
      })
      this.persistVisibleTodos(todos, this.data.completed)
      this.setData({ todos })
      const comments = { ...this.data.commentDrafts }
      if (comments[id] === payload.content && Number(this.commentRevisions?.[id] || 0) === submission.revision) comments[id] = ''
      const submittedIds = new Set(submission.images.map((image) => image.id))
      const nextImages = { ...this.data.commentImages, [id]: (this.data.commentImages[id] || []).filter((image) => !submittedIds.has(image.id)) }
      const submissions = { ...this.data.commentSubmissions }; delete submissions[id]
      this.saveDraft({ comments, images: nextImages, submissions })
      this.setData({ commentDrafts: comments, commentImages: nextImages, commentSubmissions: submissions })
      if (data.queued) this.setSyncStatus('已保存到手机 · 笔记与图片等待上传', 'syncing')
      else this.markCloudReceived(data)
    } catch (error) {
      if (!this.requestIsCurrent(scope)) return
      this.renderSyncFeedback(null, error)
    } finally {
      if (this.requestIsCurrent(scope)) this.setData({ [`commentSaving.${id}`]: false })
    }
  },
  async deleteComment(event) {
    const scope = this.currentScope()
    const { id, commentId, version } = event.currentTarget.dataset
    const snapshot = this.data.todos
    const optimisticTodos = snapshot.map((todo) => {
      if (todo.id !== id) return todo
      const comments = (todo.comments || []).filter((comment) => comment.id !== commentId)
      return { ...todo, comments, commentCount: comments.length, commentLabel: comments.length ? `笔记 · ${comments.length}` : '笔记' }
    })
    this.setData({ todos: optimisticTodos })
    this.persistVisibleTodos(optimisticTodos, this.data.completed)
    this.markPhoneSaved('笔记已移除')
    try {
      const data = await api.mutateTodayTodo('todayTodo.commentDelete', { todoId: id, commentId, baseVersion: version }, { queueOnFailure: true })
      if (!this.requestIsCurrent(scope)) return
      if (data.queued) {
        this.setData({ offline: false })
        this.setSyncStatus('已保存在手机 · 点击“同步刷新”后上传', 'syncing')
      } else {
        this.reconcileTodos(data.todos)
        this.markCloudReceived(data)
      }
    } catch (error) {
      if (!this.requestIsCurrent(scope)) return
      this.setData({ todos: snapshot })
      this.persistVisibleTodos(snapshot, this.data.completed)
      this.setSyncStatus(error.message || '笔记删除失败，已恢复原状态', 'error')
    }
  },
  previewImage(event) {
    const { url, id } = event.currentTarget.dataset
    const historyRows = (this.data.history || []).flatMap((group) => group.todos || [])
    const todo = [...this.data.todos, ...this.data.completed, ...this.data.completionHistory, ...historyRows].find((item) => item.id === id)
    const urls = todo ? todo.comments.flatMap((comment) => comment.attachments || []).map((attachment) => attachment.previewUrl).filter(Boolean) : [url]
    wx.previewImage({ current: url, urls: urls.length ? urls : [url] })
  },
  async syncComputer() {
    if (this.data.syncingComputer) return
    const scope = this.currentScope()
    this.setData({ syncingComputer: true })
    this.setSyncStatus('正在同步今日待办、灵光一现与长期计划', 'syncing')
    try {
      const syncResult = await getApp().requestSync('manual-computer-sync')
      if (!this.requestIsCurrent(scope, syncResult)) return
      this.applySyncResult(syncResult)
    } catch (error) {
      if (this.requestIsCurrent(scope)) this.renderSyncFeedback(null, error)
    } finally {
      if (this.requestIsCurrent(scope)) this.setData({ syncingComputer: false })
    }
  },
  openAssistant() {
    if (this.data.openingAssistant || this.data.onboardingRequired) return
    this.setData({ openingAssistant: true })
    wx.navigateTo({
      url: '/pages/account/index?section=wechat',
      complete: () => this.setData({ openingAssistant: false })
    })
  },
  toggleCompleted() { this.setData({ showCompleted: !this.data.showCompleted }) },
  toggleHistory() { this.setData({ showHistory: !this.data.showHistory }) },
  goInbox() {
    wx.setStorageSync('mainline.openPending', true)
    wx.switchTab({ url: '/pages/capture/index' })
  },
  goJournal() { wx.switchTab({ url: '/pages/capture/index' }) },
  goAccount() { wx.navigateTo({ url: '/pages/account/index' }) }
})
