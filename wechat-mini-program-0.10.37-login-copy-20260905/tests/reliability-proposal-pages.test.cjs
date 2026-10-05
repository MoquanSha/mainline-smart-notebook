const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), { createRequire } = require('node:module')
const { scopedClient } = require('./helpers/scoped-client.cjs')
const owner = (id) => ({ account: { user: { id: 'user' }, workspaceId: id } })
const row = (id, extra = {}) => ({ id, status: 'pending', type: 'task_create', title: id, version: 1, ...extra })
const event = (id, field, value) => ({ currentTarget: { dataset: { id, field } }, detail: { value } })
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function fixture() {
  const r = scopedClient(async () => ({ result: { ok: true, data: owner('A') } }))
  r.cache.adoptScope(owner('A')); r.cache.write(r.cache.KEYS.proposals, [row('a'), row('b')])
  const messages = [], modals = [], api = { call: async () => ({ proposals: r.cache.read(r.cache.KEYS.proposals, []), complete: true }) }
  const filename = path.join(__dirname, '../miniprogram/pages/inbox/index.js'), native = createRequire(filename); let definition
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { Page(p) { definition = p }, getApp: () => ({ subscribeSync: () => () => {} }),
    wx: { showToast: p => messages.push(p), showModal: p => modals.push(p), showLoading() {}, hideLoading() {} },
    require: id => id === '../../utils/cache' ? r.cache : id === '../../utils/api' ? api
      : id === '../../utils/candidate-refresh' ? { refreshIfDue: async () => {} } : native(id) })
  const p = { ...definition, data: structuredClone(definition.data), setData(value) {
    for (const [key, v] of Object.entries(value)) { const parts = key.split('.'); let target = this.data; while (parts.length > 1) target = target[parts.shift()]; target[parts[0]] = structuredClone(v) }
  } }
  p.onLoad(); p.onShow()
  return { ...r, p, api, messages, modals }
}

test('inbox bulk selection is frozen at confirmation opening and displays A/C success with B failure', async () => {
  const r = fixture(); r.cache.write(r.cache.KEYS.proposals, [row('a'), row('b'), row('c')]); r.p.onShow()
  r.p.applyAll(); let sent
  r.cache.write(r.cache.KEYS.proposals, [row('a'), row('b'), row('c'), row('new')]); r.p.onShow()
  r.api.call = async (action, payload) => {
    if (action === 'proposal.list') return { proposals: [row('b'), row('new')], complete: true }
    sent = payload; return { applied: 2, failed: 1, results: [
      { id: 'a', ok: true, data: { proposal: row('a', { version: 2, status: 'applied' }) } },
      { id: 'b', ok: false, error: { code: 'CONFLICT' } },
      { id: 'c', ok: true, data: { proposal: row('c', { version: 2, status: 'applied' }) } },
    ] }
  }
  await r.modals[0].success({ confirm: true })
  assert.deepEqual(Array.from(sent.selections, p => p.id), ['a', 'b', 'c'])
  assert.deepEqual(r.p.data.proposals.map(p => p.id), ['b', 'new'])
  assert.match(r.messages.at(-1).title, /2 条.*1 条待处理/); assert.equal(r.messages.at(-1).icon, 'none')
})

test('inbox A confirmation cannot submit after switching to B even before onShow', async () => {
  const r = fixture(); r.p.applyAll(); let calls = 0; r.api.call = async () => { calls++ }
  r.cache.adoptScope(owner('B')); await r.modals[0].success({ confirm: true })
  assert.equal(calls, 0)
})

test('inbox old-space mutation replies and errors cannot change B cache or show a toast', async () => {
  for (const fail of [false, true]) {
    const r = fixture(), reply = deferred(); r.api.call = () => reply.promise
    const pending = r.p.handle('proposal.apply', 'a', '已采用')
    r.cache.adoptScope(owner('B')); r.cache.write(r.cache.KEYS.proposals, [row('other')]); r.p.onShow()
    if (fail) reply.reject(new Error('旧空间失败')); else reply.resolve({ proposal: row('a', { status: 'applied' }) })
    await pending
    assert.deepEqual(r.p.data.proposals.map(p => p.id), ['other']); assert.equal(r.messages.length, 0)
    assert.deepEqual(r.cache.read(r.cache.KEYS.proposals).map(p => p.id), ['other'])
  }
})

test('drafts are durable and scoped, and typing during save survives success with a usable next base version', async () => {
  const r = fixture(), reply = deferred()
  r.p.startEdit(event('a')); r.p.editField(event('a', 'title', '第一版'))
  r.api.call = (action) => action === 'proposal.update' ? reply.promise : Promise.resolve({ proposals: r.cache.read(r.cache.KEYS.proposals), complete: true })
  const pending = r.p.saveEdit(); r.p.editField(event('a', 'title', '等待期间继续写'))
  reply.resolve(row('a', { title: '第一版', version: 2 })); await pending
  assert.equal(r.p.data.editDraft.title, '等待期间继续写'); assert.equal(r.p.data.editDraft.baseVersion, 2)
  r.cache.adoptScope(owner('B')); r.p.onShow(); assert.equal(r.p.data.editingId, '')
  r.cache.adoptScope(owner('A')); r.p.onShow()
  assert.equal(r.p.data.editDraft.title, '等待期间继续写'); assert.equal(r.p.data.editDraft.baseVersion, 2)
})

test('failed draft persistence stops submission and retains editor content', async () => {
  const r = fixture(); r.p.startEdit(event('a')); let calls = 0
  r.api.call = async () => { calls++ }; const original = r.cache.write
  r.cache.write = (key, value) => { if (key === r.cache.KEYS.proposalDraftState) throw new Error('空间不足'); return original(key, value) }
  await r.p.saveEdit()
  assert.equal(calls, 0); assert.equal(r.p.data.editingId, 'a'); assert.match(r.messages.at(-1).title, /空间不足/)
})

test('double save does not submit twice while the first revision is in flight', async () => {
  const r = fixture(), reply = deferred(); r.p.startEdit(event('a')); let calls = 0
  r.api.call = async (action) => { if (action === 'proposal.update') { calls++; return reply.promise } return { proposals: [], complete: true } }
  const one = r.p.saveEdit(), two = r.p.saveEdit()
  assert.equal(calls, 1); reply.resolve(row('a', { version: 2 })); await Promise.all([one, two])
})

test('draft save cannot absorb another device edit into its base version', async () => {
  const r = fixture(), reply = deferred(); r.p.startEdit(event('a'))
  r.api.call = action => action === 'proposal.update' ? reply.promise : Promise.resolve({ proposals: [row('a', { version: 5, title: '电脑新内容' })], complete: true })
  const pending = r.p.saveEdit(); r.p.editField(event('a', 'title', '手机继续写'))
  reply.resolve(row('a', { version: 2, title: 'a' })); await pending
  assert.equal(r.p.data.editDraft.baseVersion, 2); assert.equal(r.p.data.editDraft.title, '手机继续写')
  assert.equal(r.p.data.proposals[0].version, 5)
})

test('home apply-all uses explicit wire action so an old desktop cannot expand the selection', async () => {
  const requests = []
  const r = scopedClient(async () => ({}), new Map(), { request(options) { requests.push(options); options.success({ statusCode: 400, data: { ok: false, error: { code: 'VALIDATION', message: '不支持此操作' } } }) } })
  r.cache.adoptScope(owner('A')); r.cache.writeConnection({ serverBaseUrl: 'https://home.invalid', token: 'synthetic' })
  await assert.rejects(r.home.rpc('proposal.applyAll', { selections: [{ id: 'a', baseVersion: 1 }] }), { code: 'VALIDATION' })
  assert.equal(requests.length, 1); assert.equal(requests[0].data.action, 'proposal.applySelected')
})
