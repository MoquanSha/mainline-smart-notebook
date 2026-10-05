const api = require('../../utils/api')
const cache = require('../../utils/cache')
const candidateRefresh = require('../../utils/candidate-refresh')
const proposalResults = require('../../utils/proposal-results')

function present(items) {
  return (items || []).map((item) => ({
    ...item,
    typeLabel: item.type === 'today_todo' ? '今日待办候选' : item.type === 'calendar_event' ? '时间安排' : item.type === 'task_create' ? '新任务' : item.type === 'task_update' ? '任务更新' : item.type === 'blocker' ? '阻塞' : item.type === 'achievement' ? '成果' : '记录',
    ownerLabel: item.owner === 'ai' ? 'AI 准备' : item.owner === 'both' ? '共同完成' : '我来完成',
    timeLabel: item.eventTime ? `${item.eventDate || ''} ${item.eventTime}${item.eventEndTime ? `–${item.eventEndTime}` : ''}` : '',
    hasSteps: Array.isArray(item.steps) && item.steps.length > 0,
    sourceCount: (item.captureIds || item.sourceIds || []).length,
    sourceLabel: item.sourceChannel === 'wechat_mp' ? '公众号' : item.sourceChannel === 'wecom' ? '企业微信' : item.sourceChannel === 'codex' ? 'Codex' : item.sourceChannel === 'desktop' ? '电脑' : '小程序',
    sourcePreview: item.sourcePreview || '',
    effectLabel: item.type === 'today_todo' ? '采用后加入今日待办' : item.type === 'calendar_event' ? '采用后加入固定安排' : item.type === 'task_create' ? '采用后创建长期计划' : item.type === 'task_update' ? '采用后更新已有计划' : '采用后写入灵光一现'
  }))
}

Page({
  data: {
    proposals: [], deferred: [], loading: true, applyingAll: false,
    editingId: '', editDraft: null
  },
  onLoad() {
    this.unloaded = false
    this.unsubscribeSync = getApp().subscribeSync(() => { if (this.isCurrent(this.currentScope())) this.applyList(cache.read(cache.KEYS.proposals, [])) })
  },
  onUnload() {
    this.unloaded = true
    if (this.unsubscribeSync) this.unsubscribeSync()
  },
  currentScope() { return cache.scopeToken() },
  isCurrent(scope) { return !this.unloaded && scope === this.currentScope() && scope === this.pageScope },
  onShow() {
    const scope = this.currentScope()
    if (scope !== this.pageScope) {
      this.pageScope = scope; this.inFlight = new Set()
      const draft = cache.read(cache.KEYS.proposalDraftState, {})
      this.editRevision = Number(draft.revision || 0)
      this.setData({ editingId: draft.id || '', editDraft: draft.draft || null, proposals: [], deferred: [], applyingAll: false })
    }
    this.applyList(cache.read(cache.KEYS.proposals, []))
  },
  async refresh(options = {}) {
    const scope = this.currentScope()
    if (!this.isCurrent(scope)) return false
    const cached = cache.read(cache.KEYS.proposals, [])
    if (cached.length) this.applyList(cached)
    try {
      if (!options.skipCandidates) await candidateRefresh.refreshIfDue().catch(() => null)
      if (!this.isCurrent(scope)) return false
      const before = cache.read(cache.KEYS.proposals, [])
      const data = await api.call('proposal.list', {}, { forceRemote: true })
      if (!this.isCurrent(scope)) return false
      const next = proposalResults.mergeRead(before, cache.read(cache.KEYS.proposals, []), data)
      cache.write(cache.KEYS.proposals, next); this.applyList(next)
      return true
    } catch (error) {
      if (!this.isCurrent(scope)) return false
      this.setData({ loading: false })
      if (!cached.length) wx.showToast({ title: error.message, icon: 'none' })
      return false
    }
  },
  applyList(items) {
    const all = present(items)
    this.setData({
      proposals: all.filter((item) => item.status === 'pending'),
      deferred: all.filter((item) => item.status === 'deferred'),
      loading: false
    })
  },
  apply(event) { return this.handle('proposal.apply', event.currentTarget.dataset.id, '已采用') },
  reject(event) { return this.handle('proposal.reject', event.currentTarget.dataset.id, '已忽略') },
  defer(event) { return this.handle('proposal.defer', event.currentTarget.dataset.id, '已放到稍后') },
  restore(event) { return this.handle('proposal.restore', event.currentTarget.dataset.id, '已移回待确认') },
  remove(event) {
    const scope = this.currentScope()
    if (!this.isCurrent(scope)) return
    const id = event.currentTarget.dataset.id
    wx.showModal({ title: '删除这条整理结果？', content: '只删除整理方案，原始输入仍会保留。', confirmColor: '#b23a3a', success: ({ confirm }) => { if (confirm && this.isCurrent(scope)) this.handle('proposal.delete', id, '已删除') } })
  },
  async handle(action, id, toast) {
    const scope = this.currentScope(), key = `${action}:${id}`
    if (!this.isCurrent(scope) || this.inFlight.has(key) || this.data.applyingAll) return
    const item = [...this.data.proposals, ...this.data.deferred].find((row) => row.id === id)
    if (!item) return
    this.inFlight.add(key)
    try {
      const result = await api.call(action, proposalResults.selections([item])[0])
      if (!this.isCurrent(scope)) return
      const next = proposalResults.mergeResult(cache.read(cache.KEYS.proposals, []), result)
      cache.write(cache.KEYS.proposals, next); this.applyList(next)
      const refreshed = await this.refresh({ skipCandidates: true })
      if (!this.isCurrent(scope)) return
      const status = proposalResults.feedback(result, toast)
      wx.showToast({ title: refreshed ? status.message : '已提交，列表待刷新', icon: refreshed && status.tone === 'ok' ? 'success' : 'none' })
    } catch (error) { if (this.isCurrent(scope)) wx.showToast({ title: error.message, icon: 'none' }) }
    finally { if (this.isCurrent(scope)) this.inFlight.delete(key) }
  },
  startEdit(event) {
    if (!this.isCurrent(this.currentScope())) return
    const id = event.currentTarget.dataset.id
    const item = [...this.data.proposals, ...this.data.deferred].find((row) => row.id === id)
    if (!item) return
    this.setData({
      editingId: id,
      editDraft: {
        title: item.title || '', detail: item.detail || '', nextAction: item.nextAction || '',
        eventDate: item.eventDate || '', eventTime: item.eventTime || '', eventEndTime: item.eventEndTime || '',
        baseVersion: item.version
      }
    })
    this.persistEdit()
  },
  editField(event) {
    if (!this.isCurrent(this.currentScope()) || !this.data.editDraft) return
    const field = event.currentTarget.dataset.field
    if (!['title', 'detail', 'nextAction', 'eventDate', 'eventTime', 'eventEndTime'].includes(field)) return
    this.setData({ [`editDraft.${field}`]: event.detail.value })
    this.persistEdit()
  },
  persistEdit() {
    this.editRevision = Number(this.editRevision || 0) + 1
    try { cache.write(cache.KEYS.proposalDraftState, { id: this.data.editingId, draft: this.data.editDraft, revision: this.editRevision }) }
    catch (error) { wx.showToast({ title: error.message, icon: 'none' }) }
  },
  cancelEdit() {
    if (!this.isCurrent(this.currentScope())) return
    cache.write(cache.KEYS.proposalDraftState, {})
    this.editRevision = Number(this.editRevision || 0) + 1
    this.setData({ editingId: '', editDraft: null })
  },
  async saveEdit() {
    const scope = this.currentScope()
    if (!this.isCurrent(scope)) return
    const draft = this.data.editDraft
    if (!draft || !draft.title.trim()) return wx.showToast({ title: '标题不能为空', icon: 'none' })
    const key = `edit:${this.data.editingId}`
    if (this.inFlight.has(key) || this.data.applyingAll) return
    this.inFlight.add(key)
    wx.showLoading({ title: '正在保存' })
    const revision = this.editRevision, id = this.data.editingId
    try {
      const { baseVersion, ...patch } = draft
      cache.write(cache.KEYS.proposalDraftState, { id, draft, revision })
      const result = await api.call('proposal.update', { id, patch, baseVersion })
      if (!this.isCurrent(scope)) return
      cache.write(cache.KEYS.proposals, proposalResults.mergeResult(cache.read(cache.KEYS.proposals, []), result))
      if (this.editRevision === revision && this.data.editingId === id) this.cancelEdit()
      else if (this.data.editingId === id && this.data.editDraft?.baseVersion === baseVersion) {
        // Advance only to our own acknowledged revision. A subsequent refresh
        // may contain another device's edit and must not silently rebase this draft.
        const acknowledged = result.proposal || (result.id === id ? result : null)
        if (acknowledged?.version) {
          this.setData({ 'editDraft.baseVersion': acknowledged.version })
          this.persistEdit()
        }
      }
      await this.refresh({ skipCandidates: true })
      if (this.isCurrent(scope)) wx.showToast({ title: '已保存', icon: 'success' })
    } catch (error) { if (this.isCurrent(scope)) wx.showToast({ title: error.message, icon: 'none' }) }
    finally { if (this.isCurrent(scope)) { this.inFlight.delete(key); wx.hideLoading() } }
  },
  async showSources(event) {
    const scope = this.currentScope()
    if (!this.isCurrent(scope)) return
    const id = event.currentTarget.dataset.id
    const item = [...this.data.proposals, ...this.data.deferred].find((row) => row.id === id)
    if (!item) return
    try {
      const data = await api.call('source.list', { sourceIds: item.captureIds || item.sourceIds || [] })
      if (!this.isCurrent(scope)) return
      const sources = data.sources || []
      const content = sources.length ? sources.slice(0, 6).map((source, index) => `${index + 1}. ${String(source.rawContent || source.content || '').slice(0, 90)}`).join('\n\n') : '没有找到可显示的原始内容。'
      wx.showModal({ title: `整理依据 ${sources.length} 条`, content, showCancel: false })
    } catch (error) { if (this.isCurrent(scope)) wx.showToast({ title: error.message, icon: 'none' }) }
  },
  applyAll() {
    const scope = this.currentScope()
    if (!this.isCurrent(scope) || !this.data.proposals.length || this.data.applyingAll || this.inFlight.size) return
    const selections = proposalResults.selections(this.data.proposals)
    wx.showModal({ title: '全部采用？', content: `将采用当前 ${selections.length} 条待确认内容；“稍后处理”的内容不会被采用。`, success: async ({ confirm }) => {
      if (!confirm || !this.isCurrent(scope) || this.data.applyingAll || this.inFlight.size) return
      this.setData({ applyingAll: true })
      try {
        const result = await api.call('proposal.applyAll', { selections })
        if (!this.isCurrent(scope)) return
        const next = proposalResults.mergeResult(cache.read(cache.KEYS.proposals, []), result)
        cache.write(cache.KEYS.proposals, next); this.applyList(next)
        const refreshed = await this.refresh({ skipCandidates: true })
        if (!this.isCurrent(scope)) return
        const status = proposalResults.feedback(result, `已采用 ${result.applied} 条`)
        wx.showToast({ title: refreshed ? status.message : '已提交，列表待刷新', icon: refreshed && status.tone === 'ok' ? 'success' : 'none' })
      } catch (error) { if (this.isCurrent(scope)) wx.showToast({ title: error.message, icon: 'none' }) }
      finally { if (this.isCurrent(scope)) this.setData({ applyingAll: false }) }
    } })
  }
})
