const api = require('../../utils/api')
const cache = require('../../utils/cache')

function dateLabel(value) {
  const date = new Date(value || '')
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function normalizedText(value) {
  return String(value || '').toLowerCase().replace(/[\s，。！？、；：,.!?;:（）()【】\[\]“”'"…—_-]+/g, '')
}

function titleFromContent(value) {
  const title = String(value || '').replace(/\s+/g, ' ').trim().split(/[。！？；\n]/)[0]
  if (!title) return '未命名笔记'
  return title.length > 22 ? `${title.slice(0, 22)}…` : title
}

function present(entry) {
  const raw = entry.rawContent || entry.content || entry.journalSummary || ''
  const generic = /^(随手记|今日记录|今日笔记|笔记|记录)$/i.test(String(entry.journalTitle || '').trim())
  const displayTitle = generic ? titleFromContent(raw) : (entry.journalTitle || titleFromContent(raw))
  const summary = String(entry.journalSummary || '').trim()
  return {
    ...entry,
    displayTitle,
    displaySummary: normalizedText(summary) && normalizedText(summary) !== normalizedText(displayTitle) ? summary : '',
    archivedLabel: dateLabel(entry.archivedAt || entry.occurredAt || entry.createdAt),
    sourceLabel: entry.source === 'wechat_mp' ? '公众号' : entry.source === 'codex' ? 'Codex' : entry.source === 'desktop' ? '电脑' : '小程序',
    itemCount: (entry.checklistItems || []).length
  }
}

function presentTrash(item) {
  const raw = item.rawContent || item.content || item.description || ''
  return {
    ...item,
    displayTitle: item.displayTitle || item.title || item.journalTitle || titleFromContent(raw),
    typeLabel: item.entityType === 'today_todo' ? '今日待办' : '灵光一现',
    trashedLabel: dateLabel(item.trashedAt),
    expiryLabel: `${item.remainingDays || 1} 天后清除`
  }
}

Page({
  data: { entries: [], trashItems: [], loading: true, status: '', activeSection: 'archive' },
  onLoad() { this.unloaded = false; this.pageScope = this.currentScope(); this.unsubscribeSync = getApp().subscribeSync(() => this.refresh(true)) },
  onUnload() {
    this.unloaded = true
    if (this.unsubscribeSync) this.unsubscribeSync()
    if (this.statusTimer) clearTimeout(this.statusTimer)
  },
  onShow() {
    const scope = this.currentScope()
    if (this.pageScope !== undefined && this.pageScope !== scope) {
      if (this.statusTimer) clearTimeout(this.statusTimer)
      this.setData({ entries: [], trashItems: [], loading: true, status: '' })
    }
    this.pageScope = scope
    const cached = cache.read(cache.KEYS.journalArchive, [])
    const cachedTrash = cache.read(cache.KEYS.trash, [])
    if (!this.data.entries.length) this.setData({ entries: cached.map(present), loading: false })
    if (!this.data.trashItems.length) this.setData({ trashItems: cachedTrash.map(presentTrash), loading: false })
    this.setData({ loading: false })
  },
  currentScope() { return cache.scopeToken ? cache.scopeToken() : '' },
  requestIsCurrent(scope) { return !this.unloaded && scope === this.currentScope() && (this.pageScope === undefined || this.pageScope === scope) },
  async refresh(silent = false) {
    const scope = this.currentScope()
    if (!silent) this.setData({ loading: !this.data.entries.length })
    try {
      const [archiveData, trashData] = await Promise.all([
        api.call('journal.listArchive'),
        api.call('trash.list')
      ])
      if (!this.requestIsCurrent(scope)) return
      const entries = archiveData.entries || []
      const trashItems = trashData.items || []
      cache.write(cache.KEYS.journalArchive, entries)
      cache.write(cache.KEYS.trash, trashItems)
      this.setData({ entries: entries.map(present), trashItems: trashItems.map(presentTrash), loading: false, status: '' })
    } catch (error) {
      if (!this.requestIsCurrent(scope)) return
      this.setData({ loading: false, status: '暂时无法更新归档，当前显示本地内容' })
    }
  },
  switchSection(event) {
    this.setData({ activeSection: event.currentTarget.dataset.section })
  },
  async restoreEntry(event) {
    const scope = this.currentScope()
    const id = event.currentTarget.dataset.id
    const entry = this.data.entries.find((item) => item.id === id)
    if (!entry) return
    const before = this.data.entries
    this.setData({ entries: before.filter((item) => item.id !== id), status: '恢复中…' })
    try {
      await api.call('journal.restore', { entryId: id, baseVersion: entry.version })
      if (!this.requestIsCurrent(scope)) return
      cache.write(cache.KEYS.journalArchive, this.data.entries)
      this.setData({ status: '已恢复到今天' })
      this.statusTimer = setTimeout(() => { if (this.requestIsCurrent(scope)) this.setData({ status: '' }) }, 1100)
    } catch (error) {
      if (!this.requestIsCurrent(scope)) return
      this.setData({ entries: before, status: error.message || '恢复失败' })
    }
  },
  async deleteEntry(event) {
    const scope = this.currentScope()
    const id = event.currentTarget.dataset.id
    const entry = this.data.entries.find((item) => item.id === id)
    if (!entry) return
    const before = this.data.entries
    const next = before.filter((item) => item.id !== id)
    this.setData({ entries: next, status: '已移到垃圾箱，正在云端保存' })
    try {
      await api.call('journal.delete', { entryId: id, baseVersion: entry.version })
      if (!this.requestIsCurrent(scope)) return
      cache.write(cache.KEYS.journalArchive, next)
      await this.refresh(true)
      this.setData({ status: '已移到垃圾箱，可在 15 天内恢复' })
      this.statusTimer = setTimeout(() => { if (this.requestIsCurrent(scope)) this.setData({ status: '' }) }, 1400)
    } catch (error) {
      if (!this.requestIsCurrent(scope)) return
      this.setData({ entries: before, status: error.message || '移动失败' })
    }
  },
  async restoreTrash(event) {
    const scope = this.currentScope()
    const { id, entityType, version } = event.currentTarget.dataset
    const before = this.data.trashItems
    const item = before.find((row) => row.id === id)
    this.setData({ trashItems: before.filter((item) => item.id !== id), status: '正在恢复…' })
    try {
      const data = await api.call('trash.restore', { id, entityType, baseVersion: version, expectedTrashedAt: item && item.trashedAt })
      if (!this.requestIsCurrent(scope)) return
      const trashItems = data.items || []
      cache.write(cache.KEYS.trash, trashItems)
      this.setData({ trashItems: trashItems.map(presentTrash), status: entityType === 'today_todo' ? '已恢复到今日待办' : '已恢复到数据档案' })
      await this.refresh(true)
      this.statusTimer = setTimeout(() => { if (this.requestIsCurrent(scope)) this.setData({ status: '' }) }, 1400)
    } catch (error) {
      if (!this.requestIsCurrent(scope)) return
      this.setData({ trashItems: before, status: error.message || '恢复失败' })
    }
  }
})
