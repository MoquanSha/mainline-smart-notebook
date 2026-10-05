'use strict'

const crypto = require('crypto')
const dataOf = (result) => Array.isArray(result?.data) ? result.data[0] : result?.data
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const problem = (code, message) => Object.assign(new Error(message), { code })
const originalText = (part) => typeof part === 'string' ? part : String(part?.content ?? (part?.manualInputs || []).map((input) => input.content || '').join('\n\n'))
const outputText = (output) => typeof output === 'string' ? output : String(output?.markdown ?? output?.daySummary ?? output?.content ?? '')

// Model calls run outside transactions. A small manifest and immutable per-part
// receipts allow another invocation to resume after the worker process dies.
function createOrganizationJobs({ db, now = Date.now, leaseMs = 120000,
  token = () => crypto.randomBytes(16).toString('hex') }) {
  const read = async (database, id) => dataOf(await database.collection('ai_runs').doc(id).get())
  const partId = (id, index, generation = 0) => `${id}${generation ? '_g_' + generation : ''}_part_${index}`
  const stamp = () => new Date(now()).toISOString()
  async function write(tx, value, patch) {
    const next = { ...value, ...patch, updatedAt: stamp(), version: Number(value.version || 0) + 1 }
    const { _id, ...document } = next
    await tx.collection('ai_runs').doc(value.id).set(document)
    return document
  }
  function requireLease(job, lease) {
    if (!job || job.status !== 'running' || job.leaseToken !== lease || Number(job.leaseUntil) <= now()) {
      throw problem('STALE_JOB', '整理任务已由另一请求接续，旧结果不再写入')
    }
  }
  async function outputs(job, parts) {
    const values = []
    for (let index = 0; index < parts.length; index++) {
      const saved = await read(db, partId(job.id, index, job.outputGeneration))
      if (!saved || saved.ownerOpenId !== job.ownerOpenId || saved.jobId !== job.id || saved.inputHash !== digest(parts[index])) {
        throw problem('JOB_RECEIPT_MISSING', '整理进度与已保存段落不一致，原文已保留，请检查后重试')
      }
      values.push(saved.output)
    }
    return values
  }
  // Read one bounded page on demand. Candidates stay out of notebook sync and
  // the ordinary state response, and opening a review never schedules AI.
  async function reviewPage({ owner, jobId, targetId, kind, index = 0, expectedReviewId = '' }) {
    const job = await read(db, String(jobId || ''))
    if (!owner || !job || job.ownerOpenId !== owner || job.targetId !== targetId || job.kind !== kind) {
      throw problem('FORBIDDEN', '该检查记录不属于当前账号或笔记')
    }
    if (job.status !== 'failed' || !job.reviewId) throw problem('REVIEW_UNAVAILABLE', '这次整理已更新，当前没有可查看的疑点稿')
    if (expectedReviewId && job.reviewId !== expectedReviewId) throw problem('REVIEW_CHANGED', '检查记录已更新，请关闭后重新查看')
    const saved = await read(db, job.reviewId)
    if (!saved || saved.ownerOpenId !== owner || saved.jobId !== job.id || saved.outputGeneration !== Number(job.outputGeneration || 0)) {
      throw problem('REVIEW_UNAVAILABLE', '检查记录不完整，原文仍保留在笔记中')
    }
    const review = saved.review, availableParts = Number(review.partIndex) + 1
    if (!Number.isInteger(index) || index < 0 || index >= availableParts) throw problem('VALIDATION', '检查段落编号无效')
    let original = saved.original, candidate = review.candidate
    if (index < review.partIndex) {
      const receipt = await read(db, partId(job.id, index, saved.outputGeneration))
      if (!receipt || receipt.ownerOpenId !== owner || receipt.jobId !== job.id || receipt.index !== index) {
        throw problem('REVIEW_UNAVAILABLE', '前面的整理段落不完整，原文仍保留在笔记中')
      }
      original = receipt.original; candidate = outputText(receipt.output)
    }
    return { reviewId: saved.id, index, availableParts, totalParts: job.partCount,
      checkedScope: review.checkedScope || 'segment', findings: review.findings || [],
      original: original ?? '', originalAvailable: typeof original === 'string', candidate,
      failedPartIndex: review.partIndex, createdAt: saved.createdAt }
  }
  async function run({ owner, targetId, kind, promptVersion, parts, generate, maxParts = 1, retry = false,
    validateOutput = () => {}, countsAsAiCall = () => true }) {
    if (!owner || !targetId || !kind || !promptVersion || !Array.isArray(parts) || !parts.length) {
      throw problem('VALIDATION', '整理任务缺少原文或归属信息')
    }
    const signature = digest({ kind, targetId, promptVersion, parts })
    const id = 'organization_job_' + digest([owner, signature]).slice(0, 40)
    const lease = token()
    let aiCalls = 0
    let job = await db.runTransaction(async (tx) => {
      const current = await read(tx, id)
      if (current && (current.ownerOpenId !== owner || current.signature !== signature)) throw problem('FORBIDDEN', '整理任务不属于当前原文或空间')
      if (current?.status === 'complete' || current?.status === 'running' && Number(current.leaseUntil) > now() ||
        current?.status === 'failed' && !retry && (current.automaticRetry === false || Number(current.retryAfter) > now())) return current
      // A worker may die after the provider accepted a request but before the
      // immutable segment receipt was committed. Re-running automatically here
      // can charge the model twice. Mark that call unknown and require an
      // explicit retry; a crashed worker with no provider call can still resume.
      if (current?.status === 'running' && Number(current.leaseUntil) <= now() && current.providerCallStatus === 'in_flight' && !retry) {
        return write(tx, current, { status: 'failed', leaseToken: '', leaseUntil: 0,
          providerCallStatus: 'unknown', errorCode: 'AI_CALL_UNKNOWN',
          error: '模型请求结果未确认，原文已保留；请明确点击重试以避免自动重复计费',
          automaticRetry: false, retryAfter: 0 })
      }
      const base = current || { id, ownerOpenId: owner, workspaceId: owner, taskType: 'organization_job', kind, targetId,
        signature, promptVersion, partCount: parts.length, completed: 0, attempts: 0, providerCallStatus: '', providerRequestId: '', createdAt: stamp(), deletedAt: '', source: 'ai' }
      const restartAssembly = retry && base.status === 'failed' && base.failureStage === 'assembly'
      return write(tx, base, { status: 'running', leaseToken: lease, leaseUntil: now() + leaseMs,
        completed: restartAssembly ? 0 : Number(base.completed || 0),
        outputGeneration: Number(base.outputGeneration || 0) + (restartAssembly ? 1 : 0), failureStage: '',
        attempts: Number(base.attempts || 0) + 1, error: '', errorCode: '', retryAfter: 0, automaticRetry: true,
        providerCallStatus: '', providerRequestId: '', fidelityReview: null, reviewId: '' })
    })
    if (job.status === 'complete') return { job, outputs: await outputs(job, parts), aiCalls, cached: true }
    if (job.leaseToken !== lease) return { job, outputs: [], aiCalls, busy: job.status === 'running' }
    const until = Math.min(parts.length, Number(job.completed || 0) + Math.max(1, Math.min(32, Number(maxParts) || 1)))
    let partIndex = Number(job.completed || 0), validatingAssembly = false
    try {
      for (let index = Number(job.completed || 0); index < until; index++) {
        partIndex = index
        const providerRequestId = `${id}_g_${Number(job.outputGeneration || 0)}_part_${index}_attempt_${Number(job.attempts || 0)}`
        // Record the provider call before leaving the transaction. If this
        // process disappears while generate() is awaiting the model, the next
        // automatic invocation will pause instead of silently charging twice.
        job = await db.runTransaction(async (tx) => {
          const current = await read(tx, id)
          requireLease(current, lease)
          return write(tx, current, { providerCallStatus: 'in_flight', providerRequestId, leaseUntil: now() + leaseMs })
        })
        if (countsAsAiCall(parts[index])) aiCalls++
        // No database lock is held while contacting the model. The stable
        // request id is available to providers that support idempotency keys.
        const output = await generate(parts[index], index, { requestId: providerRequestId, idempotencyKey: providerRequestId })
        if (Buffer.byteLength(JSON.stringify(output), 'utf8') > 150000) throw problem('AI_OUTPUT_CAPACITY', '单段整理结果过长，原文与已完成段落已保留')
        // Validate the assembled body BEFORE the final receipt can commit a
        // complete manifest. Individual segment checks cannot see seams.
        if (index + 1 === parts.length) {
          validatingAssembly = true
          const previous = await outputs(job, parts.slice(0, index))
          await validateOutput([...previous, output], parts)
          validatingAssembly = false
        }
        job = await db.runTransaction(async (tx) => {
          const current = await read(tx, id)
          requireLease(current, lease)
          const key = partId(id, index, current.outputGeneration)
          await tx.collection('ai_runs').doc(key).set({ id: key, jobId: id, ownerOpenId: owner, workspaceId: owner,
            taskType: 'organization_part', index, inputHash: digest(parts[index]), original: originalText(parts[index]), output,
            createdAt: stamp(), updatedAt: stamp(), version: 1, deletedAt: '', source: 'ai' })
          const complete = index + 1 === parts.length
          return write(tx, current, { completed: index + 1, status: complete ? 'complete' : 'running',
            leaseToken: complete ? '' : lease, leaseUntil: complete ? 0 : now() + leaseMs,
            providerCallStatus: '', providerRequestId: '', error: '', failures: 0 })
        })
      }
      if (job.status !== 'complete') {
        job = await db.runTransaction(async (tx) => {
          const current = await read(tx, id)
          requireLease(current, lease)
          return write(tx, current, { status: 'pending', leaseToken: '', leaseUntil: 0 })
        })
      }
    } catch (error) {
      if (error.code === 'STALE_JOB') return { job, outputs: [], aiCalls, stale: true }
      job = await db.runTransaction(async (tx) => {
        const current = await read(tx, id)
        if (current?.leaseToken !== lease) return current
        const fidelityReview = error.code === 'AI_FIDELITY_REVIEW' && error.fidelityReview
          ? { ...error.fidelityReview, partIndex, inputHash: digest(parts[partIndex]) } : null
        let reviewId = ''
        if (fidelityReview) {
          const key = `${id}_g_${Number(current.outputGeneration || 0)}_review_${current.attempts}`
          reviewId = key
          await tx.collection('ai_runs').doc(key).set({ id: key, jobId: id, ownerOpenId: owner, workspaceId: owner,
            taskType: 'organization_review', outputGeneration: Number(current.outputGeneration || 0),
            original: originalText(parts[partIndex]), review: fidelityReview,
            createdAt: stamp(), updatedAt: stamp(), version: 1, deletedAt: '', source: 'ai' })
        }
        return write(tx, current, { status: 'failed', leaseToken: '', leaseUntil: 0,
          providerCallStatus: '', providerRequestId: '',
          failureStage: validatingAssembly ? 'assembly' : 'segment',
          error: String(error.message || error).slice(0, 300), errorCode: error.code || 'AI_FAILED',
          automaticRetry: !['AI_FIDELITY_REVIEW', 'AI_FRAGMENT_STRUCTURE'].includes(error.code), fidelityReview, reviewId,
          failures: Number(current.failures || 0) + 1,
          retryAfter: now() + Math.min(15 * 60 * 1000, 5000 * 2 ** Math.min(Number(current.failures || 0), 7)) })
      })
    }
    return { job, outputs: job.status === 'complete' ? await outputs(job, parts) : [], aiCalls }
  }
  return { run, reviewPage }
}

module.exports = { createOrganizationJobs }
