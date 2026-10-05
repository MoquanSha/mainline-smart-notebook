const api = require('../../utils/api')
const cache = require('../../utils/cache')
Component({
  properties: { job: { type: Object, value: null }, scope: String, kind: String, entryId: String, date: String },
  data: { opened: false, loading: false, review: null, error: '', findingText: [] },
  observers: { 'job.reviewId, scope'() { this.resetReview() } },
  lifetimes: {
    attached() { this.detached = false },
    detached() { this.detached = true; this.reviewEpoch = (this.reviewEpoch || 0) + 1 }
  },
  pageLifetimes: { hide() { this.resetReview() } },
  methods: {
    resetReview() {
      this.reviewEpoch = (this.reviewEpoch || 0) + 1
      if (!this.detached) this.setData({ opened: false, loading: false, review: null, error: '', findingText: [] })
    },
    toggle() {
      if (this.data.opened) { this.resetReview(); return }
      this.setData({ opened: true }); return this.loadReview(0)
    },
    previous() { return this.loadReview(this.data.review.index - 1) },
    next() { return this.loadReview(this.data.review.index + 1) },
    reload() { return this.loadReview(this.data.review ? this.data.review.index : 0) },
    async loadReview(index) {
      const scope = cache.scopeToken(), job = this.properties.job
      if (!job?.reviewId || job.reviewHost !== 'cloud' || this.properties.scope !== scope) { this.resetReview(); return }
      const epoch = this.reviewEpoch = (this.reviewEpoch || 0) + 1
      const current = () => !this.detached && this.reviewEpoch === epoch && scope === cache.scopeToken() && this.properties.scope === scope
      this.setData({ loading: true, error: '' })
      try {
        const review = await api.readOrganizationReview({ kind: this.properties.kind, entryId: this.properties.entryId,
          date: this.properties.date, index, expectedReviewId: job.reviewId })
        if (!current()) return
        const findingText = review.findings.map((finding) => finding.label + (finding.changes
          ? '涉及 ' + finding.changes.slice(0, 12).map((change) => `${change.value}（原文 ${change.originalCount} 次，候选稿 ${change.candidateCount} 次）`).join('、')
          : `出现次数从 ${finding.originalCount} 变为 ${finding.candidateCount}`))
        this.setData({ review, findingText, assembled: String(review.checkedScope).startsWith('assembled') })
      } catch (error) {
        if (current()) this.setData({ error: error.message || '检查记录读取失败，原文仍保留' })
      } finally { if (current()) this.setData({ loading: false }) }
    }
  }
})
