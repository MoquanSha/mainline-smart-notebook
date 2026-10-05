const test = require('node:test'), assert = require('node:assert/strict')
const { cloudRuntime } = require('./helpers/cloud-runtime.cjs')
const owner = 'space-a', principal = { userId: 'user-a', workspaceId: owner, role: 'owner' }
const proposal = (id, extra = {}) => ({ id, ownerOpenId: owner, workspaceId: owner, deletedAt: '', version: 1,
  type: 'today_todo', status: 'pending', title: '同名但独立的待办', detail: '保留内容', captureIds: [], suggestedHandling: 'ask_user', ...extra })
function seed(cloud, rows) { for (const row of rows) cloud.rows.set(`proposals/${row.id}`, structuredClone(row)); return cloud }
const apply = (cloud, id, requestId = `apply-${id}`, extra = {}) => cloud.api.executeMutation(owner, 'proposal.apply', { id, baseVersion: 1, ...extra }, principal, requestId)
const business = (cloud, type) => [...cloud.rows.entries()].filter(([key]) => key.startsWith(type + '/')).map(([, row]) => row)

test('explicit replan response loss replays the committed plan without further writes', async () => {
  const cloud = cloudRuntime()
  const first = await cloud.api.executeMutation(owner, 'plan.replan', {}, principal, 'replan-once')
  const writes = cloud.metrics.writes
  const replay = await cloud.api.executeMutation(owner, 'plan.replan', {}, principal, 'replan-once')
  assert.deepEqual(replay.data, first.data); assert.equal(replay.replayed, true)
  assert.equal(cloud.metrics.writes, writes)
})

test('replan day write failure leaves no plan, receipt or change sequence', async () => {
  const cloud = cloudRuntime([], { beforeSet(name) { if (name === 'day_records') throw new Error('day write failed') } })
  await assert.rejects(cloud.api.executeMutation(owner, 'plan.replan', {}, principal, 'replan-fail'), /day write failed/)
  for (const name of ['day_records', 'daily_tasks', 'sync_state', 'sync_signals']) assert.equal(business(cloud, name).length, 0)
})

test('proposal status write failure rolls back task, steps, receipt and sequence together', async () => {
  const cloud = seed(cloudRuntime([], { beforeSet(name, id, value) { if (name === 'proposals' && value.status === 'applied') throw new Error('status write failed') } }),
    [proposal('p', { type: 'task_create', steps: [{ title: '第一步' }, { title: '第二步' }] })])
  await assert.rejects(apply(cloud, 'p'), /status write failed/)
  assert.equal(business(cloud, 'tasks').length, 0); assert.equal(business(cloud, 'task_steps').length, 0)
  assert.equal(business(cloud, 'sync_state').length, 0); assert.equal(business(cloud, 'sync_signals').length, 0)
  assert.equal(cloud.rows.get('proposals/p').status, 'pending')
})

test('stale proposal version is rejected before creating a business entity', async () => {
  const cloud = seed(cloudRuntime(), [proposal('p', { version: 3, title: '另一端已修改的建议' })])
  await assert.rejects(apply(cloud, 'p'), { code: 'CONFLICT' })
  assert.equal(business(cloud, 'daily_tasks').length, 0)
})

test('single adoption cannot report ignored or deferred proposals as adopted', async () => {
  for (const status of ['rejected', 'deferred']) {
    const cloud = seed(cloudRuntime(), [proposal('p', { status })])
    await assert.rejects(apply(cloud, 'p'), { code: 'CONFLICT' })
    assert.equal(business(cloud, 'daily_tasks').length, 0)
  }
})

test('separate proposals with identical titles create separate stable todos', async () => {
  const cloud = seed(cloudRuntime(), [proposal('a'), proposal('b')])
  const a = await apply(cloud, 'a'), b = await apply(cloud, 'b')
  assert.notEqual(a.data.entity.id, b.data.entity.id)
  assert.equal(business(cloud, 'daily_tasks').length, 2)
})

test('response loss replay returns the same entity and has no repeated business write', async () => {
  const cloud = seed(cloudRuntime(), [proposal('p')])
  const first = await apply(cloud, 'p'), writes = cloud.metrics.writes
  const retry = await apply(cloud, 'p')
  assert.deepEqual(retry.data, first.data)
  assert.equal(cloud.metrics.writes, writes); assert.equal(business(cloud, 'daily_tasks').length, 1)
})

test('bulk apply acts only on explicit selection and returns independent failures', async () => {
  const cloud = seed(cloudRuntime(), [proposal('a'), proposal('b', { version: 2 }), proposal('c'), proposal('unseen')])
  const response = await cloud.api.executeMutation(owner, 'proposal.applyAll', {
    selections: ['a', 'b', 'c'].map((id) => ({ id, baseVersion: 1 }))
  }, principal, 'bulk')
  assert.equal(cloud.rows.get('proposals/unseen').status, 'pending')
  assert.equal(cloud.rows.get('proposals/b').status, 'pending')
  assert.equal(response.data.applied, 2); assert.equal(response.data.failed, 1)
  assert.equal(response.data.results.find((row) => row.id === 'b').error.code, 'CONFLICT')
})

test('task update cannot write steps or content to another workspace', async () => {
  const cloud = seed(cloudRuntime(), [proposal('p', { type: 'task_update', taskId: 'foreign', steps: [{ title: '新步骤' }] })])
  const foreign = { id: 'foreign', ownerOpenId: 'space-b', version: 1, deletedAt: '', title: '其他空间', steps: [] }
  cloud.rows.set('tasks/foreign', structuredClone(foreign))
  await assert.rejects(apply(cloud, 'p'), { code: 'FORBIDDEN' })
  assert.deepEqual(cloud.rows.get('tasks/foreign'), foreign); assert.equal(business(cloud, 'task_steps').length, 0)
})

for (const boundary of ['task_steps', 'receipt']) test(`${boundary} write failure does not leave a partially applied long-term task`, async () => {
  const cloud = seed(cloudRuntime([], { beforeSet(name, id) {
    if (boundary === 'task_steps' ? name === 'task_steps' : name === 'sync_state' && id.startsWith('operation_v2_')) throw new Error('injected write failure')
  } }), [proposal('p', { type: 'task_create', steps: [{ title: '步骤' }] })])
  await assert.rejects(apply(cloud, 'p'), /injected write failure/)
  for (const name of ['tasks', 'task_steps', 'sync_state', 'sync_signals']) assert.equal(business(cloud, name).length, 0)
  assert.equal(cloud.rows.get('proposals/p').status, 'pending')
})

test('oversized single proposal rolls back instead of exceeding transaction operations or truncating steps', async () => {
  const cloud = seed(cloudRuntime(), [proposal('p', { type: 'task_create', steps: Array.from({ length: 50 }, (_, i) => ({ title: '步骤' + i })) })])
  await assert.rejects(apply(cloud, 'p'), { code: 'PROPOSAL_CAPACITY' })
  assert.equal(business(cloud, 'tasks').length, 0); assert.equal(business(cloud, 'task_steps').length, 0)
  assert.equal(cloud.rows.get('proposals/p').steps.length, 50)
})

test('concurrent confirmations cannot create two entities for one proposal', async () => {
  const cloud = seed(cloudRuntime(), [proposal('p')])
  const results = await Promise.all([apply(cloud, 'p', 'phone'), apply(cloud, 'p', 'desktop')])
  assert.equal(business(cloud, 'daily_tasks').length, 1)
  assert.equal(results.filter((result) => result.data.alreadyHandled).length, 1)
})

test('a reused request ID cannot accept a different proposal', async () => {
  const cloud = seed(cloudRuntime(), [proposal('a'), proposal('b')])
  await apply(cloud, 'a', 'same-request')
  await assert.rejects(apply(cloud, 'b', 'same-request'), { code: 'INPUT_ID_CONFLICT' })
  assert.equal(cloud.rows.get('proposals/b').status, 'pending')
})

test('planner failure leaves an explicit durable follow-up while task acceptance stays confirmed and replay resumes it', async () => {
  let planningUnavailable = true
  const cloud = seed(cloudRuntime([], { beforeSet(name) { if (planningUnavailable && name === 'day_records') throw new Error('planner storage unavailable') } }),
    [proposal('p', { type: 'task_create', owner: 'me', steps: [{ title: '准备材料', owner: 'me' }] })])
  const first = await apply(cloud, 'p')
  assert.equal(first.data.proposal.status, 'applied'); assert.equal(first.data.planning.status, 'pending')
  assert.equal(business(cloud, 'tasks').length, 1); assert.equal(business(cloud, 'task_steps').length, 1)
  const job = business(cloud, 'sync_state').find((row) => row.id.startsWith('job_proposal_'))
  assert.equal(job.status, 'pending')
  planningUnavailable = false
  const next = await apply(cloud, 'p')
  assert.equal(next.data.entity.id, first.data.entity.id); assert.equal(next.data.planning.status, 'complete')
  assert.equal(business(cloud, 'tasks').length, 1); assert.equal(business(cloud, 'task_steps').length, 1)
})

test('bulk apply rejects an unspecified or duplicate selection before any writes', async () => {
  const cloud = seed(cloudRuntime(), [proposal('a')])
  await assert.rejects(cloud.api.executeMutation(owner, 'proposal.applyAll', {}, principal, 'missing'), { code: 'SELECTION_REQUIRED' })
  await assert.rejects(cloud.api.executeMutation(owner, 'proposal.applyAll', { selections: [{ id: 'a', baseVersion: 1 }, { id: 'a', baseVersion: 1 }] }, principal, 'duplicate'), { code: 'VALIDATION' })
  assert.equal(cloud.metrics.writes, 0)
})

test('explicit selection beyond the legacy 100-row query limit is fully handled without selecting unseen rows', async () => {
  const rows = Array.from({ length: 105 }, (_, i) => proposal('p' + i))
  const cloud = seed(cloudRuntime(), [...rows, proposal('unseen')])
  const result = await cloud.api.executeMutation(owner, 'proposal.applyAll', { selections: rows.map((row) => ({ id: row.id, baseVersion: 1 })) }, principal, 'many')
  assert.equal(result.data.applied, 105); assert.equal(result.data.failed, 0)
  assert.equal(business(cloud, 'daily_tasks').length, 105); assert.equal(cloud.rows.get('proposals/unseen').status, 'pending')
})

test('calendar acceptance preserves original diary and concurrent fixed sessions', async () => {
  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
  const cloud = seed(cloudRuntime(), [proposal('a', { type: 'calendar_event', eventDate: date, eventTime: '15:00' }),
    proposal('b', { type: 'calendar_event', eventDate: date, eventTime: '17:00' })])
  const id = cloud.api.scopedDayId(owner, date), manualInputs = [{ id: 'original', content: '  不能改变的原文\n' }]
  cloud.rows.set('day_records/' + id, { id, date, ownerOpenId: owner, version: 3, deletedAt: '', manualInputs, sessions: [] })
  await Promise.all([apply(cloud, 'a'), apply(cloud, 'b')])
  const day = cloud.rows.get('day_records/' + id)
  assert.deepEqual(day.manualInputs, manualInputs); assert.equal(day.sessions.filter((row) => row.fixed).length, 2)
})

test('task update protects target version, completed steps and deleted step markers', async () => {
  const cloud = seed(cloudRuntime(), [proposal('p', { type: 'task_update', taskId: 'task', taskBaseVersion: 3, steps: [] })])
  const task = { id: 'task', ownerOpenId: owner, version: 4, deletedAt: '', steps: [{ id: 'done', status: 'pending' }, { id: 'deleted', status: 'pending' }] }
  cloud.rows.set('tasks/task', task)
  cloud.rows.set('task_steps/done', { id: 'done', taskId: 'task', ownerOpenId: owner, version: 2, status: 'done', deletedAt: '' })
  cloud.rows.set('task_steps/deleted', { id: 'deleted', taskId: 'task', ownerOpenId: owner, version: 2, status: 'archived', deletedAt: 'then' })
  await assert.rejects(apply(cloud, 'p'), { code: 'CONFLICT' })
  assert.deepEqual(cloud.rows.get('tasks/task'), task)
  const result = await apply(cloud, 'p', 'new-confirmation', { taskBaseVersion: 4 })
  assert.equal(result.data.entity.steps.length, 1); assert.equal(result.data.entity.steps[0].status, 'done')
})

test('a delayed planner cannot replace a newer diary input or fixed session after acceptance', async () => {
  let entered, release
  const started = new Promise((resolve) => { entered = resolve }), wait = new Promise((resolve) => { release = resolve })
  const cloud = seed(cloudRuntime([], { async generateText() { entered(); await wait; return { text: '{"selected":[]}' } } }),
    [proposal('p', { type: 'task_create', owner: 'me', steps: [{ title: '准备', owner: 'me' }] })])
  const pending = apply(cloud, 'p'); await started
  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }), id = cloud.api.scopedDayId(owner, date)
  const newer = { id, ownerOpenId: owner, date, version: 10, deletedAt: '', manualInputs: [{ id: 'new', content: 'AI 等待期间补充的日记' }],
    sessions: [{ id: 'new-event', startMinutes: 900, durationMinutes: 30, fixed: true, title: '新增固定活动' }] }
  cloud.rows.set('day_records/' + id, structuredClone(newer))
  release(); const result = await pending
  assert.equal(result.data.proposal.status, 'applied'); assert.equal(result.data.planning.status, 'pending')
  assert.deepEqual(cloud.rows.get('day_records/' + id), newer)
})
