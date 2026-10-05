const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { __test } = require('../cloudfunctions/notebookApi/index.js')

function loadPresenter() {
  const file = path.join(__dirname, '..', 'miniprogram', 'pages', 'capture', 'presenter.js')
  const module = { exports: {} }
  new Function('module', 'exports', 'require', fs.readFileSync(file, 'utf8'))(module, module.exports, require('node:module').createRequire(file))
  return module.exports
}

function capture(id, date, extra = {}) {
  return {
    id,
    entryKind: 'journal_entry',
    ownerOpenId: 'workspace_test',
    source: 'manual',
    occurredAt: `${date}T02:00:00.000Z`,
    createdAt: `${date}T02:00:00.000Z`,
    deletedAt: '',
    trashedAt: '',
    ...extra
  }
}

test('organized manual journal sync preserves user input but omits private archive fields', () => {
  const synced = __test.journalSyncEntry({
    id: 'journal-sync',
    entryKind: 'journal_entry',
    source: 'manual',
    journalTitle: '可检索标题',
    journalSummary: '简洁摘要',
    markdown: '## 标题\n- [ ] 项目',
    checklistItems: [{ id: 'item', text: '项目', done: false }],
    rawContent: '冗长原始对话',
    content: '原始输入',
    sessionId: 'session-private',
    cwd: 'C:\\private',
  })
  assert.equal(synced.journalTitle, '可检索标题')
  assert.equal(synced.markdown.includes('- [ ]'), true)
  assert.equal(synced.rawContent, '冗长原始对话')
  assert.equal(synced.content, '原始输入')
  assert.equal(synced.sessionId, undefined)
  assert.equal(synced.cwd, undefined)
})

test('organized Codex journal sync omits the raw transcript', () => {
  const synced = __test.journalSyncEntry({
    id: 'journal-codex', entryKind: 'journal_entry', source: 'codex',
    journalTitle: '可见摘要', markdown: '## 可见摘要',
    rawContent: 'raw Codex transcript', content: 'raw Codex message'
  })
  assert.equal(synced.journalTitle, '可见摘要')
  assert.equal(synced.rawContent, undefined)
  assert.equal(synced.content, undefined)
})

test('Codex prompt、assistant、tool 和 reasoning 记录不能伪装成灵光一现同步', () => {
  for (const kind of ['user_prompt', 'assistant_message', 'tool_output', 'reasoning']) {
    assert.equal(__test.journalSyncEntry({
      id: `internal-${kind}`, entryKind: 'journal_entry', source: 'codex', kind,
      journalTitle: '不应同步', markdown: '## 不应同步'
    }), null)
  }
})

test('灵光一现按今天、收藏、隐藏和历史分组', () => {
  const overview = __test.journalOverviewFromEntries([
    capture('today', '2026-08-10'),
    capture('favorite', '2026-08-09', { favoritedAt: '2026-08-10T03:00:00.000Z' }),
    capture('hidden', '2026-08-10', { hiddenAt: '2026-08-10T04:00:00.000Z' }),
    capture('history', '2026-08-08'),
    capture('old', '2026-07-01'),
  ], '2026-08-10', 14)

  assert.deepEqual(overview.entries.map((item) => item.id), ['today'])
  assert.deepEqual(overview.favorites.map((item) => item.id), ['favorite'])
  assert.deepEqual(overview.hidden.map((item) => item.id), ['hidden'])
  assert.deepEqual(overview.history.map((group) => group.date), ['2026-08-09', '2026-08-08'])
  assert.deepEqual(overview.history[0].entries.map((item) => item.id), ['favorite'])
})

test('缺少 journalDate 的旧灵光一现按上海日期归档，且不依赖每日小计记录', () => {
  const legacy = capture('legacy-shanghai-midnight', '2026-09-19', {
    occurredAt: '2026-09-19T16:30:00.000Z',
    createdAt: '2026-09-19T16:30:00.000Z',
    journalDate: '',
  })
  const overview = __test.journalOverviewFromEntries([legacy], '2026-09-20', 14)

  assert.deepEqual(overview.entries.map((item) => item.id), ['legacy-shanghai-midnight'])
  assert.equal(overview.history.length, 0)
  assert.equal(__test.journalSyncEntry(legacy).journalDate, '2026-09-20')
})

test('时间线结果和候选日期不使用 UTC 字符串前缀', () => {
  assert.equal(__test.journalEntryDate({ occurredAt: '2026-09-19T16:30:00.000Z', journalDate: '' }), '2026-09-20')
  const source = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions/notebookApi/index.js'), 'utf8')
  assert.doesNotMatch(source, /capture\.occurredAt \|\| ''\)\.slice\(0, 10\)/)
  assert.doesNotMatch(source, /event\.occurredAt \|\| ''\)\.slice\(0, 10\)/)
})

test('收藏的今日记录仍保留在今天列表，隐藏记录不重复出现', () => {
  const overview = __test.journalOverviewFromEntries([
    capture('favorite-today', '2026-08-10', { favoritedAt: '2026-08-10T05:00:00.000Z' }),
    capture('hidden-favorite', '2026-08-10', { favoritedAt: '2026-08-10T05:00:00.000Z', hiddenAt: '2026-08-10T06:00:00.000Z' }),
  ], '2026-08-10', 14)

  assert.deepEqual(overview.entries.map((item) => item.id), ['favorite-today'])
  assert.deepEqual(overview.favorites.map((item) => item.id), ['favorite-today'])
  assert.deepEqual(overview.hidden.map((item) => item.id), ['hidden-favorite'])
})

test('小程序缓存即使暂时重复返回隐藏记录，也只在隐藏栏展示', () => {
  const { presentOverview } = loadPresenter()
  const hidden = capture('hidden-cache', '2026-08-10', { hiddenAt: '2026-08-10T06:00:00.000Z' })
  const overview = presentOverview({
    entries: [hidden], favorites: [hidden], hidden: [hidden],
    history: [{ date: '2026-08-10', entries: [hidden] }]
  })
  assert.deepEqual(overview.entries, [])
  assert.deepEqual(overview.favorites, [])
  assert.equal(overview.history.length, 0)
  assert.deepEqual(overview.hidden.map((item) => item.id), ['hidden-cache'])
})

test('Codex 记录必须存在可见整理摘要才进入灵光一现', () => {
  const empty = capture('codex-empty', '2026-08-10', { source: 'codex', organizationSummary: '' })
  const visible = capture('codex-visible', '2026-08-10', {
    source: 'codex', journalTitle: '页面结构调整', organizationSummary: '确认了新的页面结构'
  })
  assert.equal(__test.isJournalVisibleCapture(empty), false)
  assert.equal(__test.isJournalVisibleCapture(visible), true)
})

test('小程序导航与电脑版统一为四项，待确认并入灵光一现', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const root = path.resolve(__dirname, '..')
  const app = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8'))
  const captureWxml = fs.readFileSync(path.join(root, 'miniprogram/pages/capture/index.wxml'), 'utf8')
  assert.equal(app.tabBar.list.length, 4)
  assert.equal(app.tabBar.list.some((item) => item.pagePath === 'pages/inbox/index'), false)
  assert.match(captureWxml, /待确认/)
  assert.match(captureWxml, /收藏/)
  assert.match(captureWxml, /隐藏记录/)
  assert.match(captureWxml, /历史记录/)
})

test('隐藏入口对今天和历史记录都可用，并固定显示在历史记录下方', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const root = path.resolve(__dirname, '..')
  const captureWxml = fs.readFileSync(path.join(root, 'miniprogram/pages/capture/index.wxml'), 'utf8')

  assert.match(captureWxml, /wx:if="\{\{!readonly \|\| allowHide \|\| allowFavorite\}\}" class="entry-actions"/)
  assert.match(captureWxml, /data="\{\{entry: historyEntry, readonly: true, allowHide: true, allowFavorite: true\}\}"/)
  assert.match(captureWxml, /<text>隐藏记录<\/text><text class="entry-count">\{\{hidden\.length\}\}<\/text>/)
  assert.doesNotMatch(captureWxml, /wx:if="\{\{hidden\.length\}\}" class="record-group muted-group"/)
  assert.ok(captureWxml.indexOf('隐藏记录') > captureWxml.indexOf('历史记录'))
})

test('手机收藏栏始终可见，历史记录可以直接收藏', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const root = path.resolve(__dirname, '..')
  const captureWxml = fs.readFileSync(path.join(root, 'miniprogram/pages/capture/index.wxml'), 'utf8')
  const captureJs = fs.readFileSync(path.join(root, 'miniprogram/pages/capture/index.js'), 'utf8')
  const capturePresenter = fs.readFileSync(path.join(root, 'miniprogram/pages/capture/presenter.js'), 'utf8')

  assert.match(captureWxml, /<view class="record-group favorite-group">/)
  assert.doesNotMatch(captureWxml, /wx:if="\{\{favorites\.length\}\}" class="record-group"/)
  assert.match(captureWxml, /\(!readonly \|\| allowFavorite\) && !entry\.hidden/)
  assert.match(captureWxml, /还没有收藏，可以从下面的今天记录或历史记录中选择。/)
  assert.match(captureWxml, /history-favorite-count/)
  assert.match(`${captureJs}\n${capturePresenter}`, /favoriteCount: \(group\.entries \|\| \[\]\)\.filter/)
})

test('灵光一现完整移动端样式不能被覆盖成单行残片', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const root = path.resolve(__dirname, '..')
  const styles = fs.readFileSync(path.join(root, 'miniprogram/pages/capture/index.wxss'), 'utf8')

  assert.ok(styles.length > 8000)
  assert.match(styles, /\.journal-composer\{/)
  assert.match(styles, /\.journal-card\{/)
  assert.match(styles, /\.journal-card\{[^}]*border:2rpx solid #aebaf0[^}]*background:#f8f9ff/)
  assert.match(styles, /\.journal-card\.is-favorite\{[^}]*border-color:#ead7a9[^}]*background:#fffdf8/)
  assert.doesNotMatch(styles, /\.journal-card\.is-readonly\{[^}]*background:/)
  assert.match(styles, /\.pending-panel\{/)
  assert.match(styles, /\.check-row\{/)
  assert.match(styles, /\.favorite-group|\.favorite-symbol/)
  assert.match(styles, /\.history-favorite-count\{/)
})

test('收藏变更成功后不再额外整页刷新，避免浪费云端读取额度', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const root = path.resolve(__dirname, '..')
  const source = fs.readFileSync(path.join(root, 'miniprogram/pages/capture/index.js'), 'utf8')
  const mutateRecord = source.slice(source.indexOf('async mutateRecord'), source.indexOf('toggleMarkdown', source.indexOf('async mutateRecord')))
  const createEntry = source.slice(source.indexOf('async createEntry'), source.indexOf('async toggleItem', source.indexOf('async createEntry')))

  assert.doesNotMatch(mutateRecord, /this\.refresh\(/)
  assert.doesNotMatch(createEntry, /this\.refresh\(/)
  assert.match(mutateRecord, /this\.applyOverview\(cache\.read\(cache\.KEYS\.journal/)
})

test('灵光一现读取只查询 journal_entry，启动快照保留完整历史范围', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const root = path.resolve(__dirname, '..')
  const cloud = fs.readFileSync(path.join(root, 'cloudfunctions/notebookApi/index.js'), 'utf8')

  assert.match(cloud, /listAll\('captures', ownerOpenId, \{ entryKind: 'journal_entry' \}, 5000\)/)
  assert.doesNotMatch(cloud, /listAll\('captures', ownerOpenId, \{ entryKind: 'journal_entry' \}, 300\)/)
  assert.match(cloud, /journalOverviewFromEntries\(journalEntries, date, 3650\)/)
  assert.doesNotMatch(cloud, /listAll\('captures', ownerOpenId, \{ deletedAt: '' \}, 5000\)/)
})

test('旧快照分页有稳定编号顺序，达到上限时不能静默截断历史', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions/notebookApi/index.js'), 'utf8')
  const listAllBody = source.slice(source.indexOf('async function listAll('), source.indexOf('\n}\n\nasync function legacyOwnerGuard'))
  assert.match(listAllBody, /orderBy\('_id', 'asc'\)/)
  assert.match(listAllBody, /code: 'HISTORY_CAPACITY'/)
  assert.match(listAllBody, /请使用分页历史接口继续读取/)
})
