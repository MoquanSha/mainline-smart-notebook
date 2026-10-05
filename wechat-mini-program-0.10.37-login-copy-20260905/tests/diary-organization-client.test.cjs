const test = require('node:test')
const assert = require('node:assert/strict')
const { scopedClient } = require('./helpers/scoped-client.cjs')
const { createDiaryOrganization } = require('../miniprogram/utils/diary-organization')

function fixture(handler) {
  const { cache } = scopedClient(async () => { throw new Error('not used') })
  cache.adoptScope({ account: { user: { id: 'u' }, workspaceId: 'A' } })
  const bootstrap = { capabilities: { diaryOrganization: 1 } }
  cache.write(cache.KEYS.bootstrap, bootstrap)
  const day = { date: '2026-09-24', inputRevision: 'original-v1', organizationStatus: 'pending', manualInputs: [{ id: 'a', content: '原文' }] }
  cache.write(cache.KEYS.diaryDays, [day])
  let visible = true, now = 1000
  const calls = [], events = []
  const create = () => createDiaryOrganization({ cache, isVisible: () => visible, now: () => now,
    notify: (event) => events.push(event), request: async (payload) => { calls.push(payload); return handler(payload, cache) } })
  return { cache, day, calls, events, create, visible: (value) => { visible = value }, now: (value) => { now = value } }
}

test('acknowledged offline originals automatically finish bounded parts, concurrent triggers share work, idle adds no calls', async () => {
  let completed = 0
  const c = fixture(async () => ({ organizationPending: ++completed < 3, organizationJob: { id: 'j', status: completed === 3 ? 'complete' : 'pending', completed, total: 3 } }))
  c.day.manualInputs[0].pending = true
  c.cache.write(c.cache.KEYS.diaryDays, [c.day])
  const worker = c.create()
  await worker.resume()
  assert.equal(c.calls.length, 0)
  c.day.manualInputs[0].pending = false
  c.cache.write(c.cache.KEYS.diaryDays, [c.day])
  await Promise.all([worker.resume(), worker.resume()])
  assert.equal(c.calls.length, 3)
  await c.create().resume()
  assert.equal(c.calls.length, 3)
})

test('fidelity review pauses foreground resumes after restart but keeps explicit retry available', async () => {
  const c = fixture(async ({ retry }) => ({ organizationJob: { id: 'review', status: retry ? 'complete' : 'failed',
    retryable: true, automaticRetry: Boolean(retry), retryAfter: 2000, completed: retry ? 1 : 0, total: 1 } }))
  await c.create().resume()
  c.now(24 * 60 * 60 * 1000)
  await c.create().resume()
  assert.equal(c.calls.length, 1)
  await c.create().resume({ date: c.day.date, retry: true })
  assert.equal(c.calls.length, 2)
  assert.equal(c.calls[1].retry, true)
})

test('explicit aggregate retry continues its new generation even when the first completed count equals the old failed count', async () => {
  let calls = 0
  const c = fixture(async () => {
    calls++
    return { organizationJob: { id: 'same-job', generation: calls === 1 ? 0 : 1,
      status: calls === 1 ? 'failed' : calls === 2 ? 'pending' : 'complete',
      completed: calls === 3 ? 2 : 1, total: 2, automaticRetry: calls !== 1, retryable: true } }
  })
  await c.create().resume()
  await c.create().resume({ date: c.day.date, retry: true })
  assert.equal(c.calls.length, 3)
  assert.equal(c.cache.read(c.cache.KEYS.diaryOrganization)[c.day.date].status, 'complete')
})

test('background stops the next segment and a new coordinator resumes from persisted progress', async () => {
  let count = 0
  const c = fixture(async () => {
    count++
    if (count === 1) c.visible(false)
    return { organizationPending: count === 1, organizationJob: { id: 'j', status: count === 1 ? 'pending' : 'complete', completed: count, total: 2 } }
  })
  await c.create().resume()
  assert.equal(c.calls.length, 1)
  c.visible(true)
  await c.create().resume()
  assert.equal(c.calls.length, 2)
})

test('old workspace response cannot write into new scope or start another segment', async () => {
  let release, entered
  const gate = new Promise((resolve) => { release = resolve }), start = new Promise((resolve) => { entered = resolve })
  const c = fixture(async () => { entered(); await gate; return { organizationPending: true, organizationJob: { id: 'A-job', status: 'pending', completed: 1, total: 2 } } })
  const running = c.create().resume()
  await start
  c.cache.adoptScope({ account: { user: { id: 'u' }, workspaceId: 'B' } })
  release()
  await running
  assert.equal(c.calls.length, 1)
  assert.deepEqual(c.cache.read(c.cache.KEYS.diaryOrganization, {}), {})
  assert.equal(c.events.length, 1) // Only the pre-dispatch event in A.
  assert.equal(c.events[0].result, undefined)
})

test('ambiguous network failure leaves a durable retry deadline; explicit retry can recover without creating an upload operation', async () => {
  let failed = false
  const c = fixture(async () => {
    if (!failed) { failed = true; throw Object.assign(new Error('timeout'), { code: 'CLOUD_TIMEOUT' }) }
    return { organizationJob: { id: 'j', status: 'complete', completed: 1, total: 1 } }
  })
  const worker = c.create()
  await worker.resume()
  await c.create().resume()
  assert.equal(c.calls.length, 1)
  await worker.resume({ date: c.day.date, retry: true })
  assert.equal(c.calls.length, 2)
  assert.equal(c.cache.read(c.cache.KEYS.queue, []).length, 0)
})

test('busy server job and no-progress pending response stop immediately instead of polling', async () => {
  const c = fixture(async () => ({ organizationPending: true, organizationJob: { id: 'j', status: 'running', completed: 0, total: 2, retryAfter: 2000 } }))
  await c.create().resume()
  await c.create().resume()
  assert.equal(c.calls.length, 1)
  c.now(2001)
  await c.create().resume()
  assert.equal(c.calls.length, 2)
})

test('old cloud capability, fully organized days and background produce no automatic AI requests', async () => {
  const c = fixture(async () => { throw new Error('must not request') })
  c.cache.write(c.cache.KEYS.bootstrap, {})
  await c.create().resume()
  c.cache.write(c.cache.KEYS.bootstrap, { capabilities: { diaryOrganization: 1 } })
  c.visible(false)
  await c.create().resume()
  c.visible(true)
  c.cache.write(c.cache.KEYS.diaryDays, [{ ...c.day, organizationStatus: 'organized' }])
  await c.create().resume()
  assert.equal(c.calls.length, 0)
})

test('a newer original acknowledged during an old result is processed next instead of becoming stuck', async () => {
  let count = 0
  const c = fixture(async () => {
    count++
    if (count === 1) c.cache.write(c.cache.KEYS.diaryDays, [{ ...c.day, inputRevision: 'original-v2', manualInputs: [...c.day.manualInputs, { id: 'b', content: '第二段' }] }])
    return { stale: count === 1, organizationJob: { id: 'job-' + count, status: 'complete', completed: 1, total: 1 } }
  })
  await c.create().resume()
  assert.equal(c.calls.length, 2)
  assert.equal(c.cache.read(c.cache.KEYS.diaryOrganization)[c.day.date].revision, 'original-v2')
})

test('completed model output whose final commit was stale is not recorded as an applied diary', async () => {
  let count = 0
  const c = fixture(async () => ({ stale: ++count === 1, organizationJob: { id: 'job', status: 'complete', completed: 1, total: 1 } }))
  await c.create().resume()
  await c.create().resume()
  assert.equal(c.calls.length, 2)
})

test('permanent job failure stays visible and makes no automatic retry until explicitly requested', async () => {
  const c = fixture(async () => ({ organizationJob: { id: 'job', status: 'failed', retryable: false, completed: 0, total: 1, error: '结果超出容量' } }))
  await c.create().resume()
  c.now(999999)
  await c.create().resume()
  assert.equal(c.calls.length, 1)
  assert.equal(c.cache.read(c.cache.KEYS.diaryOrganization)[c.day.date].error, '结果超出容量')
  await c.create().resume({ date: c.day.date, retry: true })
  assert.equal(c.calls.length, 2)
})
