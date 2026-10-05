// A foreground, event-driven worker. Cloud manifests own model progress; this
// scoped local checkpoint only tracks scheduling and ambiguous request waits.
// There are no polling timers and no dependency on a page remaining open.
function createOrganizationCoordinator({ cache, request, isVisible, notify = () => {}, now = Date.now,
  capability = 'diaryOrganization', identity = 'date', eventType = 'diary-organization',
  records = () => cache.read(cache.KEYS.diaryDays, []), idOf = (day) => day.date,
  revisionOf = (day) => String(day.inputRevision || JSON.stringify((day.manualInputs || []).map(({ id, content }) => [id, content]))),
  hasSource = (day) => (day.manualInputs || []).length,
  emptyRecord = (date) => ({ date, manualInputs: [] }),
  eligible = (day) => day && day.organizationHost !== 'desktop' && !day.deletedAt && !day.trashedAt && !(day.manualInputs || []).some((input) => input.pending) &&
    !cache.read(cache.KEYS.queue, []).some((item) => String(item.action || '').startsWith('diary.') && item.payload && item.payload.date === day.date)
}) {
  const workers = new Map()
  const scopeToken = () => cache.scopeToken ? cache.scopeToken() : ''
  const key = cache.KEYS[capability]
  function save(date, value) {
    cache.write(key, { ...cache.read(key, {}), [date]: value })
  }
  async function drain(worker, scope) {
    const current = () => scope === scopeToken()
    let last = { skipped: 'idle' }
    const visited = new Set()
    while (current() && isVisible()) {
      const days = records()
      const explicit = [...worker.requested][0]
      const candidate = explicit ? days.find((day) => idOf(day) === explicit) || emptyRecord(explicit) : days.find((day) => {
        if (!eligible(day) || visited.has(idOf(day)) || !hasSource(day) || !['pending', 'failed'].includes(day.organizationStatus)) return false
        const state = cache.read(key, {})[idOf(day)]
        return !state || state.revision !== revisionOf(day) || state.status !== 'complete' && !state.blocked && Number(state.retryAfter || 0) <= now()
      })
      if (!candidate) break
      const date = idOf(candidate)
      if (!eligible(candidate)) { visited.add(date); worker.requested.delete(date); continue }
      const revision = revisionOf(candidate)
      const previous = cache.read(key, {})[date]
      const retry = worker.retries.delete(date)
      worker.requested.delete(date)
      if (!retry && previous && previous.revision === revision && (previous.blocked || Number(previous.retryAfter || 0) > now())) {
        visited.add(date); continue
      }
      // Persist before dispatch: a suspended process cannot immediately start
      // another provider call whose preceding response may still be in flight.
      save(date, { ...(previous && previous.revision === revision ? previous : {}), revision, status: 'running', error: '', blocked: false, retryAfter: now() + 120000 })
      notify({ type: eventType, [identity]: date, scopeToken: scope })
      try {
        const result = await request({ [identity]: date, retry })
        if (!current()) return { cancelled: true }
        const job = result && result.organizationJob
        if (!job) throw Object.assign(new Error(result && result.day && result.day.aiError || '云端未返回可续接的整理进度，原文已保留'), { code: 'ORGANIZATION_PROGRESS_ERROR', retryable: false })
        const stalled = job.status === 'pending' && previous && previous.jobId === job.id &&
          Number(previous.generation || 0) === Number(job.generation || 0) && Number(job.completed) <= Number(previous.completed)
        const wait = job.status === 'running' || stalled
        save(date, { revision, jobId: job.id, status: result.stale ? 'pending' : job.status, completed: Number(job.completed || 0), total: Number(job.total || 0),
          reviewId: job.reviewId || '', reviewHost: job.reviewHost || '',
          generation: Number(job.generation || 0),
          error: job.error || '', blocked: job.retryable === false || job.automaticRetry === false,
          retryAfter: Number(job.retryAfter || 0) || (wait ? now() + 120000 : 0) })
        last = { ...result, [identity]: date }
        notify({ type: eventType, [identity]: date, result, scopeToken: scope })
        // A new original is handled on the next iteration. The server binds
        // commits to its input version; stale results never become current.
        const latest = records().find((day) => idOf(day) === date)
        const newerOriginal = latest && revisionOf(latest) !== revision
        if (!newerOriginal && (job.status !== 'pending' || stalled || result.stale)) visited.add(date)
      } catch (error) {
        if (!current()) return { cancelled: true }
        const failure = { revision, status: 'failed', error: String(error.message || '整理暂时失败，原文已保留'),
          blocked: error.retryable === false, retryAfter: now() + 120000 }
        save(date, failure)
        last = { [identity]: date, error: failure.error, organizationPending: true }
        notify({ type: eventType, [identity]: date, result: last, scopeToken: scope })
        visited.add(date)
      }
    }
    return last
  }
  function resume(options = {}) {
    const date = options[identity], retry = options.retry === true
    const bootstrap = cache.read(cache.KEYS.bootstrap, {}) || {}
    if (Number(bootstrap.capabilities && bootstrap.capabilities[capability] || 0) < 1) {
      return Promise.resolve({ skipped: 'unsupported', error: date ? '云端整理接口尚未升级，原文已保留' : '' })
    }
    if (!isVisible()) return Promise.resolve({ skipped: 'background' })
    const scope = scopeToken()
    let worker = workers.get(scope)
    if (worker) {
      if (date) { worker.requested.add(date); if (retry) worker.retries.add(date) }
      return worker.promise
    }
    worker = { requested: new Set(date ? [date] : []), retries: new Set(date && retry ? [date] : []) }
    // Register before the async drain starts, including synchronous mocks.
    workers.set(scope, worker)
    worker.promise = Promise.resolve().then(() => drain(worker, scope)).finally(() => { if (workers.get(scope) === worker) workers.delete(scope) })
    return worker.promise
  }
  return { resume }
}

module.exports = { createOrganizationCoordinator }
