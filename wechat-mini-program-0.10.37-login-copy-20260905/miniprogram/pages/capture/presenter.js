const { parseMarkdown, journalBody } = require('../../utils/markdown')
function sourceLabel(source) {
  return source === 'wechat_mp' ? '公众号' : source === 'wecom' ? '企业微信' : source === 'codex' ? 'Codex' : source === 'desktop' ? '电脑' : '小程序'
}

function timeLabel(value) {
  const date = new Date(value || '')
  if (Number.isNaN(date.getTime())) return ''
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function dateLabel(value) {
  const parts = String(value || '').split('-')
  return parts.length === 3 ? `${parseInt(parts[1], 10)}月${parseInt(parts[2], 10)}日` : String(value || '')
}

function normalizedText(value) {
  return String(value || '').toLowerCase().replace(/[\s，。！？、；：,.!?;:（）()【】\[\]“”'"…—_\-*#>`]+/g, '')
}

function plainMarkdown(value) {
  return String(value || '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-*+] |\d+[.)]\s+)/gm, '')
    .replace(/^\s*\[[ xX]\]\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
}

function titleFromContent(value) {
  let title = plainMarkdown(value).replace(/\s+/g, ' ').trim().split(/[。！？；\n]/)[0]
  title = title
    .replace(/^(?:今天|今日|现在|刚刚)?\s*(?:我)?\s*(?:想|要|需要|打算|计划|准备|记一下|记录一下)\s*/, '')
    .replace(/^(?:你|我)?(?:把|将|给我|帮我|觉得|希望|要求|需要)\s*/, '')
    .replace(/^(?:这个|这里|然后|此外|而且|其实|就是|如果|那么)+\s*/, '')
    .trim()
  if (!title) return '未命名笔记'
  return title.length > 22 ? `${title.slice(0, 22)}…` : title
}

const markdownBlocks = parseMarkdown

function normalizeChecklist(items) {
  return (items || []).map((item, index) => ({
    ...item,
    id: item.id || `check-${index + 1}`,
    text: String(item.text || item.content || '').trim(),
    done: item.done !== undefined ? Boolean(item.done) : Boolean(item.checked)
  })).filter((item) => item.text)
}

function present(entry = {}, readonly = false) {
  const items = normalizeChecklist(entry.checklistItems)
  const doneCount = items.filter((item) => item.done).length
  const raw = String(entry.rawContent || entry.content || '').trim()
  const organized = String(entry.organizedContent || entry.journalSummary || entry.organizationSummary || raw).trim()
  const originalTitle = String(entry.journalTitle || '').trim()
  const generic = /^(随手记|今日记录|今日笔记|笔记|记录|灵光一现)$/i.test(originalTitle)
  const titleRepeatsBody = Boolean(originalTitle && organized && normalizedText(originalTitle) === normalizedText(organized))
  const repairTitle = !originalTitle || generic || originalTitle.length > 30 || (titleRepeatsBody && organized.length > 22)
  const displayTitle = repairTitle ? titleFromContent(organized || raw) : originalTitle
  const summaryCandidates = [entry.organizedContent, entry.journalSummary, entry.organizationSummary, raw]
  let displaySummary = ''
  for (const candidate of summaryCandidates) {
    const value = String(candidate || '').trim()
    if (!value) continue
    if (normalizedText(value) !== normalizedText(displayTitle) || repairTitle) {
      displaySummary = plainMarkdown(value)
      break
    }
  }
  if (!repairTitle && normalizedText(displaySummary) === normalizedText(displayTitle)) displaySummary = ''
  const markdown = String(entry.markdown || '').trim()
  const bodyMarkdown = journalBody(entry)
  const bodyNodes = parseMarkdown(bodyMarkdown)
  const supplements = (entry.journalSupplements || []).filter((item) => !item.deletedAt && !item.trashedAt).map((item, index) => ({
    ...item,
    id: item.id || `supplement-${index + 1}`,
    content: String(item.content || '').trim(),
    bodyNodes: parseMarkdown(item.content || ''),
    createdLabel: timeLabel(item.createdAt)
  })).filter((item) => item.content)
  const job = entry.organizationJob || {}
  const organizationFailed = job.status === 'failed' || entry.organizationStatus === 'failed' || Boolean(job.blocked)
  const organizationPending = !organizationFailed && (['pending', 'running'].includes(job.status) || entry.organizationStatus === 'pending')
  const organizerLabel = entry.pending
    ? '原文待上传'
    : entry.organizationHost === 'desktop' && (organizationPending || organizationFailed) ? '原文已保存 · 请在电脑继续整理'
    : organizationFailed ? '整理暂停 · 原文已保留'
    : organizationPending ? `原文已保存 · 整理中${job.total ? ` ${job.completed || 0}/${job.total}` : ''}`
    : entry.organizedBy === 'deepseek'
      ? 'DeepSeek 已整理'
      : entry.organizedBy === 'rules'
        ? '规则兜底'
        : ''
  return {
    ...entry,
    sourceLabel: sourceLabel(entry.source),
    originalContent: String(entry.rawContent ?? entry.content ?? ''),
    organizationFailed,
    organizationCanRetry: organizationFailed && entry.organizationHost !== 'desktop' && job.retryable !== false,
    organizationError: job.error || entry.aiError || '',
    organizerLabel,
    syncLabel: entry.syncBlocked ? '修改待处理' : entry.syncPending && !entry.pending ? '修改待上传' : '',
    organizerTone: entry.organizedBy === 'deepseek' ? 'ai' : entry.organizedBy === 'rules' ? 'fallback' : 'pending',
    createdLabel: timeLabel(entry.occurredAt || entry.createdAt),
    typeLabel: items.length ? '清单' : entry.journalType === 'plan' ? '计划' : '笔记',
    displayTitle,
    displaySummary,
    bodyNodes,
    showBody: Boolean(bodyMarkdown.trim() && (repairTitle || normalizedText(plainMarkdown(bodyMarkdown)) !== normalizedText(displayTitle) || bodyMarkdown.length > 60)),
    summaryLong: bodyMarkdown.length > 220 || bodyMarkdown.split('\n').length > 5,
    bodyExpanded: Boolean(entry.bodyExpanded),
    checklistItems: items,
    supplements,
    markdown,
    doneCount,
    itemCount: items.length,
    complete: Boolean(items.length && doneCount === items.length),
    favorite: Boolean(entry.favoritedAt),
    hidden: Boolean(entry.hiddenAt),
    readonly,
    showMarkdown: Boolean(entry.showMarkdown),
    showSupplement: Boolean(entry.showSupplement),
    supplementText: entry.supplementText || ''
  }
}

function presentReview(item = {}) {
  const date = String(item.date || item.dayKey || item.recordDate || item.createdAt || '').slice(0, 10)
  const headline = String(item.headline || item.title || item.dailyTitle || '').trim()
  const summary = String(item.summary || item.dailySummary || item.review || item.content || '').trim()
  const reflection = String(item.reflection || item.nextStep || item.carryOver || '').trim()
  return {
    ...item,
    id: item.id || date,
    date,
    dateLabel: dateLabel(date),
    headline: headline || titleFromContent(summary || reflection),
    summary,
    reflection
  }
}

function presentOverview(data = {}) {
  const hiddenRows = (data.hidden || []).filter((entry) => Boolean(entry && entry.hiddenAt))
  const hiddenIds = new Set(hiddenRows.map((entry) => String(entry.id || entry._id || '')).filter(Boolean))
  const visible = (entry) => entry && !entry.hiddenAt && !hiddenIds.has(String(entry.id || entry._id || ''))
  const history = (data.history || []).map((group) => ({
    ...group,
    dateLabel: dateLabel(group.date),
    entries: (group.entries || []).filter(visible).map((entry) => present(entry, true)),
    favoriteCount: (group.entries || []).filter((entry) => visible(entry) && Boolean(entry.favoritedAt)).length
  })).filter((group) => group.entries.length)
  const reviews = (data.reviews || data.dailyReviews || [])
    .map((item) => presentReview(item))
    .filter((item) => item.date && (item.summary || item.headline || item.reflection))
    .sort((left, right) => right.date.localeCompare(left.date))
  return {
    entries: (data.entries || []).filter(visible).map((entry) => present(entry)),
    favorites: (data.favorites || []).filter(visible).map((entry) => present(entry)),
    hidden: hiddenRows.map((entry) => present(entry)),
    history,
    historyCount: history.reduce((total, group) => total + group.entries.length, 0),
    reviews,
    reviewCount: reviews.length
  }
}

function localEntry(id, content, occurredAt, favorite) {
  return present({
    id, occurredAt, source: 'manual', version: 1, pending: true,
    rawContent: content, content, journalTitle: titleFromContent(content), journalSummary: content,
    journalType: 'note', checklistItems: [], markdown: '',
    favoritedAt: favorite ? occurredAt : '', hiddenAt: ''
  })
}

module.exports = {
  dateLabel,
  markdownBlocks,
  normalizedText,
  plainMarkdown,
  present,
  presentOverview,
  sourceLabel,
  timeLabel,
  titleFromContent,
  localEntry
}
