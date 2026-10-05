const test = require('node:test')
const assert = require('node:assert/strict')
const { cloudRuntime } = require('./helpers/cloud-runtime.cjs')
const { createOrganizationJobs } = require('../cloudfunctions/notebookApi/organization-job')

const input = { owner: 'space-a', targetId: 'day-a', kind: 'diary', promptVersion: 'v1', parts: ['甲', '乙', '丙'] }
function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test('process replacement resumes from durable per-part receipts and completed replay performs no writes or model calls', async () => {
  const runtime = cloudRuntime(), calls = []
  const generate = async (part) => { calls.push(part); return part + '整理' }
  const first = await createOrganizationJobs(runtime).run({ ...input, generate })
  assert.equal(first.job.status, 'pending')
  assert.equal(first.job.completed, 1)
  const second = await createOrganizationJobs(runtime).run({ ...input, generate })
  assert.equal(second.job.completed, 2)
  const third = await createOrganizationJobs(runtime).run({ ...input, generate })
  assert.deepEqual(third.outputs, ['甲整理', '乙整理', '丙整理'])
  const before = runtime.metrics.writes
  await createOrganizationJobs(runtime).run({ ...input, generate })
  assert.equal(runtime.metrics.writes, before)
  assert.deepEqual(calls, input.parts)
})

test('expired in-flight provider call is paused instead of automatically charging twice', async () => {
  const runtime = cloudRuntime(), entered = deferred(), release = deferred()
  let now = 1000, sequence = 0, calls = 0
  const jobs = createOrganizationJobs({ db: runtime.db, now: () => now, leaseMs: 100, token: () => String(++sequence) })
  const first = jobs.run({ ...input, generate: async () => { calls++; entered.resolve(); await release.promise; return '旧结果' } })
  await entered.promise
  const busy = await jobs.run({ ...input, generate: async () => { throw new Error('must not start') } })
  assert.equal(busy.busy, true)
  now += 101
  const paused = await jobs.run({ ...input, maxParts: 3, generate: async () => { calls++; throw new Error('must require explicit retry') } })
  assert.equal(paused.job.errorCode, 'AI_CALL_UNKNOWN')
  assert.equal(paused.job.automaticRetry, false)
  assert.equal(calls, 1)
  release.resolve()
  const late = await first
  assert.equal(late.stale, true)
  const resumed = await jobs.run({ ...input, retry: true, maxParts: 3, generate: async (part) => { calls++; return part } })
  assert.equal(calls, 4, 'repeating an unacknowledged provider call requires explicit retry')
  assert.deepEqual(resumed.outputs, input.parts)
  const cached = await jobs.run({ ...input, generate: async () => { throw new Error('must not start') } })
  assert.deepEqual(cached.outputs, input.parts)
})

test('part receipt and manifest advance atomically when a database write fails', async () => {
  let fail = true
  const runtime = cloudRuntime([], { beforeSet(name, id, value) {
    if (fail && name === 'ai_runs' && value.taskType === 'organization_job' && value.completed === 1) {
      fail = false
      throw new Error('interrupted manifest write')
    }
  } })
  const first = await createOrganizationJobs(runtime).run({ ...input, generate: async (part) => part })
  assert.equal(first.job.completed, 0)
  assert.equal(first.job.status, 'failed')
  assert.equal([...runtime.rows.values()].filter((row) => row.taskType === 'organization_part').length, 0)
  const retried = await createOrganizationJobs(runtime).run({ ...input, retry: true, maxParts: 3, generate: async (part) => part })
  assert.deepEqual(retried.outputs, input.parts)
})

test('failure cooldown and input identity survive process replacement, without affecting another workspace', async () => {
  const runtime = cloudRuntime()
  let now = 1000, calls = 0
  const create = () => createOrganizationJobs({ db: runtime.db, now: () => now })
  const failed = await create().run({ ...input, generate: async () => { calls++; throw new Error('offline') } })
  const writes = runtime.metrics.writes
  const waiting = await create().run({ ...input, generate: async () => { calls++; return 'unexpected' } })
  assert.equal(waiting.job.retryAfter, failed.job.retryAfter)
  assert.equal(runtime.metrics.writes, writes)
  assert.equal(calls, 1)
  const other = await create().run({ ...input, owner: 'space-b', generate: async (part) => part })
  assert.notEqual(other.job.id, failed.job.id)
  now = failed.job.retryAfter
  const resumed = await create().run({ ...input, maxParts: 3, generate: async (part) => part })
  assert.deepEqual(resumed.outputs, input.parts)
  const changed = await create().run({ ...input, parts: ['新原文'], generate: async (part) => part })
  assert.notEqual(changed.job.id, failed.job.id)
})

test('missing or foreign receipts cannot be silently replaced or presented as a successful result', async () => {
  const runtime = cloudRuntime(), jobs = createOrganizationJobs(runtime)
  const complete = await jobs.run({ ...input, maxParts: 3, generate: async (part) => part })
  const key = `ai_runs/${complete.job.id}_part_0`
  runtime.rows.get(key).ownerOpenId = 'foreign'
  await assert.rejects(jobs.run({ ...input, generate: async () => { throw new Error('must not start') } }), { code: 'JOB_RECEIPT_MISSING' })
  assert.equal(runtime.rows.get(key).ownerOpenId, 'foreign')
})

test('oversized output fails explicitly without losing earlier segment receipts', async () => {
  const runtime = cloudRuntime(), jobs = createOrganizationJobs(runtime)
  await jobs.run({ ...input, generate: async (part) => part })
  const failed = await jobs.run({ ...input, generate: async () => '甲'.repeat(60000) })
  assert.equal(failed.job.completed, 1)
  assert.equal(failed.job.errorCode, 'AI_OUTPUT_CAPACITY')
  const retried = await jobs.run({ ...input, retry: true, maxParts: 3, generate: async (part) => part })
  assert.deepEqual(retried.outputs, input.parts)
})
