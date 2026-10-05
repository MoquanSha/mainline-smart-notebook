const api = require('../../utils/api')
const cache = require('../../utils/cache')
const syncFeedback = require('../../utils/sync-feedback')
const candidateRefresh = require('../../utils/candidate-refresh')
const proposalResults = require('../../utils/proposal-results')
const { shanghaiDateFromValue } = require('../../utils/sync-history')
const {
  localEntry,
  present,
  presentOverview,
  sourceLabel
} = require('./presenter')

function proposalPresent(items) {
  return (items || []).filter((item) => item.status === 'pending').map((item) => ({
    ...item,
    typeLabel: item.type === 'today_todo' ? '今日待办' : item.type === 'calendar_event' ? '时间安排' : item.type === 'task_create' ? '长期计划' : item.type === 'task_update' ? '计划更新' : '记录',
    sourceLabel: sourceLabel(item.sourceChannel),
    effectLabel: item.type === 'today_todo' ? '加入今日待办' : item.type === 'calendar_event' ? '加入固定安排' : item.type === 'task_create' ? '创建长期计划' : item.type === 'task_update' ? '更新长期计划' : '写入灵光一现'
  }))
}

function mapOverviewEntries(overview, mapper) {
  return { ...overview,
    entries: (overview.entries || []).map(mapper),
    favorites: (overview.favorites || []).map(mapper),
    hidden: (overview.hidden || []).map(mapper),
    history: (overview.history || []).map((group) => ({ ...group, entries: (group.entries || []).map(mapper) }))
  }
}

Page({
  data: {
    content: '', saveMode: 'note', entries: [], favorites: [], hidden: [], history: [], historyCount: 0, reviews: [], reviewCount: 0,
    proposals: [], saving: false, applyingAll: false, proposalBusyId: '', loadingProposals: false, refreshingJournal: false,
    showPending: false, showFavorites: false, showHidden: false, showHistory: false, showReviews: false,
    offlineCount: 0, syncMessage: '', syncTone: 'idle', syncVisible: false
  },
  onLoad() {
    this.unloaded = false
    this.pageScope = this.currentScope()
    this.unsubscribeSync = getApp().subscribeSync((event = {}) => {
      if (!this.requestIsCurrent(this.currentScope(), event.result)) return
      try {
        const cached = cache.read(cache.KEYS.journal, null)
        if (cached && !Array.isArray(cached)) this.applyOverview(cached, false)
        if (event.type === 'sync-error') {
          this.renderSyncFeedback(null, event.error || new Error('云端接收尚未完成'))
        } else if (event.type === 'sync-cycle') {
          this.renderSyncFeedback(event.result || {})
        } else if (event.type === 'transport-state') {
          this.renderSyncFeedback()
        }
      } catch (error) { this.renderSyncFeedback(null, error) }
    })
  },
  onUnload() {
    this.unloaded = true
    if (this.unsubscribeSync) this.unsubscribeSync()
    if (this.syncTimer) clearTimeout(this.syncTimer)
  },
  onShow() {
    const scope = this.currentScope()
    if (this.pageScope !== undefined && this.pageScope !== scope) {
      this.lastSyncResult = null
      this.lastSyncError = null
      this.supplementDrafts = null
      this.supplementSaves = new Set()
      this.journalActions = new Map()
      if (this.syncTimer) clearTimeout(this.syncTimer)
      this.setData({ content: '', entries: [], favorites: [], hidden: [], history: [], historyCount: 0, reviews: [], reviewCount: 0, proposals: [],
        saving: false, applyingAll: false, proposalBusyId: '', refreshingJournal: false })
    }
    this.pageScope = scope
    this.supplementDrafts = this.supplementDrafts || cache.read(cache.KEYS.journalSupplementDraftState, {})
    const draft = cache.read(cache.KEYS.journalDraftState, {})
    this.draftRevision = Number(draft.revision || 0)
    this.draftId = draft.id || ''
    this.draftOccurredAt = draft.occurredAt || ''
    this.draftDate = draft.date || ''
    this.setData({ content: draft.content || '' })
    const cached = cache.read(cache.KEYS.journal, null)
    if (cached && !Array.isArray(cached)) this.applyOverview(cached, false)
    if (Array.isArray(cached)) this.applyOverview({ entries: cached }, false)
    if (wx.getStorageSync('mainline.openPending')) {
      wx.removeStorageSync('mainline.openPending')
      this.setData({ showPending: true })
    }
    this.setData({ offlineCount: cache.read(cache.KEYS.queue, []).length })
    this.applyProposals(cache.read(cache.KEYS.proposals, []))
    this.renderSyncFeedback()
  },
  currentScope() { return cache.scopeToken ? cache.scopeToken() : '' },
  requestIsCurrent(scope, result) {
    return !this.unloaded && scope === this.currentScope() && (this.pageScope === undefined || this.pageScope === scope) && (!result?.scopeToken || result.scopeToken === scope)
  },
  renderSyncFeedback(result, error) {
    if (result !== undefined) this.lastSyncResult = result
    if (error !== undefined || result !== undefined) this.lastSyncError = error || null
    const status = syncFeedback.fromCache(cache, api.getHybridStatus(), this.lastSyncResult, this.lastSyncError)
    this.setData({ offlineCount: status.pending })
    this.setSync(status.message, status.tone)
  },
  saveDraft() {
    cache.write(cache.KEYS.journalDraftState, { content: this.data.content, revision: this.draftRevision || 0,
      id: this.draftId || '', occurredAt: this.draftOccurredAt || '', date: this.draftDate || '' })
  },
  onInput(event) {
    this.draftRevision = Number(this.draftRevision || 0) + 1
    this.draftId = cache.requestId('journal')
    this.draftOccurredAt = this.draftOccurredAt || new Date().toISOString()
    this.draftDate = this.draftDate || shanghaiDateFromValue(new Date().toISOString())
    this.setData({ content: event.detail.value })
    try { this.saveDraft() } catch (error) { this.renderSyncFeedback(null, error) }
  },
  setSaveMode(event) { this.setData({ saveMode: event.currentTarget.dataset.mode }) },
  togglePending() { this.setData({ showPending: !this.data.showPending }) },
  toggleFavorites() { this.setData({ showFavorites: !this.data.showFavorites }) },
  toggleHidden() { this.setData({ showHidden: !this.data.showHidden }) },
  toggleHistory() { this.setData({ showHistory: !this.data.showHistory }) },
  toggleReviews() { this.setData({ showReviews: !this.data.showReviews }) },
  jumpToDate(event) {
    const target = String(event.currentTarget.dataset.target || '')
    if (!target) return
    wx.pageScrollTo({ selector: `#${target}`, duration: 240 })
  },
  setSync(message, tone = 'syncing', hideAfter = 0) {
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.setData({ syncMessage: message, syncTone: tone, syncVisible: Boolean(message) })
    if (hideAfter) this.syncTimer = setTimeout(() => this.setData({ syncVisible: false, syncMessage: '', syncTone: 'idle' }), hideAfter)
  },
  activeRouteMessage(prefix = '已同步') {
    const mode = api.getHybridStatus().mode
    if (mode === 'home') return `${prefix}到家庭服务器`
    if (mode === 'local') return '已保存在手机 · 等待可用线路自动补传'
    if (mode === 'recovering') return '正在恢复云端同步'
    return `${prefix}到云端`
  },
  currentOverview() {
    return {
      entries: this.data.entries,
      favorites: this.data.favorites,
      hidden: this.data.hidden,
      history: this.data.history,
      reviews: this.data.reviews
    }
  },
  applyOverview(data, persist = true) {
    const overview = presentOverview(data)
    if (persist) cache.write(cache.KEYS.journal, overview)
    this.setData(this.overlaySupplementDrafts(overview))
  },
  overlaySupplementDrafts(overview) {
    const drafts = this.supplementDrafts || cache.read(cache.KEYS.journalSupplementDraftState, {})
    const savedJobs = cache.read(cache.KEYS.journalOrganization, {})
    return mapOverviewEntries(overview, (entry) => {
      const draft = drafts[entry.id]
      const savedJob = savedJobs[entry.id]
      const job = savedJob && savedJob.revision === String(entry.rawContent ?? entry.content ?? '') ? savedJob : entry.organizationJob
      return { ...present({ ...entry, organizationJob: job }, entry.readonly),
        reviewScope: this.currentScope(),
        supplementText: draft ? draft.content : entry.supplementText || '',
        showSupplement: Boolean(draft && draft.content || entry.showSupplement),
        savingSupplement: Boolean(this.supplementSaves && this.supplementSaves.has(entry.id))
      }
    })
  },
  applyProposals(items) {
    const proposals = proposalPresent(items)
    cache.write(cache.KEYS.proposals, items || [])
    this.setData({ proposals, loadingProposals: false })
  },
  async refresh(options = {}) {
    const scope = this.currentScope()
    if (!options.silent) this.setData({ loadingProposals: true })
    try {
      if (!options.skipCandidateRefresh) await candidateRefresh.refreshIfDue().catch(() => null)
      if (!this.requestIsCurrent(scope)) return
      // The shared receiver owns the complete journal. A page refresh must not
      // replace it with the legacy endpoint's bounded overview.
      const proposalsBefore = cache.read(cache.KEYS.proposals, [])
      const [proposalResult] = await Promise.allSettled([api.call('proposal.list', {}, { forceRemote: Boolean(options.forceProposals) })])
      if (!this.requestIsCurrent(scope)) return
      this.applyOverview(cache.read(cache.KEYS.journal, { entries: [], history: [] }), false)
      if (proposalResult.status === 'fulfilled') {
        this.applyProposals(proposalResults.mergeRead(proposalsBefore, cache.read(cache.KEYS.proposals, []), proposalResult.value))
      } else {
        const cachedProposals = cache.read(cache.KEYS.proposals, [])
        this.applyProposals(cachedProposals)
      }
      if (!options.silent) {
        this.renderSyncFeedback(undefined, proposalResult.status === 'rejected' ? proposalResult.reason : undefined)
      }
      return proposalResult.status === 'fulfilled'
    } catch (error) {
      if (!this.requestIsCurrent(scope)) return
      this.renderSyncFeedback(null, error)
      return false
    } finally {
      if (this.requestIsCurrent(scope)) this.setData({ loadingProposals: false })
    }
  },
  async syncJournalFromCloud() {
    if (this.data.refreshingJournal) return
    const scope = this.currentScope()
    this.setData({ refreshingJournal: true })
    this.setSync('正在从云端刷新灵光一现', 'syncing')
    try {
      const result = await getApp().requestSync('journal-manual-refresh')
      if (!this.requestIsCurrent(scope, result)) return
      const cachedOverview = cache.read(cache.KEYS.journal, null)
      const overview = cachedOverview || result.views && result.views.journal
      if (overview) this.applyOverview(overview, false)
      this.renderSyncFeedback(result)
    } catch (error) {
      if (this.requestIsCurrent(scope)) this.renderSyncFeedback(null, error)
    } finally {
      if (this.requestIsCurrent(scope)) this.setData({ refreshingJournal: false })
    }
  },
  findEntry(id) {
    const flatHistory = (this.data.history || []).flatMap((group) => group.entries || [])
    return [...this.data.entries, ...this.data.favorites, ...this.data.hidden, ...flatHistory].find((entry) => entry.id === id)
  },
  mapEntryEverywhere(id, mapper) {
    return {
      entries: this.data.entries.map((entry) => entry.id === id ? mapper(entry) : entry),
      favorites: this.data.favorites.map((entry) => entry.id === id ? mapper(entry) : entry),
      hidden: this.data.hidden.map((entry) => entry.id === id ? mapper(entry) : entry),
      history: this.data.history.map((group) => ({ ...group, entries: group.entries.map((entry) => entry.id === id ? mapper(entry) : entry) }))
    }
  },
  async createEntry() {
    const scope = this.currentScope()
    const content = this.data.content
    if (!content.trim() || this.data.saving) return
    const favorite = this.data.saveMode === 'favorite'
    const id = this.draftId || cache.requestId('journal')
    this.draftId = id
    const revision = this.draftRevision || 0
    const submittedText = this.data.content
    const occurredAt = this.draftOccurredAt || new Date().toISOString()
    const date = this.draftDate || shanghaiDateFromValue(occurredAt)
    this.draftOccurredAt = occurredAt
    this.draftDate = date
    const optimistic = { ...localEntry(id, content, occurredAt, favorite), journalDate: date }
    this.setData({ saving: true })
    this.setSync('正在保存原文', 'syncing')
    try {
      this.saveDraft()
      const entry = await api.call('journal.create', { id, content, occurredAt, date, source: 'manual', favorite, deferOrganization: true }, { queueOnFailure: true, requestId: id })
      if (!this.requestIsCurrent(scope)) return
      const current = this.currentOverview()
      const existing = this.findEntry(id)
      const saved = entry.queued ? existing || optimistic
        : existing && Number(existing.version) > Number(entry.version) ? existing : present(entry)
      const next = { ...current, entries: [saved, ...current.entries.filter((row) => row.id !== id)],
        favorites: saved.favorite ? [saved, ...current.favorites.filter((row) => row.id !== id)] : current.favorites.filter((row) => row.id !== id) }
      cache.write(cache.KEYS.journal, next)
      this.setData(this.overlaySupplementDrafts(next))
      if (entry.queued) {
        this.setData({ offlineCount: cache.read(cache.KEYS.queue, []).length })
        this.setSync('已保存在手机 · 等待可用线路自动补传', 'offline')
      } else {
        this.setSync(entry.organizationStatus === 'organized' ? '原文与整理稿已保存到云端' : '原文已保存到云端，等待后台整理', 'ok', 2200)
      }
      if (api.organizePendingJournals) api.organizePendingJournals().catch(() => {})
      if ((this.draftRevision || 0) === revision && this.data.content === submittedText) {
        // Publish the cleared draft only after the operation is durable.
        cache.write(cache.KEYS.journalDraftState, { content: '', revision: revision + 1, id: '' })
        this.draftRevision = revision + 1
        this.draftId = ''
        this.draftOccurredAt = ''
        this.draftDate = ''
        this.setData({ content: '' })
      }
    } catch (error) {
      if (!this.requestIsCurrent(scope)) return
      this.renderSyncFeedback(null, error)
    } finally {
      if (this.requestIsCurrent(scope)) this.setData({ saving: false })
    }
  },
  async toggleItem(event) {
    const scope = this.currentScope()
    if (!this.requestIsCurrent(scope)) return
    const entryId = event.currentTarget.dataset.entry
    const itemId = event.currentTarget.dataset.item
    const entry = this.findEntry(entryId)
    if (!entry || entry.pending || entry.readonly) return
    const item = entry.checklistItems.find((row) => row.id === itemId)
    if (!item) return
    const done = !item.done
    return this.submitJournalAction('journal.toggleItem', { entryId, itemId, done, baseVersion: entry.version }, `${entryId}:check:${itemId}`)
  },
  async mutateRecord(event) {
    const scope = this.currentScope()
    if (!this.requestIsCurrent(scope)) return
    const { id, action } = event.currentTarget.dataset
    const entry = this.findEntry(id)
    if (!entry || entry.pending) return
    const payload = { id, baseVersion: entry.version, ...(action === 'favorite' ? { favorited: !entry.favorite } : {}) }
    const actionName = action === 'favorite' ? 'capture.setFavorite' : action === 'hide' ? 'capture.hide' : 'capture.restoreHidden'
    return this.submitJournalAction(actionName, payload, `${id}:${action}`)
  },
  async submitJournalAction(action, payload, key) {
    const scope = this.currentScope()
    this.journalActions = this.journalActions || new Map()
    if (this.journalActions.has(key)) return
    const operation = {}
    this.journalActions.set(key, operation)
    this.setSync('正在保存修改', 'syncing')
    try {
      const result = await api.call(action, payload, { queueOnFailure: true })
      if (!this.requestIsCurrent(scope)) return
      // The API projects durable queued fields onto the CURRENT received rows.
      // A page response must never restore its pre-request whole-list snapshot.
      this.applyOverview(cache.read(cache.KEYS.journal, this.currentOverview()), false)
      if (result.queued) this.renderSyncFeedback()
      else this.setSync(this.activeRouteMessage('已保存'), 'ok', 1000)
    } catch (error) {
      if (!this.requestIsCurrent(scope)) return
      this.applyOverview(cache.read(cache.KEYS.journal, this.currentOverview()), false)
      this.setSync(error.message || '修改尚未确认，请重试', 'offline')
    } finally {
      if (this.requestIsCurrent(scope) && this.journalActions.get(key) === operation) this.journalActions.delete(key)
    }
  },
  toggleMarkdown(event) {
    const id = event.currentTarget.dataset.id
    this.setData(this.mapEntryEverywhere(id, (entry) => ({ ...entry, showMarkdown: !entry.showMarkdown })))
  },
  toggleOriginal(event) {
    const id = event.currentTarget.dataset.id
    this.setData(this.mapEntryEverywhere(id, (entry) => ({ ...entry, showOriginal: !entry.showOriginal })))
  },
  async retryOrganization(event) {
    const entryId = event.currentTarget.dataset.id, scope = this.currentScope()
    if (!api.organizePendingJournals) return
    try {
      const result = await api.organizePendingJournals({ entryId, retry: true })
      if (!this.requestIsCurrent(scope)) return
      this.applyOverview(cache.read(cache.KEYS.journal, this.currentOverview()), false)
      if (result?.error) this.setSync(result.error, 'offline')
    } catch (error) { if (this.requestIsCurrent(scope)) this.setSync(error.message || '整理尚未完成，原文已保留', 'offline') }
  },
  toggleBody(event) {
    const id = event.currentTarget.dataset.id
    this.setData(this.mapEntryEverywhere(id, (entry) => ({ ...entry, bodyExpanded: !entry.bodyExpanded })))
  },
  toggleSupplement(event) {
    const id = event.currentTarget.dataset.id
    this.setData(this.mapEntryEverywhere(id, (entry) => ({ ...entry, showSupplement: !entry.showSupplement })))
  },
  onSupplementInput(event) {
    const id = event.currentTarget.dataset.id
    const drafts = this.supplementDrafts || cache.read(cache.KEYS.journalSupplementDraftState, {})
    const previous = drafts[id] || {}
    this.supplementDrafts = { ...drafts, [id]: { id: cache.requestId('journal_supplement'), createdAt: new Date().toISOString(),
      revision: Number(previous.revision || 0) + 1, content: String(event.detail.value || '') } }
    this.setData(this.overlaySupplementDrafts(this.currentOverview()))
    try { cache.write(cache.KEYS.journalSupplementDraftState, this.supplementDrafts) }
    catch (error) { this.renderSyncFeedback(null, error) }
  },
  async saveSupplement(event) {
    const scope = this.currentScope()
    const id = event.currentTarget.dataset.id
    const entry = this.findEntry(id)
    const content = String(entry && entry.supplementText || '')
    if (!entry || !content.trim() || entry.pending || this.supplementSaves && this.supplementSaves.has(id)) return
    const drafts = this.supplementDrafts || cache.read(cache.KEYS.journalSupplementDraftState, {})
    const draft = { ...(drafts[id] || { id: cache.requestId('journal_supplement'), content, revision: 1 }),
      createdAt: drafts[id]?.createdAt || new Date().toISOString() }
    this.supplementDrafts = { ...drafts, [id]: draft }
    this.supplementSaves = this.supplementSaves || new Set()
    this.supplementSaves.add(id)
    const createdAt = draft.createdAt
    this.setData(this.overlaySupplementDrafts(this.currentOverview()))
    this.setSync('正在保存补充原文', 'syncing')
    try {
      // Persist before submission; retries after any later failure retain this ID.
      cache.write(cache.KEYS.journalSupplementDraftState, this.supplementDrafts)
      const updated = await api.call('journal.append', { entryId: id, supplementId: draft.id, content,
        createdAt, baseVersion: entry.version }, { queueOnFailure: true, requestId: draft.id })
      if (!this.requestIsCurrent(scope)) return
      const next = this.mapEntryEverywhere(id, (row) => {
        const base = updated.queued || Number(row.version || 0) > Number(updated.version || 0) ? row : { ...row, ...updated }
        const additions = (row.journalSupplements || []).filter((item) => item.pending)
        if (updated.queued) additions.push({ id: draft.id, content, createdAt, source: 'manual', pending: true })
        const supplements = [...(base.journalSupplements || [])]
        for (const item of additions) if (!supplements.some((saved) => saved.id === item.id)) supplements.push(item)
        return present({ ...base, journalSupplements: supplements }, row.readonly)
      })
      cache.write(cache.KEYS.journal, { ...this.currentOverview(), ...next })
      this.setData(this.overlaySupplementDrafts(next))
      const current = this.supplementDrafts[id]
      if (current && current.id === draft.id && current.revision === draft.revision && current.content === content) {
        const remaining = { ...this.supplementDrafts, [id]: { id: '', revision: draft.revision + 1, content: '' } }
        cache.write(cache.KEYS.journalSupplementDraftState, remaining)
        this.supplementDrafts = remaining
        this.setData(this.mapEntryEverywhere(id, (row) => ({ ...row, supplementText: '', showSupplement: false })))
      }
      this.renderSyncFeedback()
      if (!updated.queued) this.setSync(`${this.activeRouteMessage('已保存')} · 手机可直接使用`, 'ok', 1100)
    } catch (error) {
      if (this.requestIsCurrent(scope)) this.renderSyncFeedback(null, error)
    } finally {
      if (this.requestIsCurrent(scope)) {
        this.supplementSaves.delete(id)
        this.setData(this.overlaySupplementDrafts(this.currentOverview()))
      }
    }
  },
  async handleProposal(event) {
    const scope = this.currentScope()
    if (!this.requestIsCurrent(scope)) return
    const { id, action } = event.currentTarget.dataset
    const item = this.data.proposals.find((row) => row.id === id)
    if (!item || this.data.proposalBusyId || this.data.applyingAll) return
    this.setData({ proposalBusyId: id })
    this.setSync('正在提交选择', 'syncing')
    try {
      const result = await api.call(`proposal.${action}`, proposalResults.selections([item])[0], { queueOnFailure: true })
      if (!this.requestIsCurrent(scope)) return
      if (result.queued) {
        this.setSync('选择尚未获确认，请联网后重试', 'offline')
      } else {
        this.applyProposals(proposalResults.mergeResult(cache.read(cache.KEYS.proposals, []), result))
        const refreshed = await this.refresh({ silent: true, skipCandidateRefresh: true, forceProposals: true })
        if (!this.requestIsCurrent(scope)) return
        const status = proposalResults.feedback(result, this.activeRouteMessage('已保存'))
        this.setSync(refreshed ? status.message : '选择已提交 · 列表更新失败，请刷新', refreshed ? status.tone : 'offline', refreshed && status.tone === 'ok' ? 1000 : 0)
      }
    } catch (error) {
      if (!this.requestIsCurrent(scope)) return
      this.setSync(error.message || '操作尚未确认，请重试', 'offline')
    } finally {
      if (this.requestIsCurrent(scope)) this.setData({ proposalBusyId: '' })
    }
  },
  async applyAllProposals() {
    const scope = this.currentScope()
    if (!this.requestIsCurrent(scope)) return
    if (!this.data.proposals.length || this.data.applyingAll || this.data.proposalBusyId) return
    const selections = proposalResults.selections(this.data.proposals)
    this.setData({ applyingAll: true })
    this.setSync('正在提交全部选择', 'syncing')
    try {
      const result = await api.call('proposal.applyAll', { selections }, { queueOnFailure: true })
      if (!this.requestIsCurrent(scope)) return
      if (result.queued) {
        this.setSync('全部采用尚未获确认，请联网后重试', 'offline')
      } else {
        this.applyProposals(proposalResults.mergeResult(cache.read(cache.KEYS.proposals, []), result))
        const refreshed = await this.refresh({ silent: true, skipCandidateRefresh: true, forceProposals: true })
        if (!this.requestIsCurrent(scope)) return
        const status = proposalResults.feedback(result, this.activeRouteMessage('全部采用已保存'))
        this.setSync(refreshed ? status.message : '选择已提交 · 列表更新失败，请刷新', refreshed ? status.tone : 'offline', refreshed && status.tone === 'ok' ? 1200 : 0)
      }
    } catch (error) {
      if (!this.requestIsCurrent(scope)) return
      this.setSync(error.message || '全部采用尚未确认，请重试', 'offline')
    } finally {
      if (this.requestIsCurrent(scope)) this.setData({ applyingAll: false })
    }
  },
  openProposalDetails() { wx.navigateTo({ url: '/pages/inbox/index' }) },
  importFile() {
    const scope = this.currentScope()
    const revision = this.draftRevision || 0
    wx.chooseMessageFile({ count: 1, type: 'file', success: ({ tempFiles }) => {
      if (!this.requestIsCurrent(scope)) return
      const file = tempFiles && tempFiles[0]
      if (!file) return
      if (file.size > 2 * 1024 * 1024) return wx.showToast({ title: '文件不能超过 2MB', icon: 'none' })
      if (!/\.(txt|md|markdown)$/i.test(file.name || '')) return wx.showToast({ title: '支持 TXT 和 Markdown', icon: 'none' })
      wx.getFileSystemManager().readFile({ filePath: file.path, encoding: 'utf8', success: ({ data }) => {
        if (!this.requestIsCurrent(scope)) return
        const imported = `【${file.name}】\n${String(data || '')}`
        const content = (this.draftRevision || 0) === revision ? imported : [this.data.content, imported].filter(Boolean).join('\n\n')
        this.onInput({ detail: { value: content } })
      }, fail: () => { if (this.requestIsCurrent(scope)) wx.showToast({ title: '读取文件失败', icon: 'none' }) } })
    } })
  }
})
