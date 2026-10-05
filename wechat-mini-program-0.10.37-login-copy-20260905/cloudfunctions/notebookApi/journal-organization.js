'use strict'
const crypto = require('crypto')
const fidelity = require('./fidelity')
const segments = require('./text-segments')
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const source = (row) => String(row.rawContent ?? row.content ?? '')
const dataOf = (result) => Array.isArray(result?.data) ? result.data[0] : result?.data

function createJournalOrganization({ db, jobs, load, generate, withSupplements, assertCapacity, promptVersion }) {
  const projection = (entry) => hash([entry.journalTitle, entry.journalSummary, entry.organizedContent,
    withSupplements(entry, entry.checklistItems || [], []), entry.checklistItems || []])
  async function step(owner, payload, options = {}) {
    const entry = await load(owner, payload.entryId)
    // A desktop's durable worker owns this projection. Reading its uploaded
    // original on a phone must not launch a second model job for the same body.
    if (entry.organizationHost === 'desktop') throw Object.assign(new Error('这条记录由电脑整理，原文已保存；请在电脑继续或重试整理'), { code: 'ORGANIZATION_DESKTOP', retryable: false })
    const raw = source(entry), originalHash = hash(raw), before = projection(entry)
    const parts = segments.splitText(raw)
    let result, job
    try {
      result = await jobs.run({ owner, targetId: entry.id, kind: 'journal_entry', promptVersion: hash([promptVersion, fidelity.POLICY, segments.POLICY]),
        parts, retry: payload.retry === true, maxParts: options.maxParts || 1,
        countsAsAiCall: (part) => !part.literal,
        validateOutput: (outputs) => fidelity.assertFidelity(raw, segments.joinText(parts, outputs.map((output) => output.markdown)),
          { aggregate: true, candidateForReview: outputs.at(-1).markdown }),
        generate: async (part) => {
          if (part.literal) return { title: '', summary: '', markdown: part.content, items: [], type: 'note', literal: true }
          const output = await generate(part)
          if (!output || typeof output.markdown !== 'string' || !output.markdown.trim()) {
            throw new Error('AI 未返回完整 Markdown 整理稿，原文已保留')
          }
          fidelity.assertFidelity(part.content, output.markdown)
          // Titles and summaries are metadata. The reading body is always the
          // full Markdown field; no array or character limit silently slices it.
          return { title: String(output.title || '').trim(), summary: String(output.summary || ''),
            markdown: output.markdown, type: ['checklist', 'plan', 'note'].includes(output.type) ? output.type : 'note',
            items: (Array.isArray(output.items) ? output.items : []).map((item, index) => {
              const text = String(typeof item === 'string' ? item : item?.text || '')
              return { id: 'journal_item_' + hash([entry.id, originalHash, part.index, index, text]).slice(0, 40),
                text, done: Boolean(item && typeof item === 'object' && item.done), createdAt: entry.createdAt,
                completedAt: item?.done ? entry.createdAt : '' }
            }).filter((item) => item.text.trim()), needsConfirmation: Boolean(output.needsConfirmation) }
        } })
      job = { id: result.job.id, status: result.job.status, completed: result.job.completed, total: result.job.partCount,
        reviewId: result.job.reviewId || '', reviewHost: 'cloud',
        generation: Number(result.job.outputGeneration || 0),
        automaticRetry: result.job.automaticRetry !== false, errorCode: result.job.errorCode || '',
        error: result.job.error || '', retryable: !['AI_OUTPUT_CAPACITY', 'JOB_RECEIPT_MISSING'].includes(result.job.errorCode),
        retryAfter: result.job.status === 'running' ? result.job.leaseUntil : result.job.retryAfter || 0 }
    } catch (error) {
      job = { status: 'failed', completed: 0, total: parts.length, error: String(error.message || error).slice(0, 300),
        retryable: !['JOB_RECEIPT_MISSING', 'AI_OUTPUT_CAPACITY'].includes(error.code), retryAfter: Date.now() + 120000 }
    }
    if (result?.busy || result?.stale || job.status === 'pending' || job.status === 'running') {
      return { entry: await load(owner, entry.id), organizationJob: job, organizationPending: true,
        stale: Boolean(result?.stale), changed: false }
    }
    return db.runTransaction(async (tx) => {
      const ref = tx.collection('captures').doc(entry.id)
      const current = dataOf(await ref.get())
      if (!current || current.ownerOpenId !== owner) throw Object.assign(new Error('记录不属于当前工作区'), { code: 'FORBIDDEN' })
      if (current.deletedAt || current.trashedAt || current.permanentlyPurgedAt || hash(source(current)) !== originalHash || projection(current) !== before) {
        return { entry: current, stale: true, changed: false, organizationJob: { ...job, retryable: false,
          error: '记录已更新或删除，旧整理结果未写入；请核对原文后重试' } }
      }
      // The job is a projection of a source revision, not a command to reset
      // all later user edits every time a completed response is replayed.
      if (job.status === 'complete' && current.organizationJob?.id === job.id &&
          current.organizationJob.status === 'complete' && current.organizationInputHash === originalHash) {
        return { entry: current, organizationJob: job, changed: false }
      }
      const patch = { organizationJob: job, organizationStatus: job.status === 'complete' ? 'organized' : 'failed',
        aiError: job.error || '' }
      if (job.status === 'complete') {
        const outputs = result.outputs, markdown = segments.joinText(parts, outputs.map((part) => part.markdown))
        const items = outputs.flatMap((part) => part.items)
        Object.assign(patch, { status: 'processed', organizedBy: outputs.some((part) => !part.literal) ? 'deepseek' : 'rules', organizationInputHash: originalHash,
          journalTitle: outputs[0].title || current.journalTitle,
          journalSummary: outputs.map((part) => part.summary).filter(Boolean).join('\n\n'),
          organizedContent: markdown, checklistItems: items,
          journalType: items.length ? 'checklist' : outputs.some((part) => part.type === 'plan') ? 'plan' : 'note',
          markdown: withSupplements({ ...current, markdown, journalSupplements: [] }, items, current.journalSupplements || []),
          needsConfirmation: outputs.some((part) => part.needsConfirmation) })
      }
      if (Object.entries(patch).every(([key, value]) => JSON.stringify(current[key]) === JSON.stringify(value))) {
        return { entry: current, organizationJob: job, changed: false }
      }
      const { _id, ...next } = { ...current, ...patch, updatedAt: new Date().toISOString(), version: Number(current.version || 1) + 1 }
      assertCapacity(next)
      await ref.set(next)
      return { entry: next, organizationJob: job, changed: true }
    })
  }
  return { step }
}
module.exports = { createJournalOrganization }
