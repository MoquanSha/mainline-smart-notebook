const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const { scopedClient } = require('./helpers/scoped-client.cjs')
const componentSource = fs.readFileSync(path.join(__dirname, '../miniprogram/components/organization-review/index.js'), 'utf8')
function fixture(request) {
  let scope = 'A', definition, calls = 0
  new Function('require', 'Component', componentSource)((id) => id.endsWith('/api') ? { readOrganizationReview: async (payload) => { calls++; return request(payload) } } : { scopeToken: () => scope }, (value) => { definition = value })
  const component = { properties: { job: { reviewId: 'review', reviewHost: 'cloud' }, scope: 'A', kind: 'journal_entry', entryId: 'entry' },
    data: structuredClone(definition.data), setData(value) { Object.assign(this.data, value) } }
  for (const [key, value] of Object.entries(definition.methods)) component[key] = value.bind(component)
  definition.lifetimes.attached.call(component)
  return { component, definition, calls: () => calls, scope: (next) => { scope = next } }
}
const page = { reviewId: 'review', index: 0, availableParts: 2, totalParts: 3, checkedScope: 'segment', original: '没有支付123元', candidate: '支付132元', findings: [{ kind: 'number', label: '数字', changes: [{ value: '123', originalCount: 1, candidateCount: 0 }] }] }
test('review component makes no automatic request; open fetches one page, navigation fetches next, closing forgets private text', async () => {
  const f = fixture(async ({ index }) => ({ ...page, index }))
  assert.equal(f.calls(), 0)
  await f.component.toggle(); assert.equal(f.calls(), 1); assert.equal(f.component.data.review.original, page.original)
  await f.component.next(); assert.equal(f.calls(), 2); assert.equal(f.component.data.review.index, 1)
  await f.component.toggle(); assert.equal(f.component.data.review, null); assert.equal(f.calls(), 2)
})
test('scope switch, close, background and detach discard late private review responses', async () => {
  for (const reason of ['scope', 'close', 'hide', 'detach']) {
    let release
    const f = fixture(() => new Promise((resolve) => { release = resolve }))
    const pending = f.component.toggle()
    if (reason === 'scope') { f.scope('B'); f.component.properties.scope = 'B'; f.definition.observers['job.reviewId, scope'].call(f.component) }
    if (reason === 'close') f.component.toggle()
    if (reason === 'hide') f.definition.pageLifetimes.hide.call(f.component)
    if (reason === 'detach') f.definition.lifetimes.detached.call(f.component)
    release(page); await pending
    assert.equal(f.component.data.review, null, reason)
  }
})
test('read failures remain visible and require an explicit read retry', async () => {
  let bad = true
  const f = fixture(async () => { if (bad) throw new Error('连接中断'); return page })
  await f.component.toggle(); assert.equal(f.component.data.error, '连接中断'); assert.equal(f.calls(), 1)
  bad = false; await f.component.reload(); assert.equal(f.component.data.review.original, page.original); assert.equal(f.calls(), 2)
})
test('actual client review read is cloud-only, never queued and rejects a late response from another space', async () => {
  let release, entered
  const start = new Promise((resolve) => { entered = resolve })
  const c = scopedClient(async ({ data }) => {
    if (data.action === 'bootstrap') return { result: { ok: true, data: { account: { user: { id: 'u' }, workspaceId: 'A' } } } }
    assert.equal(data.action, 'organization.review'); entered(); return new Promise((resolve) => { release = resolve })
  })
  await c.api.bootstrap()
  const pending = c.api.readOrganizationReview({ kind: 'journal_entry', entryId: 'entry' })
  await start
  c.cache.adoptScope({ account: { user: { id: 'u' }, workspaceId: 'B' } })
  release({ result: { ok: true, data: page } })
  await assert.rejects(pending, { code: 'STALE_SCOPE' })
  assert.deepEqual(c.cache.read(c.cache.KEYS.queue, []), [])
})
