const api = require('../../utils/api')
const cache = require('../../utils/cache')
Component({
  properties: { todoId: String, attachments: Array, scope: String, compact: Boolean },
  data: { photos: [] },
  observers: { 'todoId, attachments, scope'() { if (this.active) this.refresh() } },
  lifetimes: {
    attached() { this.active = true; this.renewed = new Set(); this.refresh() },
    detached() { this.active = false; this.epoch = (this.epoch || 0) + 1 }
  },
  pageLifetimes: {
    hide() { this.active = false; this.epoch = (this.epoch || 0) + 1 },
    show() { this.active = true; this.refresh() }
  },
  methods: {
    current() { return this.active && this.properties.scope === cache.scopeToken() },
    async refresh(forceId = '') {
      const epoch = this.epoch = (this.epoch || 0) + 1
      if (!this.current()) { this.setData({ photos: [] }); return }
      const scope = this.properties.scope, todoId = this.properties.todoId
      const attachments = (this.properties.attachments || []).filter((item) => !item.deletedAt)
      const signature = JSON.stringify([scope, todoId, attachments.map((item) => [item.id, item.fileID])])
      const changed = signature !== this.signature
      if (changed) { this.signature = signature; this.renewed = new Set() }
      const before = new Map(changed ? [] : this.data.photos.map((item) => [item.id, item]))
      this.setData({ photos: attachments.map((item, index) => ({ ...item, key: item.id || 'missing-' + index,
        url: before.get(item.id)?.url || '', error: '', loading: true })) })
      try {
        const resolved = forceId
          ? await Promise.all(attachments.map(async (item) => (await api.loadAttachmentPreviews(todoId, [item], { force: item.id === forceId }))[0]))
          : await api.loadAttachmentPreviews(todoId, attachments)
        if (!this.current() || this.properties.scope !== scope || this.epoch !== epoch) return
        this.setData({ photos: resolved.filter(Boolean).map((item, index) => ({ ...item, key: item.id || 'missing-' + index, loading: false })) })
      } catch (error) {
        if (this.current() && this.properties.scope === scope && this.epoch === epoch) {
          this.setData({ photos: attachments.map((item, index) => ({ ...item, key: item.id || 'missing-' + index,
            url: '', error: error.message || '图片暂时无法读取，点按重试', loading: false })) })
        }
      }
    },
    imageError(event) {
      if (!this.current()) return
      const id = event.currentTarget.dataset.id
      const item = this.data.photos.find((photo) => photo.id === id)
      if (!item) return
      if (item.fileID && !this.renewed.has(id)) { this.renewed.add(id); return this.refresh(id) }
      this.setData({ photos: this.data.photos.map((photo) => photo.id === id
        ? { ...photo, url: '', loading: false, error: '图片未能加载，点按重试' } : photo) })
    },
    retry(event) {
      if (!this.current()) return
      const id = event.currentTarget.dataset.id
      this.renewed.add(id)
      return this.refresh(id)
    },
    async preview(event) {
      if (!this.current()) return
      const id = event.currentTarget.dataset.id
      const scope = this.properties.scope, todoId = this.properties.todoId
      const refresh = this.refresh(), epoch = this.epoch
      const stillCurrent = () => this.current() && this.properties.scope === scope && this.properties.todoId === todoId && this.epoch === epoch
      await refresh
      if (!stillCurrent()) return
      const current = this.data.photos.find((photo) => photo.id === id)?.url
      const urls = this.data.photos.map((photo) => photo.url).filter(Boolean)
      if (current && urls.length) wx.previewImage({ current, urls, fail: () => { if (stillCurrent()) this.imageError(event) } })
    }
  }
})
