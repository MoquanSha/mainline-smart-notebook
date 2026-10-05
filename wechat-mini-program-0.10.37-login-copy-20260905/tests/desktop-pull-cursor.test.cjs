const test = require('node:test')
const assert = require('node:assert/strict')
const { __test } = require('../cloudfunctions/desktopSync/index.js')

const CREATED_AT = '2026-08-20T07:39:54.623Z'
const PINNED_AT = '2026-08-20T07:40:48.149Z'

function todo(overrides = {}) {
  return {
    id: 'today_todo_client_cursor_regression',
    entryKind: 'today_todo',
    date: '2026-08-20',
    status: 'planned',
    pinned: false,
    updatedAt: CREATED_AT,
    version: 1,
    ...overrides
  }
}

test('version-2 offsets migrate by replaying the boundary instead of skipping it', () => {
  const cursor = __test.normalizePullCursor({
    v: 2,
    positions: {
      tasks: { at: 'task-time', offset: 1, legacy: false },
      daily_tasks: { at: CREATED_AT, offset: 1, legacy: false },
      captures: { at: 'capture-time', offset: 1, legacy: false }
    }
  })
  assert.equal(cursor.v, 5)
  assert.deepEqual(cursor.positions.daily_tasks, { at: CREATED_AT, seen: {} })
})

test('a document that moves forward after pinning is selected again', () => {
  const original = todo()
  const position = {
    at: CREATED_AT,
    seen: { [original.id]: __test.pullDocumentToken(original) }
  }
  const pinned = todo({ pinned: true, pinnedAt: PINNED_AT, updatedAt: PINNED_AT, version: 2 })
  assert.deepEqual(__test.selectPullDocuments([pinned], position), [pinned])
})

test('an unchanged boundary is deduplicated while a same-time newer version is retained', () => {
  const original = todo()
  const position = {
    at: CREATED_AT,
    seen: { [original.id]: __test.pullDocumentToken(original) }
  }
  assert.deepEqual(__test.selectPullDocuments([original], position), [])
  const newer = todo({ pinned: true, version: 2 })
  assert.deepEqual(__test.selectPullDocuments([newer], position), [newer])
})

test('advancing the cursor stores document identity and version at the timestamp boundary', () => {
  const pinned = todo({ pinned: true, pinnedAt: PINNED_AT, updatedAt: PINNED_AT, version: 2 })
  assert.deepEqual(__test.nextPullPosition({ at: CREATED_AT, seen: {} }, [pinned]), {
    at: PINNED_AT,
    seen: { [pinned.id]: __test.pullDocumentToken(pinned) }
  })
})

test('daily task pulls include complete todo history so old deletes reach desktop', () => {
  const scope = __test.collectionPullScope('daily_tasks')
  assert.equal(scope.entryKind, 'today_todo')
  assert.equal(scope.date, undefined)
})
