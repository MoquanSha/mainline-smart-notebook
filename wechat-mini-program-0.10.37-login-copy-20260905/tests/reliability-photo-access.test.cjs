const test = require('node:test')
const assert = require('node:assert/strict')
const { cloudRuntime } = require('./helpers/cloud-runtime.cjs')
const presentation = require('../miniprogram/pages/home/presentation')
const photo = (id, fileID) => ({ id, fileID })
const todo = (id, owner, attachments) => ({ id, ownerOpenId: owner, entryKind: 'today_todo', comments: [{ id: 'comment', attachments }] })
function runtime(seed) {
  const signed = []
  const r = cloudRuntime(seed, { getTempFileURL: async ({ fileList }) => {
    const ids = fileList.map((f) => typeof f === 'string' ? f : f.fileID); signed.push(ids)
    return { fileList: ids.map((fileID) => ({ fileID, tempFileURL: 'https://files.test/' + encodeURIComponent(fileID), code: 'SUCCESS' })) }
  } })
  return { ...r, signed }
}

test('a cloud photo without a temporary URL remains visible as an attachment', () => {
  const rows = presentation.presentComments([{ id: 'c', attachments: [photo('p', 'cloud://env/photo')] }])
  assert.equal(rows[0].attachments.length, 1)
})

test('legacy desktop URL requests cannot sign a file outside the authenticated workspace', async () => {
  const r = runtime([todo('a', 'A', [photo('p', 'cloud://env/a')]), todo('b', 'B', [photo('q', 'cloud://env/b')])])
  const result = await r.desktop.attachmentTempUrls('A', { fileIDs: ['cloud://env/b'] })
  assert.ok(!result.files.some((file) => file.url))
  assert.equal(r.signed.length, 0)
})

test('legacy desktop URL requests do not sign deleted comments or deleted records', async () => {
  const deletedComment = todo('a', 'A', [photo('p', 'cloud://env/a')]); deletedComment.comments[0].deletedAt = '2026-09-25'
  const deletedTodo = { ...todo('b', 'A', [photo('q', 'cloud://env/b')]), deletedAt: '2026-09-25' }
  const r = runtime([deletedComment, deletedTodo])
  const result = await r.desktop.attachmentTempUrls('A', { fileIDs: ['cloud://env/a', 'cloud://env/b'] })
  assert.ok(!result.files.some((file) => file.url))
  assert.equal(r.signed.length, 0)
})

test('explicit photo references check workspace, record, comment and attachment before signing', async () => {
  const a = todo('a', 'A', [photo('p', 'cloud://env/shared'), { ...photo('gone', 'cloud://env/gone'), deletedAt: 'now' }])
  const r = runtime([a, todo('b', 'B', [photo('q', 'cloud://env/shared')])])
  const refs = [
    { todoId: 'a', attachmentId: 'p', fileID: 'cloud://env/shared' },
    { todoId: 'b', attachmentId: 'q', fileID: 'cloud://env/shared' },
    { todoId: 'a', attachmentId: 'gone', fileID: 'cloud://env/gone' },
    { todoId: 'a', attachmentId: 'p', fileID: 'cloud://env/forged' }
  ]
  for (const resolve of [r.api.attachmentPreviews, (owner, references) => r.desktop.attachmentTempUrls(owner, { references })]) {
    const before = r.metrics.reads
    const result = await resolve('A', refs)
    assert.equal(result.files.filter((f) => f.url).length, 1)
    assert.equal(result.files[0].attachmentId, 'p')
    assert.ok(Date.parse(result.files[0].expiresAt) > Date.now())
    assert.equal(r.metrics.reads - before, 2, 'one read per distinct referenced record')
  }
  assert.ok(r.signed.every((ids) => ids.length === 1 && ids[0] === 'cloud://env/shared'))
})

test('legacy compatibility finds a historical photo beyond the first 100 records', async () => {
  const rows = Array.from({ length: 205 }, (_, i) => todo('t-' + String(i).padStart(3, '0'), 'A', []))
  rows[204].comments[0].attachments = [photo('old', 'cloud://env/old')]
  const r = runtime(rows)
  const result = await r.desktop.attachmentTempUrls('A', { fileIDs: ['cloud://env/old'] })
  assert.match(result.files[0].url, /^https:/)
  assert.equal(r.metrics.reads, 3)
})

test('invalid/oversized photo batches fail without truncating them or signing a partial response', async () => {
  const r = runtime([])
  await assert.rejects(r.api.attachmentPreviews('A', Array.from({ length: 51 }, () => ({ todoId: 'a', attachmentId: 'p', fileID: 'cloud://env/x' }))), { code: 'VALIDATION' })
  await assert.rejects(r.api.attachmentPreviews('A', [{ todoId: '../other', attachmentId: 'p', fileID: 'cloud://env/x' }]), { code: 'VALIDATION' })
  assert.equal(r.metrics.reads, 0)
  assert.equal(r.signed.length, 0)
})

test('missing cloud files stay in the response with a retryable display state', async () => {
  const r = cloudRuntime([todo('a', 'A', [photo('p', 'cloud://env/missing')])], { getTempFileURL: async () => ({ fileList: [{ fileID: 'cloud://env/missing', code: 'FILE_NOT_EXIST' }] }) })
  const result = await r.api.attachmentPreviews('A', [{ todoId: 'a', attachmentId: 'p', fileID: 'cloud://env/missing' }])
  assert.equal(result.files.length, 1)
  assert.equal(result.files[0].url, '')
  assert.equal(result.files[0].error, 'PHOTO_UNAVAILABLE')
})

test('legacy history URL hydration batches live photos and includes a reusable expiry', async () => {
  const calls = []
  const r = cloudRuntime([], { getTempFileURL: async ({ fileList }) => {
    calls.push(fileList)
    return { fileList: fileList.map((file) => ({ fileID: file.fileID, tempFileURL: 'https://files.test/' + encodeURIComponent(file.fileID) })) }
  } })
  const attachments = Array.from({ length: 53 }, (_, i) => photo('p' + i, 'cloud://env/p' + i))
  const row = todo('t', 'A', [...attachments, { ...photo('gone', 'cloud://env/deleted'), deletedAt: 'now' }])
  row.comments.push({ id: 'deleted', deletedAt: 'now', attachments: [photo('deleted-c', 'cloud://env/deleted-c')] })
  const result = await r.api.attachmentUrls([row])
  assert.deepEqual(calls.map((batch) => batch.length), [50, 3])
  assert.ok(calls.flat().every((file) => file.maxAge === 1800 && !file.fileID.includes('deleted')))
  assert.equal(result[0].comments.length, 1)
  assert.equal(result[0].comments[0].attachments.length, 53)
  assert.ok(result[0].comments[0].attachments.every((file) => file.previewUrl && Date.parse(file.previewUrlExpiresAt) > Date.now()))
  const { scopedClient } = require('./helpers/scoped-client.cjs')
  const { createAttachmentPreviews } = require('../miniprogram/utils/attachment-previews')
  const client = scopedClient(async () => { throw new Error('No network expected') })
  client.cache.adoptScope({ account: { user: { id: 'u' }, workspaceId: 'A' } })
  let requests = 0
  const loader = createAttachmentPreviews({ cache: client.cache, request: async () => { requests++; return { files: [] } } })
  const shown = await loader.resolve('t', result[0].comments[0].attachments)
  assert.equal(shown.length, 53); assert.ok(shown.every((file) => file.url)); assert.equal(requests, 0)
})
