const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { cloudRuntime } = require('./helpers/cloud-runtime.cjs')
const merge = require('../cloudfunctions/notebookApi/record-merge')
const owner = 'space-a'
const at = '2026-09-24T00:00:00Z'
const removed = (patch = {}) => ({ id: 'a', ownerOpenId: owner, entryKind: 'today_todo', title: '原文', status: 'removed', deletedAt: '', trashedAt: at, purgeAt: '2099-01-01T00:00:00Z', version: 2, ...patch })

test('all three runtimes use the same merge contract', () => {
  const source = readFileSync(path.resolve(__dirname, '../../personal-task-workbench-4320-wechat-login-test/electron/record-merge.cjs'), 'utf8')
  for (const name of ['notebookApi', 'desktopSync']) assert.equal(readFileSync(path.resolve(__dirname, `../cloudfunctions/${name}/record-merge.js`), 'utf8'), source)
})

test('restore proof is symmetric and cannot undo a later deletion or permanent removal', () => {
  const first = merge.mergeRecord({}, removed())
  const restored = { ...first, ...merge.restoreMarker(first, 'restore-1', at), status: 'planned', version: 3 }
  assert.equal(merge.mergeRecord(first, restored).status, 'planned')
  assert.equal(merge.mergeRecord(restored, first).status, 'planned')
  const second = { ...restored, status: 'removed', trashedAt: '2026-09-24T00:01:00Z', version: 4 }
  assert.notEqual(merge.deletionKey(first), merge.deletionKey(second))
  for (const [a, b] of [[second, restored], [restored, second]]) assert.ok(merge.mergeRecord(a, b).trashedAt)
  assert.equal(merge.mergeRecord({ ...first, deletedAt: at }, restored).deletedAt, at)
  assert.equal(merge.mergeRecord(second, first).version, 4)
})

test('cloud original normalization keeps same-ID conflicts and their replay identity', () => {
  const cloud = cloudRuntime()
  const a = { id: 'x', content: '甲原文', createdAt: at }
  const b = { ...a, content: '乙原文' }
  const originals = cloud.api.normalizeDailyManualInputs([a, b])
  assert.equal(originals.length, 2)
  assert.ok(originals.some((item) => item.conflictOf === 'x'))
  assert.deepEqual(cloud.api.normalizeDailyManualInputs([...originals, a, b]), originals)
})

test('concurrent desktop writes atomically reject the stale base and protect workspace ownership', async () => {
  const cloud = cloudRuntime([{ ...removed(), status: 'planned', trashedAt: '', version: 1 }])
  const operation = (title) => ({ collection: 'daily_tasks', id: 'a', baseVersion: 1, contentHash: title, data: { id: 'a', title, entryKind: 'today_todo', status: 'planned' } })
  const results = await Promise.all(['甲', '乙'].map((title) => cloud.desktop.pushRecordOperation(owner, operation(title))))
  assert.deepEqual(results.map((x) => x.status).sort(), ['applied', 'conflicts'])
  const writes = cloud.metrics.writes
  await assert.rejects(cloud.desktop.pushRecordOperation('space-b', operation('甲')), { code: 'FORBIDDEN' })
  assert.equal(cloud.metrics.writes, writes)
})

test('批量导入沿用版本冲突和墓碑保护，不覆盖云端新内容', async () => {
  const cloud = cloudRuntime()
  cloud.rows.set('tasks/imported', {
    id: 'imported', ownerOpenId: owner, workspaceId: owner,
    title: '云端新内容', status: 'planned', version: 3, deletedAt: ''
  })
  const result = await cloud.desktop.importBatch(owner, 'tasks', [{
    id: 'imported', title: '旧备份内容', status: 'planned', version: 2,
    baseVersion: 2, createdAt: at, updatedAt: at
  }], 'backup-stale')
  assert.equal(result.applied.length, 0)
  assert.equal(result.conflicts.length, 1)
  assert.equal(cloud.rows.get('tasks/imported').title, '云端新内容')
  const writes = cloud.metrics.writes
  const replay = await cloud.desktop.importBatch(owner, 'tasks', [{
    id: 'imported', title: '旧备份内容', status: 'planned', version: 2,
    baseVersion: 2, createdAt: at, updatedAt: at
  }], 'backup-stale')
  assert.deepEqual(replay, result)
  assert.equal(cloud.metrics.writes, writes)
})

test('图片上传凭证只为当前空间的有效待办生成', async () => {
  const cloud = cloudRuntime([{
    id: 'photo-todo', ownerOpenId: owner, workspaceId: owner,
    entryKind: 'today_todo', status: 'planned', deletedAt: ''
  }], {
    getUploadMetadata: async ({ cloudPath }) => ({ data: { fileID: `cloud://test/${cloudPath}`, url: 'https://upload.test/photo' } })
  })
  const info = await cloud.desktop.attachmentUploadInfo(owner, { todoId: 'photo-todo', attachmentId: 'photo-1', extension: 'png' })
  assert.match(info.cloudPath, new RegExp('/photo-todo/photo-1\\.png$'))
  await assert.rejects(cloud.desktop.attachmentUploadInfo('space-b', { todoId: 'photo-todo', attachmentId: 'photo-2', extension: 'png' }), { code: 'FORBIDDEN' })
  await assert.rejects(cloud.desktop.attachmentUploadInfo(owner, { todoId: '../photo-todo', attachmentId: 'photo-3', extension: 'png' }), { code: 'VALIDATION' })
})

test('fresh-base desktop upload cannot resurrect a tombstone and returns the actual merged document', async () => {
  const cloud = cloudRuntime([removed()])
  const result = await cloud.desktop.pushRecordOperation(owner, { collection: 'daily_tasks', id: 'a', baseVersion: 2, data: { id: 'a', title: '离线新文字', status: 'planned', updatedAt: '2099-01-01' } })
  assert.ok(result.value.document.trashedAt)
  assert.ok(result.value.document.conflictVersions.some((item) => item.body.title === '离线新文字'))
})

test('cloud restore is conditional, explicit, and idempotent without undoing a second deletion', async () => {
  const cloud = cloudRuntime([removed()])
  const payload = { id: 'a', entityType: 'today_todo', baseVersion: 2, expectedTrashedAt: at, requestId: 'restore-one' }
  const restored = await cloud.api.restoreTrashItem(owner, payload)
  assert.equal(restored.restoreOf, merge.deletionKey(removed()))
  assert.equal(restored.restoreId, 'restore-one')
  assert.equal(restored.version, 3)
  const writesBeforeReplay = cloud.metrics.writes
  const replay = await cloud.api.restoreTrashItem(owner, payload)
  assert.deepEqual(cloud.api.historyDocument('daily_tasks', replay), cloud.api.historyDocument('daily_tasks', restored))
  assert.equal(cloud.metrics.writes, writesBeforeReplay, 'a replay does not publish a new change sequence')
  const second = { ...restored, status: 'removed', trashedAt: '2026-09-24T00:01:00Z', version: 4 }
  cloud.rows.set('daily_tasks/a', second)
  await assert.rejects(cloud.api.restoreTrashItem(owner, payload), { code: 'RESTORE_CONFLICT' })
  assert.deepEqual(cloud.rows.get('daily_tasks/a'), second)
})

test('merged diary keeps only an organization matching the complete original revision', () => {
  const cloud = cloudRuntime()
  const a = [{ id: 'a', content: '甲', createdAt: at }], b = [{ id: 'b', content: '乙', createdAt: at }]
  const left = { id: 'day', manualInputs: a, summary: '旧甲整理', organizationRevision: cloud.desktop.diaryInputsRevision(a), organizationStatus: 'organized' }
  const right = { id: 'day', manualInputs: b, summary: '旧乙整理', organizationRevision: cloud.desktop.diaryInputsRevision(b), organizationStatus: 'organized' }
  const merged = merge.mergeRecord(left, right)
  assert.equal(merged.organizationStatus, 'pending')
  assert.ok(merged.summary.includes('甲') && merged.summary.includes('乙'))
  const organized = { ...merged, summary: '甲乙完整整理', organizationRevision: cloud.desktop.diaryInputsRevision(merged.manualInputs), organizationStatus: 'organized' }
  for (const pair of [[organized, left], [left, organized]]) assert.equal(merge.mergeRecord(...pair).summary, organized.summary)
})

test('listing trash tolerates active rows and rechecks deletion inside the expiry transaction', async () => {
  const cloud = cloudRuntime([{ ...removed(), status: 'planned', trashedAt: '', purgeAt: '' }])
  assert.deepEqual(await cloud.api.listTrash(owner), [])
  const expired = removed({ purgeAt: '2026-01-01T00:00:00Z' })
  cloud.rows.set('daily_tasks/a', expired)
  const originalTransaction = cloud.db.runTransaction.bind(cloud.db)
  const restored = { ...expired, ...merge.restoreMarker(expired, 'from-other-device', at), status: 'planned', version: 3 }
  cloud.db.runTransaction = (callback) => {
    cloud.rows.set('daily_tasks/a', restored)
    return originalTransaction(callback)
  }
  assert.equal(await cloud.api.purgeExpiredTrash(owner), 0)
  assert.deepEqual(cloud.rows.get('daily_tasks/a'), restored)
})
