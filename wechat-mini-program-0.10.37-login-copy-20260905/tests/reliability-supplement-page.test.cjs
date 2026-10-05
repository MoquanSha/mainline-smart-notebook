const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { scopedClient } = require('./helpers/scoped-client.cjs')
const filename = path.join(__dirname, '../miniprogram/pages/capture/index.js')
const realRequire = createRequire(filename)
const owner = (id) => ({ account: { user: { id: 'u' }, workspaceId: id } })
const entry = (id = 'entry-1') => ({ id, content: '原笔记', rawContent: '原笔记', version: 1, journalSupplements: [] })
const overview = (...entries) => ({ entries, history: [], hidden: [], favorites: [] })
const event = (value, id = 'entry-1') => ({ currentTarget: { dataset: { id } }, detail: { value } })
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function runtime() {
  const c = scopedClient(async () => { throw new Error('No real cloud in this test') })
  c.cache.adoptScope(owner('A'))
  c.cache.write(c.cache.KEYS.journal, overview(entry()))
  const api = { ...c.api }, calls = []
  const queueCall = c.api.call
  api.call = (action, payload, options) => { calls.push({ action, payload, options }); return queueCall(action, payload, options) }
  const wx = { getStorageSync: () => false, removeStorageSync() {} }
  function page() {
    let definition
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      Page(value) { definition = value }, wx,
      getApp: () => ({ subscribeSync: () => () => {} }),
      require: (id) => id === '../../utils/api' ? api : id === '../../utils/cache' ? c.cache :
        id === '../../utils/candidate-refresh' ? { refreshIfDue: async () => {} } : realRequire(id),
      setTimeout() { return 1 }, clearTimeout() {}
    })
    const p = { ...definition, data: structuredClone(definition.data), setData(value) { Object.assign(this.data, structuredClone(value)) } }
    p.onLoad(); p.onShow()
    return p
  }
  return { ...c, api, calls, wx, page }
}

test('a long supplement draft survives reopening and later cloud refresh without truncation', () => {
  const r = runtime(), p = r.page()
  const content = '  **原文**\n' + '长补充😀'.repeat(2500) + '\n  '
  p.onSupplementInput(event(content))
  p.onUnload()
  const reopened = r.page()
  assert.equal(reopened.findEntry('entry-1').supplementText, content)
  reopened.applyOverview(overview({ ...entry(), version: 2 }))
  assert.equal(reopened.findEntry('entry-1').supplementText, content)
})

test('organization progress keeps historical entries readonly and ignores status for an older original', () => {
  const r = runtime(), p = r.page()
  const row = entry()
  const history = { entries: [], history: [{ date: '2026-09-20', entries: [row] }] }
  r.cache.write(r.cache.KEYS.journalOrganization, { [row.id]: { revision: row.rawContent, status: 'running', completed: 2, total: 3 } })
  p.applyOverview(history, false)
  assert.equal(p.data.history[0].entries[0].readonly, true)
  assert.match(p.data.history[0].entries[0].organizerLabel, /2\/3/)
  r.cache.write(r.cache.KEYS.journalOrganization, { [row.id]: { revision: 'older original', status: 'failed', error: '不该显示的旧错误' } })
  p.applyOverview(history, false)
  assert.equal(p.data.history[0].entries[0].organizationFailed, false)
  assert.equal(p.data.history[0].entries[0].organizationError, '')
})

test('saving waits for durability and both delayed success and failure preserve the next draft', async () => {
  for (const fail of [false, true]) {
    const r = runtime(), p = r.page(), reply = deferred()
    r.api.call = () => reply.promise
    p.onSupplementInput(event('第一段'))
    const saving = p.saveSupplement(event())
    assert.equal(p.findEntry('entry-1').supplementText, '第一段')
    p.onSupplementInput(event('保存期间继续写下的新文字'))
    if (fail) reply.reject(new Error('保存失败'))
    else reply.resolve({ queued: true })
    await saving
    assert.equal(p.findEntry('entry-1').supplementText, '保存期间继续写下的新文字')
    assert.equal(r.page().findEntry('entry-1').supplementText, '保存期间继续写下的新文字')
  }
})

test('the accepted supplement uses the same stable ID in the local view, queue and repeated submit', async () => {
  const r = runtime(), p = r.page()
  p.onSupplementInput(event('  补充内容\n'))
  await p.saveSupplement(event())
  const [queued] = r.cache.read(r.cache.KEYS.queue)
  assert.ok(queued.payload.supplementId)
  assert.equal(queued.payload.content, '  补充内容\n')
  const row = p.findEntry('entry-1')
  assert.equal(row.journalSupplements[0].id, queued.payload.supplementId)
  assert.equal(row.journalSupplements[0].content, queued.payload.content)
  assert.equal(row.supplementText, '')
  await p.saveSupplement(event())
  assert.equal(r.cache.read(r.cache.KEYS.queue).length, 1)
  assert.equal(r.page().findEntry('entry-1').supplementText, '')
})

test('old-workspace supplement success and error cannot change the next workspace', async () => {
  for (const fail of [false, true]) {
    const r = runtime(), p = r.page(), reply = deferred()
    r.api.call = () => reply.promise
    p.onSupplementInput(event('A 私有草稿'))
    const saving = p.saveSupplement(event())
    r.cache.adoptScope(owner('B'))
    r.cache.write(r.cache.KEYS.journal, overview({ ...entry(), content: 'B 笔记' }))
    p.onShow()
    p.onSupplementInput(event('B 新草稿'))
    const before = JSON.stringify(p.data)
    if (fail) reply.reject(new Error('A 的保存错误'))
    else reply.resolve({ ...entry(), content: 'A 的私有结果' })
    await saving
    assert.equal(JSON.stringify(p.data), before)
    assert.equal(r.page().findEntry('entry-1').supplementText, 'B 新草稿')
    r.cache.adoptScope(owner('A'))
    assert.equal(r.page().findEntry('entry-1').supplementText, 'A 私有草稿')
  }
})

test('a storage failure retains the editor and does not submit or claim a local save', async () => {
  const r = runtime(), p = r.page()
  const write = r.cache.write
  r.cache.write = (key, value) => { if (String(key).includes('SupplementDraft')) throw new Error('存储空间不足'); return write(key, value) }
  p.onSupplementInput(event('无法落盘的文字'))
  await p.saveSupplement(event())
  assert.equal(p.findEntry('entry-1').supplementText, '无法落盘的文字')
  assert.equal(r.calls.length, 0)
  assert.match(p.data.syncMessage, /存储空间不足/)
})

test('a late failure does not roll back unrelated records received during the save', async () => {
  const r = runtime(), p = r.page(), reply = deferred()
  r.api.call = () => reply.promise
  p.onSupplementInput(event('待保存补充'))
  const saving = p.saveSupplement(event())
  p.applyOverview(overview(entry(), entry('new-from-desktop')))
  reply.reject(new Error('暂时断网'))
  await saving
  assert.ok(p.findEntry('new-from-desktop'))
  assert.equal(p.findEntry('entry-1').supplementText, '待保存补充')
})

test('new journal save and failure preserve other arrivals and exact original whitespace', async () => {
  for (const fail of [false, true]) {
    const r = runtime(), p = r.page(), reply = deferred()
    let sent
    r.api.call = (action, payload) => { sent = payload; return reply.promise }
    p.onInput({ detail: { value: '  ## 原文\n\n不要删掉缩进\n  ' } })
    const saving = p.createEntry()
    p.applyOverview(overview(entry(), entry('received-during-save')))
    if (fail) reply.reject(new Error('保存失败'))
    else reply.resolve({ queued: true })
    await saving
    assert.ok(p.findEntry('received-during-save'))
    assert.equal(sent.content, '  ## 原文\n\n不要删掉缩进\n  ')
    if (!fail) assert.equal(p.findEntry(sent.id).rawContent, sent.content)
  }
})

test('retry after reopening preserves every operation field and the original draft day', async () => {
  const r = runtime(), p = r.page(), calls = []
  r.api.call = async (action, payload) => { calls.push(JSON.parse(JSON.stringify(payload))); throw new Error('确认丢失') }
  p.onSupplementInput(event('补充重试'))
  await p.saveSupplement(event())
  const reopened = r.page()
  await reopened.saveSupplement(event())
  assert.deepEqual(calls[0], calls[1])
  r.cache.write(r.cache.KEYS.journalDraftState, { content: '午夜之前的草稿', id: 'before-midnight', revision: 1,
    date: '2026-09-24', occurredAt: '2026-09-24T15:59:00.000Z' })
  await r.page().createEntry()
  await r.page().createEntry()
  assert.deepEqual(calls[2], calls[3])
  assert.equal(calls[3].date, '2026-09-24')
})

test('file import preserves long input and intervening typing, persists it, and ignores old-workspace callbacks', () => {
  const r = runtime(), p = r.page()
  let select, read
  r.wx.chooseMessageFile = (options) => { select = options.success }
  r.wx.getFileSystemManager = () => ({ readFile(options) { read = options.success } })
  p.importFile()
  select({ tempFiles: [{ name: '长笔记.md', path: '/synthetic', size: 20000 }] })
  p.onInput({ detail: { value: '等待期间的文字' } })
  const long = '原文'.repeat(10000)
  read({ data: long })
  assert.ok(p.data.content.startsWith('等待期间的文字\n\n'))
  assert.ok(p.data.content.endsWith(long))
  assert.equal(r.page().data.content, p.data.content)
  p.importFile()
  select({ tempFiles: [{ name: 'A.md', path: '/synthetic', size: 10 }] })
  r.cache.adoptScope(owner('B')); p.onShow()
  p.onInput({ detail: { value: 'B 文字' } })
  read({ data: 'A 私有内容' })
  assert.equal(p.data.content, 'B 文字')
})

test('checklist, favorite and proposal callbacks cannot update a later workspace', async () => {
  for (const method of ['toggleItem', 'mutateRecord', 'handleProposal', 'applyAllProposals']) for (const fail of [false, true]) {
    const r = runtime(), p = r.page(), reply = deferred()
    p.applyOverview(overview({ ...entry(), checklistItems: [{ id: 'check-1', text: '条目', done: false }] }))
    p.setData({ proposals: [{ id: 'proposal-1', status: 'pending', version: 1 }] })
    r.api.call = () => reply.promise
    const input = { currentTarget: { dataset: { id: method === 'handleProposal' ? 'proposal-1' : 'entry-1',
      entry: 'entry-1', item: 'check-1', action: method === 'handleProposal' ? 'reject' : 'favorite' } } }
    const saving = p[method](input)
    r.cache.adoptScope(owner('B'))
    r.cache.write(r.cache.KEYS.journal, overview({ ...entry(), content: 'B 内容' }))
    p.onShow()
    const before = JSON.stringify(p.data), stored = JSON.stringify(r.cache.read(r.cache.KEYS.journal))
    if (fail) reply.reject(new Error('A 出错'))
    else reply.resolve({ queued: true })
    await saving
    assert.equal(JSON.stringify(p.data), before, method + ' stale callback')
    assert.equal(JSON.stringify(r.cache.read(r.cache.KEYS.journal)), stored)
  }
})
