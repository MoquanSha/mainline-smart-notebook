const api = require('../../utils/api')
const cache = require('../../utils/cache')
const syncFeedback = require('../../utils/sync-feedback')
const diaryPresenter = require('./diary-presenter')

const OWNER_TABS = [
  { label: '全部', value: 'all' }, { label: '我来做', value: 'me' },
  { label: '共同', value: 'both' }, { label: 'AI 准备', value: 'ai' }
]

function prepare(item) {
  const steps = item.steps || []
  return {
    ...item,
    ownerLabel: item.owner === 'ai' ? 'AI 准备' : item.owner === 'both' ? '共同完成' : '我来完成',
    currentStep: steps.find((step) => step.id === item.currentStepId || step.status === 'current') || steps.find((step) => step.status !== 'done') || null,
    stepCount: steps.length,
    doneSteps: steps.filter((step) => step.status === 'done').length,
    sourceCount: (item.sourceCaptureIds || item.sourceIds || []).length,
    expanded: false
  }
}

Page({
  data: {
    allTasks: [], tasks: [], completed: [], loading: true, query: '', ownerTabs: OWNER_TABS,
    ownerIndex: 0, showCompleted: false,
    todayDate: diaryPresenter.shanghaiDateKey(), todayDateLabel: '', diarySummary: '', diarySummaryNodes: [], diarySourceLabel: '基础整理',
    diaryUpdatedLabel: '手机本地整理', diaryPeriods: [], diaryStats: { newTodos: 0, completed: 0, notes: 0, journals: 0 },
    diaryNewTodos: [], diaryCompleted: [], diaryTodoNotes: [], diaryJournals: [], pastDiaryDays: [],
    diaryManualInputs: [], diaryInput: '', diaryDraftDate: '',
    showDiaryHistory: false, showTodoNotes: false, showManualInputs: true, showLegacyTasks: false,
    refreshingDiary: false, organizingDiaryInput: false,
    syncMessage: '', syncTone: 'idle', syncVisible: false
  },
  onLoad() {
    this.unloaded = false
    this.reloadDraft()
    this.unsubscribeSync = getApp().subscribeSync((event = {}) => {
      this.applyPage()
      // Scope changes also need to refresh the banner. Otherwise a blocked
      // operation from workspace A can remain visible after entering B.
      this.renderSyncFeedback(event.result, event.error)
    })
  },
  onUnload() {
    this.unloaded = true
    if (this.unsubscribeSync) this.unsubscribeSync()
  },
  onShow() { this.reloadDraft(); this.applyPage(); this.renderSyncFeedback() },
  currentScope() { return cache.scopeToken ? cache.scopeToken() : '' },
  requestIsCurrent(scope) { return !this.unloaded && scope === this.currentScope() },
  reloadDraft() {
    const changed = this.pageScope !== cache.scopeToken()
    this.pageScope = cache.scopeToken()
    let draft = cache.read(cache.KEYS.diaryDraftState, null)
    if (!draft) {
      draft = { content: String(cache.read(cache.KEYS.diaryDraft, '')), date: diaryPresenter.shanghaiDateKey(), revision: 0, inputId: cache.requestId('diary-input') }
      cache.write(cache.KEYS.diaryDraftState, draft)
    }
    this.setData({ diaryInput: draft.content, diaryDraftDate: draft.date, ...(changed ? { organizingDiaryInput: false, refreshingDiary: false } : {}) })
  },
  requestIsCurrent(scope) { return !this.unloaded && scope === cache.scopeToken() },
  applyPage() {
    if (this.unloaded) return
    if (this.pageScope !== cache.scopeToken()) this.reloadDraft()
    this.setData({ todayDate: diaryPresenter.shanghaiDateKey() })
    this.applyDiary()
    this.applyTasks(cache.read(cache.KEYS.tasks, []))
  },
  renderSyncFeedback(result, error) {
    if (this.unloaded) return
    const status = syncFeedback.fromCache(cache, api.getHybridStatus ? api.getHybridStatus() : {}, result || {}, error || null)
    this.setData({ syncMessage: status.message, syncTone: status.tone, syncVisible: Boolean(status.message) })
  },
  applyDiary() {
    const days = cache.read(cache.KEYS.diaryDays, [])
    const view = diaryPresenter.buildDiaryView({
      todayDate: this.data.todayDate,
      days,
      todayState: cache.read(cache.KEYS.todayTodos, {}),
      journal: cache.read(cache.KEYS.journal, {})
    })
    const day = days.find((item) => item.date === this.data.todayDate)
    const progress = cache.read(cache.KEYS.diaryOrganization, {})[this.data.todayDate]
    let sourceLabel = view.sourceLabel
    if (day && progress && progress.revision === day.inputRevision) {
      if (progress.status === 'running' || progress.status === 'pending') sourceLabel = `原文已保存，整理进度 ${progress.completed || 0}/${progress.total || '?'}`
      if (progress.status === 'failed') sourceLabel = '原文已保存，整理待重试'
    }
    this.setData({
      todayDateLabel: view.todayDateLabel,
      diaryReviewJob: progress && progress.revision === day?.inputRevision ? progress : day?.organizationJob || null,
      reviewScope: cache.scopeToken(),
      diarySummary: view.summary,
      diarySummaryNodes: view.summaryNodes,
      diarySourceLabel: sourceLabel,
      diaryUpdatedLabel: view.updatedLabel,
      diaryPeriods: view.periods,
      diaryManualInputs: view.manualInputs,
      diaryStats: view.stats,
      diaryNewTodos: view.newTodos,
      diaryCompleted: view.completed,
      diaryTodoNotes: view.todoNotes,
      diaryJournals: view.journals,
      pastDiaryDays: view.pastDiaryDays
    })
  },
  async refresh() {
    const scope = this.currentScope()
    const cached = cache.read(cache.KEYS.tasks, [])
    this.applyTasks(cached)
    try {
      const data = await api.call('task.list')
      if (!this.requestIsCurrent(scope)) return
      cache.write(cache.KEYS.tasks, data.tasks)
      this.applyTasks(data.tasks)
    } catch (error) {
      if (!this.requestIsCurrent(scope)) return
      this.setData({ loading: false })
      if (!cached.length) wx.showToast({ title: error.message, icon: 'none' })
    }
  },
  applyTasks(items) {
    const allTasks = (items || []).map(prepare)
    this.setData({ allTasks, loading: false }, () => this.filterTasks())
  },
  toggleDiaryHistory() { this.setData({ showDiaryHistory: !this.data.showDiaryHistory }) },
  toggleTodoNotes() { this.setData({ showTodoNotes: !this.data.showTodoNotes }) },
  toggleManualInputs() { this.setData({ showManualInputs: !this.data.showManualInputs }) },
  toggleLegacyTasks() { this.setData({ showLegacyTasks: !this.data.showLegacyTasks }) },
  onDiaryInput(event) {
    const value = String(event.detail.value || '')
    const previous = cache.read(cache.KEYS.diaryDraftState, {})
    const draft = {
      content: value, date: previous.content ? previous.date : diaryPresenter.shanghaiDateKey(),
      revision: Number(previous.revision || 0) + 1, inputId: cache.requestId('diary-input')
    }
    cache.write(cache.KEYS.diaryDraftState, draft)
    cache.write(cache.KEYS.diaryDraft, value)
    this.setData({ diaryInput: value, diaryDraftDate: draft.date })
  },
  async organizeDiaryInput() {
    const content = String(this.data.diaryInput || '')
    if (!content.trim() || this.data.organizingDiaryInput) return
    const draft = cache.read(cache.KEYS.diaryDraftState, {})
    const inputId = draft.inputId
    const scope = cache.scopeToken()
    const date = draft.date || this.data.todayDate
    let originalSaved = false
    this.setData({ organizingDiaryInput: true })
    wx.showLoading({ title: '保存原文中' })
    try {
      const data = await api.call('diary.appendInput', {
        date, content, inputId
      }, { immediateSync: true, requestId: inputId })
      if (!this.requestIsCurrent(scope)) return
      if (!data || data.acceptedInputId !== inputId || !data.day) throw new Error('尚未确认保存，已保留草稿')
      originalSaved = true
      const current = cache.read(cache.KEYS.diaryDraftState, {})
      if (current.revision === draft.revision && current.inputId === inputId && current.content === content) {
        cache.write(cache.KEYS.diaryDraftState, { content: '', date: diaryPresenter.shanghaiDateKey(), revision: Number(current.revision || 0) + 1, inputId: cache.requestId('diary-input') })
        cache.write(cache.KEYS.diaryDraft, '')
        this.setData({ diaryInput: '' })
      }
      this.setData({ showManualInputs: true })
      this.applyDiary()
      if (data.queued) {
        wx.showToast({ title: '原文已存本机，等待上传', icon: 'none' })
        this.renderSyncFeedback(data)
        return
      }
      this.renderSyncFeedback({ flush: { sent: 1, remaining: 0 }, remoteFresh: true })
      this.startDiaryOrganization(date, scope)
      wx.showToast({ title: '原文已保存，正在整理', icon: 'none' })
    } catch (error) {
      if (!this.requestIsCurrent(scope)) return
      this.applyDiary()
      this.renderSyncFeedback(null, error)
      wx.showToast({ title: originalSaved ? '原文已保存，整理待重试' : error.message || '暂时无法保存，草稿仍保留', icon: 'none' })
    } finally {
      if (this.requestIsCurrent(scope)) {
        wx.hideLoading()
        this.setData({ organizingDiaryInput: false })
      }
    }
  },
  startDiaryOrganization(date, scope) {
    // Saving ends immediately after durable acceptance. The app-level worker
    // survives page navigation, and its events update whichever page is open.
    this.organizationPromise = api.organizePendingDiaries({ date, retry: true }).then((result) => {
      if (!this.requestIsCurrent(scope)) return result
      this.applyDiary()
      if (result && result.error) wx.showToast({ title: result.error, icon: 'none' })
      return result
    }).catch(() => {
      if (this.requestIsCurrent(scope)) wx.showToast({ title: '原文已保存，整理待重试', icon: 'none' })
    })
  },
  async refreshDiary() {
    if (this.data.refreshingDiary) return
    const scope = cache.scopeToken()
    this.setData({ refreshingDiary: true })
    try {
      this.startDiaryOrganization(this.data.todayDate, scope)
      wx.showToast({ title: '已安排整理，可继续记录', icon: 'none' })
    } catch (error) {
      if (!this.requestIsCurrent(scope)) return
      this.applyDiary()
      wx.showToast({ title: error && error.code === 'VALIDATION' ? '云端旧版本暂不支持，其他功能不受影响' : (error.message || '小记更新失败'), icon: 'none' })
    } finally {
      if (this.requestIsCurrent(scope)) {
        this.setData({ refreshingDiary: false })
      }
    }
  },
  onSearch(event) { this.setData({ query: event.detail.value }, () => this.filterTasks()) },
  onOwnerChange(event) { this.setData({ ownerIndex: Number(event.currentTarget.dataset.index) }, () => this.filterTasks()) },
  filterTasks() {
    const query = this.data.query.trim().toLowerCase()
    const owner = OWNER_TABS[this.data.ownerIndex].value
    const filtered = this.data.allTasks.filter((item) => {
      const matchesOwner = owner === 'all' || item.owner === owner
      const haystack = `${item.title || ''} ${item.description || ''} ${item.nextAction || ''} ${item.project || ''}`.toLowerCase()
      return matchesOwner && (!query || haystack.includes(query))
    })
    const rank = { me: 0, both: 1, ai: 2 }
    filtered.sort((a, b) => (rank[a.owner] || 0) - (rank[b.owner] || 0) || Number(b.priority === 'high') - Number(a.priority === 'high') || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    this.setData({
      tasks: filtered.filter((item) => !['done', 'archived'].includes(item.status)),
      completed: filtered.filter((item) => ['done', 'archived'].includes(item.status))
    })
  },
  toggleSteps(event) {
    const id = event.currentTarget.dataset.id
    this.setData({ allTasks: this.data.allTasks.map((item) => item.id === id ? { ...item, expanded: !item.expanded } : item) }, () => this.filterTasks())
  },
  toggleCompleted() { this.setData({ showCompleted: !this.data.showCompleted }) },
  async changeProgress(event) {
    const scope = this.currentScope()
    const id = event.currentTarget.dataset.id
    const task = this.data.allTasks.find((item) => item.id === id)
    if (!task) return
    const progress = Number(event.detail.value)
    try {
      await api.call('task.update', { id, patch: { progress }, baseVersion: task.version })
      if (!this.requestIsCurrent(scope)) return
      this.applyTasks(cache.read(cache.KEYS.tasks, []))
    } catch (error) { if (this.requestIsCurrent(scope)) wx.showToast({ title: error.message, icon: 'none' }) }
  },
  completeStep(event) {
    const task = this.data.allTasks.find((item) => item.id === event.currentTarget.dataset.id)
    if (!task || !task.currentStep) return
    wx.showModal({ title: '完成当前步骤？', content: task.currentStep.title, success: async ({ confirm }) => {
      if (!confirm) return
      const scope = this.currentScope()
      try {
        await api.call('task.completeStep', { taskId: task.id, stepId: task.currentStep.id, baseVersion: task.version })
        if (!this.requestIsCurrent(scope)) return
        wx.showToast({ title: '已进入下一步', icon: 'success' }); this.applyTasks(cache.read(cache.KEYS.tasks, []))
      } catch (error) { if (this.requestIsCurrent(scope)) wx.showToast({ title: error.message, icon: 'none' }) }
    } })
  },
  async reanalyze(event) {
    const scope = this.currentScope()
    const id = event.currentTarget.dataset.id
    wx.showLoading({ title: 'AI 正在复核' })
    try {
      await api.call('task.reanalyze', { id })
      if (!this.requestIsCurrent(scope)) return
      wx.showToast({ title: '已进入待确认', icon: 'success' })
      setTimeout(() => wx.switchTab({ url: '/pages/inbox/index' }), 500)
    } catch (error) { if (this.requestIsCurrent(scope)) wx.showToast({ title: error.message, icon: 'none' }) }
    finally { wx.hideLoading() }
  },
  async showSources(event) {
    const scope = this.currentScope()
    try {
      const data = await api.call('source.list', { taskId: event.currentTarget.dataset.id })
      if (!this.requestIsCurrent(scope)) return
      const sources = data.sources || []
      const content = sources.length ? sources.slice(0, 6).map((source, index) => `${index + 1}. ${String(source.rawContent || source.content || '').slice(0, 90)}`).join('\n\n') : '没有找到可显示的原始内容。'
      wx.showModal({ title: `来源 ${sources.length} 条`, content, showCancel: false })
    } catch (error) { if (this.requestIsCurrent(scope)) wx.showToast({ title: error.message, icon: 'none' }) }
  },
  archive(event) {
    const task = this.data.allTasks.find((item) => item.id === event.currentTarget.dataset.id)
    if (!task) return
    wx.showActionSheet({ itemList: ['归档长期计划', '彻底删除长期计划'], success: ({ tapIndex }) => {
      const permanent = tapIndex === 1
      wx.showModal({ title: permanent ? '彻底删除？' : '归档任务？', content: permanent ? '任务会从云端移除，历史结果仍保留。' : '任务将不再进入每日规划。', confirmColor: permanent ? '#b23a3a' : '#4f64e8', success: async ({ confirm }) => {
        if (!confirm) return
        const scope = this.currentScope()
        try {
          await api.call('task.archive', { id: task.id, baseVersion: task.version, deletePermanently: permanent })
          if (!this.requestIsCurrent(scope)) return
          this.applyTasks(cache.read(cache.KEYS.tasks, []))
        } catch (error) { if (this.requestIsCurrent(scope)) wx.showToast({ title: error.message, icon: 'none' }) }
      } })
    } })
  },
  addTask() { wx.navigateTo({ url: '/pages/capture/index' }) }
})
