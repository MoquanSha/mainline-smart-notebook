const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const DESKTOP_ROOT = path.join(ROOT, '..', 'personal-task-workbench-4320-wechat-login-test')

function read(...segments) {
  return fs.readFileSync(path.join(...segments), 'utf8')
}

function loadCommonJs(file) {
  const module = { exports: {} }
  vm.runInNewContext(read(file), { module, exports: module.exports, require, console })
  return module.exports
}

test('数据库集合初始化不会进入普通请求的管理 API 热路径', () => {
  const source = read(ROOT, 'cloudfunctions', 'notebookApi', 'index.js')
  assert.match(source, /process\.env\.AUTO_CREATE_COLLECTIONS !== 'true'/)
  assert.match(source, /if \(ensureCollectionsPromise\) return ensureCollectionsPromise/)
})

test('同步信号使用原子自增', () => {
  const notebook = read(ROOT, 'cloudfunctions', 'notebookApi', 'index.js')
  const desktop = read(ROOT, 'cloudfunctions', 'desktopSync', 'index.js')
  assert.match(notebook, /version: _\.inc\(1\)/)
  assert.match(desktop, /version: _\.inc\(1\)/)
})

test('手机生命周期与增量通知接收不使用定时轮询', () => {
  const mini = read(ROOT, 'miniprogram', 'app.js')
  const desktop = read(DESKTOP_ROOT, 'electron', 'main.cjs')
  assert.match(mini, /if \(this\.startupSyncDone\) return/)
  assert.match(mini, /requestSync\('app-start'\)/)
  assert.match(mini, /if \(api\.hasPendingQueue\(\)\) api\.flushDirtyQueueNow\(\{ reason: 'app-hide' \}\)/)
  assert.doesNotMatch(mini, /setInterval\(/)
  assert.match(mini, /channelId\.startsWith\('sync_head_'\)/)
  assert.match(desktop, /await runCloudSync\(userData, \{ suppressErrors: true \}\)/)
  assert.doesNotMatch(desktop, /cloudSyncFallbackTimer = setInterval/)
  assert.doesNotMatch(desktop, /startEventSync\(userData\);/)
  const api = read(ROOT, 'miniprogram', 'utils', 'api.js')
  const home = read(ROOT, 'miniprogram', 'pages', 'home', 'index.js')
  assert.match(api, /ROUTINE_SYNC_PREFIXES = \['todayTodo\.', 'task\.', 'journal\.', 'capture\.', 'trash\.', 'diary\.appendInput', 'diary\.organizeInput'\]/)
  assert.match(api, /manualRoutineMutation\(action\)/)
  assert.match(api, /if \(MANUAL_SYNC_ONLY\) return descriptor/)
  assert.doesNotMatch(home, /api\.call\('device\.status'\)/)
})

test('电脑日常同步按哈希增量发送完整待办、长期计划、整理后的灵光一现和精简每日小记', () => {
  const source = read(DESKTOP_ROOT, 'electron', 'cloud-sync.cjs')
  const desktopFunction = read(ROOT, 'cloudfunctions', 'desktopSync', 'index.js')
  const stateSection = source.slice(source.indexOf('function stateToOperations'), source.indexOf('function groupChanges'))
  const collectionSection = desktopFunction.match(/const COLLECTIONS = \[[\s\S]*?\]/)[0]
  assert.match(stateSection, /["']tasks["'], state\.tasks/)
  assert.match(stateSection, /["']daily_tasks["']/)
  assert.match(stateSection, /["']captures["']/)
  assert.match(stateSection, /["']day_records["']/)
  assert.match(stateSection, /filter\(isJournalSyncCandidate\)/)
  assert.match(source, /entry\.entryKind === "journal_entry"/)
  assert.doesNotMatch(source.slice(source.indexOf('function isJournalSyncCandidate'), source.indexOf('function cleanJournalSupplement')), /codex_message/)
  const sanitizer = source.slice(source.indexOf('function sanitizeJournalEntry'), source.indexOf('function stateToOperations'))
  const { sanitizeJournalEntry } = require(path.join(DESKTOP_ROOT, 'electron', 'cloud-sync.cjs'))
  for (const journalSource of ['manual', 'import', 'wechat', 'mobile', 'home', 'wechat_official', 'wecom']) {
    assert.equal(sanitizeJournalEntry({ id: journalSource, source: journalSource, rawContent: '  原文\n' }).rawContent, '  原文\n')
  }
  assert.equal(sanitizeJournalEntry({ id: 'private', source: 'codex', rawContent: 'private session' }).rawContent, undefined)
  assert.match(sanitizer, /clean\.rawContent = entry\.rawContent/)
  for (const name of ['proposals', 'timeline_events', 'source_links', 'sync_runs', 'ai_runs']) {
    assert.doesNotMatch(stateSection, new RegExp(`["']${name}["']`))
    assert.doesNotMatch(collectionSection, new RegExp(`'${name}'`))
  }
  assert.match(collectionSection, /'tasks', 'daily_tasks', 'captures', 'day_records'/)
  assert.match(source, /function sanitizeDayRecord/)
  assert.match(desktopFunction, /function sanitizeDayRecordDocument/)
  assert.match(source, /manualInputs: mergeDailyManualInputs\(day\.manualInputs\)/)
  assert.match(desktopFunction, /value\.manualInputs !== undefined \? \{ manualInputs \} : \{\}/)
  assert.match(desktopFunction, /collection === 'captures'\) return \{ entryKind: 'journal_entry' \}/)
  assert.match(desktopFunction, /collection === 'daily_tasks'\) return \{ entryKind: 'today_todo' \}/)
  assert.match(stateSection, /filter\(isTodayTodoRecord\)/)
  assert.match(source, /historyScopeVersion/)
  assert.match(source, /includeAllDailyTasks/)
  assert.doesNotMatch(desktopFunction.slice(
    desktopFunction.indexOf('async function pull'),
    desktopFunction.indexOf('async function push')
  ), /\.skip\(/)
})

test('小记单段任务保留旧接口兼容性，额度仍标记为估算', () => {
  const notebook = read(ROOT, 'cloudfunctions', 'notebookApi', 'index.js')
  const page = read(ROOT, 'miniprogram', 'pages', 'tasks', 'index.js')
  const section = notebook.slice(notebook.indexOf('async function refreshDailyDiary'), notebook.indexOf('async function syncSnapshot'))
  assert.match(notebook, /action === 'diary\.organizeInput'/)
  assert.match(section, /Promise\.all\(\[[\s\S]*?diaryStore\.ensure[\s\S]*?list\('daily_tasks'[\s\S]*?list\('captures'/)
  assert.match(section, /quota: \{ estimated: true, functionCalls: 1, businessReadQueries: 4/)
  assert.match(section, /aiCalls \}/)
  assert.match(page, /api\.organizePendingDiaries\(/)
  assert.match(notebook, /action === 'diary\.organizationStep'[\s\S]*?maxParts: 1/)
  assert.doesNotMatch(page, /setInterval\(/)
})

test('手机完整历史只在修订变化时读取，无变化仍只读同步信号', () => {
  const api = read(ROOT, 'miniprogram', 'utils', 'api.js')
  const notebook = read(ROOT, 'cloudfunctions', 'notebookApi', 'index.js')
  assert.match(api, /transportRpc\('sync\.snapshot', \{ includeHistory: false, knownRevision, knownDate, cacheReady, historyProtocol: 2 \}\)/)
  assert.match(api, /snapshot\.notModified === true/)
  assert.match(notebook, /notModified: true/)
  assert.match(notebook, /businessReadQueries: 0/)
  assert.match(notebook, /Math\.ceil\(allTodoRows\.length \/ 100\)/)
  assert.match(notebook, /listAll\('daily_tasks', ownerOpenId, \{ entryKind: 'today_todo' \}, 5000\)/)
  assert.match(notebook, /historyMap/)
  assert.match(notebook, /journalSyncEntry/)
  assert.match(notebook, /journalArchive/)
  const snapshotSection = notebook.slice(notebook.indexOf('async function syncSnapshot'), notebook.indexOf('function polishTodayTodoTitle'))
  assert.doesNotMatch(snapshotSection, /list\('proposals'/)
  assert.doesNotMatch(snapshotSection, /getDoc\('day_records'/)
  assert.match(snapshotSection, /list\('day_records', ownerOpenId, \{\}, 120, 'updatedAt'\)/)
  assert.match(snapshotSection, /diaryDays:/)
  assert.match(snapshotSection, /list\('tasks'/)
  assert.doesNotMatch(snapshotSection, /await listUpcomingTodayTodos/)
  assert.doesNotMatch(snapshotSection, /await listCompletedTodayTodos/)
  assert.match(snapshotSection, /\{ entryKind: 'journal_entry' \}/)
  assert.ok(snapshotSection.indexOf('ensureDailyTodayTodoRollover') < snapshotSection.indexOf('knownRevision === revision'))
  assert.match(snapshotSection, /knownDate === date/)
})

test('跨天检查每天只在首次有意义同步执行，且没有轮询', () => {
  const notebook = read(ROOT, 'cloudfunctions', 'notebookApi', 'index.js')
  const app = read(ROOT, 'miniprogram', 'app.js')
  const section = notebook.slice(
    notebook.indexOf('async function ensureDailyTodayTodoRollover'),
    notebook.indexOf('async function todayTodoHistory')
  )
  assert.match(section, /signal && signal\.rolloverDate === date/)
  assert.match(section, /businessReadQueries: 0, writes: 0/)
  assert.match(section, /date: _\.lt\(date\)/)
  assert.match(section, /overdue\.length < 100/)
  assert.doesNotMatch(app, /setInterval\(/)
})

test('手动同步模式下页面读取本地缓存，只有启动或用户点击同步才读取云端', () => {
  const api = read(ROOT, 'miniprogram', 'utils', 'api.js')
  const candidateRefresh = read(ROOT, 'miniprogram', 'utils', 'candidate-refresh.js')
  assert.match(api, /const MANUAL_CACHED_READS = new Set/)
  for (const action of ['todayTodo.list', 'journal.overview', 'journal.listArchive', 'task.list']) {
    assert.match(api, new RegExp(`'${action.replace('.', '\\.')}']?`))
  }
  assert.match(api, /MANUAL_SYNC_ONLY && MANUAL_CACHED_READS\.has\(String\(action \|\| ''\)\)/)
  assert.match(candidateRefresh, /api\.isManualSyncOnly\(\)/)
})

test('Codex 候选刷新有界且空结果不写同步信号', () => {
  const source = read(ROOT, 'cloudfunctions', 'notebookApi', 'index.js')
  assert.doesNotMatch(source, /listAll\('captures', ownerOpenId, \{\}, 5000\)/)
  assert.doesNotMatch(source, /listAll\('proposals', ownerOpenId, \{\}, 5000\)/)
  assert.match(source, /list\('captures', ownerOpenId, \{\}, 60, 'occurredAt'\)/)
  assert.match(source, /checkedCandidates >= 12/)
  assert.match(source, /CONDITIONAL_MUTATIONS\.has\(action\) && Boolean\(data && data\.changed\)/)
})

test('候选刷新仍有三十分钟冷却', () => {
  const source = read(ROOT, 'miniprogram', 'utils', 'candidate-refresh.js')
  assert.match(source, /REFRESH_COOLDOWN_MS = 30 \* 60 \* 1000/)
  assert.match(source, /if \(!options\.force && !isDue\(\)\) return \{ skipped: true \}/)
})

test('电脑云函数保留用户长原文，仍排除 Codex 原始对话', () => {
  const { sanitizeJournalDocument } = require('../cloudfunctions/desktopSync/index.js').__test
  const manual = sanitizeJournalDocument({
    id: 'manual-long', entryKind: 'journal_entry', source: 'manual',
    journalTitle: '完整手动记录', content: '甲'.repeat(60000), rawContent: '乙'.repeat(60000),
    sessionId: 'private-session'
  })
  assert.equal(manual.content, '甲'.repeat(60000))
  assert.equal(manual.rawContent, '乙'.repeat(60000))
  assert.equal(manual.sessionId, undefined)
  const codex = sanitizeJournalDocument({
    id: 'codex-summary', entryKind: 'journal_entry', source: 'codex',
    journalTitle: '可见摘要', markdown: '## 可见摘要', content: 'raw message', rawContent: 'raw transcript'
  })
  assert.equal(codex.markdown, '## 可见摘要')
  assert.equal(codex.content, undefined)
  assert.equal(codex.rawContent, undefined)
})

test('手机日常变更使用一次批量 sync.push，并且整批只允许一次同步信号', () => {
  const notebook = read(ROOT, 'cloudfunctions', 'notebookApi', 'index.js')
  const api = read(ROOT, 'miniprogram', 'utils', 'api.js')
  const batchSection = notebook.slice(notebook.indexOf('async function pushMutations'), notebook.indexOf('async function createCapture'))

  assert.match(api, /cloudRpc\('sync\.push'/)
  assert.match(api, /DIRTY_FLUSH_DEBOUNCE_MS = 800/)
  assert.match(api, /operations: batch\.map/)
  assert.match(batchSection, /operations\.length > 50/)
  assert.match(batchSection, /requestReplay\(ownerOpenId, requestId, action, payload, principal\)/)
  assert.doesNotMatch(batchSection, /markSyncSignal/)
  assert.match(notebook, /'proposal\.refreshCodexCandidates', 'sync\.push'/)
  assert.match(notebook, /didMutate[\s\S]*markSyncSignal\(ownerOpenId, action\)/)
})

test('手机日常上传不先读取快照，手动同步按上传后接收执行', () => {
  const api = read(ROOT, 'miniprogram', 'utils', 'api.js')
  const dirtySection = api.slice(api.indexOf('async function flushDirtyQueueInternal'), api.indexOf('function flushDirtyQueueNow'))
  const syncSection = api.slice(api.indexOf('async function syncNowInternal'), api.indexOf('function syncNow(options'))

  assert.match(dirtySection, /const confirmed = readConfirmedSnapshot\(\)/)
  assert.match(dirtySection, /const flush = await flushQueue\(/)
  assert.doesNotMatch(dirtySection, /syncNowInternal\(\{ includeBootstrap: true, skipQueueFlush: true \}\)/)
  assert.ok(syncSection.indexOf('await flushQueue') < syncSection.indexOf("transportRpc('sync.snapshot'"))
  assert.match(syncSection, /confirmedReady/)
})

test('批量同步额度契约区分无变化和 N 条变化', () => {
  const cloud = require('../cloudfunctions/notebookApi/index.js').__test
  assert.equal(cloud.syncPushNeedsSignal([
    { ok: true, changed: false, replayed: true },
    { ok: false, changed: false }
  ]), false)
  assert.equal(cloud.syncPushNeedsSignal([
    { ok: true, changed: false },
    { ok: true, changed: true },
    { ok: true, changed: true }
  ]), true)
  const routineMobileWrites = [
    'todayTodo.add', 'todayTodo.complete', 'todayTodo.reopen', 'todayTodo.defer', 'todayTodo.delete',
    'todayTodo.setPin', 'todayTodo.reorder', 'todayTodo.commentAdd', 'todayTodo.commentDelete',
    'journal.create', 'journal.toggleItem', 'journal.append',
    'capture.setFavorite', 'capture.hide', 'capture.restoreHidden',
    'task.update', 'task.completeStep', 'task.archive'
  ]
  for (const action of routineMobileWrites) assert.equal(cloud.SYNC_PUSH_MUTATIONS.has(action), true, action)
  const remoteRequiredWrites = [
    'proposal.apply', 'proposal.applyAll', 'proposal.reject', 'proposal.delete',
    'proposal.update', 'proposal.defer', 'proposal.restore', 'task.reanalyze'
  ]
  for (const action of remoteRequiredWrites) assert.equal(cloud.SYNC_PUSH_MUTATIONS.has(action), false, action)
  assert.equal(cloud.SYNC_PUSH_MUTATIONS.has('timeline.update'), false)
  assert.equal(cloud.SYNC_PUSH_MUTATIONS.has('data.deleteAll'), false)
})

test('云端待办兼容缺失状态和排序字段，并遵守自动优先置顶开关', () => {
  const cloud = require('../cloudfunctions/notebookApi/index.js').__test
  const mini = loadCommonJs(path.join(ROOT, 'miniprogram', 'utils', 'sync-policy.js'))
  const missing = { id: 'missing', createdAt: '2026-08-18T10:00:00.000Z' }
  const completed = { id: 'done', status: 'done', sortRank: 999999 }
  const planned = { id: 'planned', status: 'planned', sortRank: 1 }
  const rows = [missing, completed, planned]
  assert.equal(cloud.todayTodoStatus(missing), '')
  assert.deepEqual(
    [...rows].sort(cloud.compareTodayTodos).map((item) => item.id),
    Array.from(mini.sortTodayTodos(rows), (item) => item.id)
  )
  assert.equal([completed, missing].sort(cloud.compareTodayTodos)[0].id, 'missing')
  assert.equal(cloud.autoPinHighPriorityEnabled({ autoPinHighPriorityTodos: false }), false)
  assert.equal(cloud.autoPinHighPriorityEnabled({ settings: { autoPinHighPriorityTodos: false } }), false)
  assert.equal(cloud.autoPinHighPriorityEnabled({}), true)
  assert.deepEqual(cloud.carriedTodayTodoPin({
    pinned: true,
    priorityPinned: true,
    pinnedAt: '2026-08-20T08:00:00.000Z'
  }, '2026-08-21T00:00:00.000Z'), {
    pinned: true,
    priorityPinned: true,
    pinnedAt: '2026-08-20T08:00:00.000Z'
  })
  assert.deepEqual(cloud.carriedTodayTodoPin({}, '2026-08-21T00:00:00.000Z'), {
    pinned: false,
    priorityPinned: false,
    pinnedAt: ''
  })
})

test('ordinary desktop sync does not replace task baselines; legacy callers retain an idempotent merge', () => {
  const desktop = read(DESKTOP_ROOT, 'electron', 'cloud-sync.cjs')
  const cloud = read(ROOT, 'cloudfunctions', 'desktopSync', 'index.js')
  assert.match(desktop, /taskScopeVersion/)
  assert.doesNotMatch(desktop, /"sync\.replaceTasks"/)
  assert.match(cloud, /task_baseline_/)
  assert.match(cloud, /receipt && receipt\.result/)
  assert.match(cloud, /action === 'sync\.replaceTasks'/)
  assert.doesNotMatch(desktop, /setInterval\(/)
})

test('电脑端无变化时只读取同步修订号，不再拉取三类完整数据', () => {
  const desktop = read(DESKTOP_ROOT, 'electron', 'cloud-sync.cjs')
  const cloud = read(ROOT, 'cloudfunctions', 'desktopSync', 'index.js')
  assert.match(desktop, /cloudCall\(activeConfig\.endpoint, activeConfig\.token, "sync\.head", \{ protocol: 2 \}\)/)
  assert.match(desktop, /head\.revision === activeConfig\.lastCloudRevision/)
  assert.match(desktop, /fastPath: true/)
  assert.match(cloud, /action === 'sync\.head'/)
  assert.match(cloud, /businessReadQueries: 0/)
})

test('旧游标只做一次有界修复，之后仍走无变化快速路径', () => {
  const desktop = read(DESKTOP_ROOT, 'electron', 'cloud-sync.cjs')
  const cloud = require('../cloudfunctions/desktopSync/index.js').__test
  assert.match(desktop, /pullCursorRepairVersion/)
  assert.match(desktop, /cursor: freshPullCursor\(\)/)
  assert.match(desktop, /!cursorRepairRequired && !includeAllDailyTasks && !localAttachmentUploadRequired && !pendingOperations\.length/)
  assert.equal(cloud.normalizePullCursor({ v: 2, positions: {
    daily_tasks: { at: '2026-08-20T07:39:54.623Z', offset: 1, legacy: false }
  } }).v, 5)
})

test('删除全部数据后重新激活同步信号，让电脑收到整批墓碑', () => {
  const notebook = read(ROOT, 'cloudfunctions', 'notebookApi', 'index.js')
  assert.match(notebook, /action, source: 'wechat', sourceDeviceId: '', changedAt, revision, deletedAt: ''/)
  assert.match(notebook, /const syncReceipt = didMutate\s*\? await markSyncSignal\(ownerOpenId, action\)/)
})
