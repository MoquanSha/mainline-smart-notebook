import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { handleAction, createCloudInitialState } from '../server.mjs';
const require = createRequire(import.meta.url);
const { cloudRuntime } = require('../../wechat-mini-program-0.10.37-login-copy-20260905/tests/helpers/cloud-runtime.cjs');
const workspaceId = 'space-receive-test';
const sha = (value) => createHash('sha256').update(value).digest('hex');

async function fixture(t, { ordered = false, local = {}, config = {}, seed = [] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mainline-receive-'));
  const cloud = cloudRuntime();
  const token = 'synthetic-test-token';
  const previousFetch = globalThis.fetch, previousFlag = process.env.ENABLE_ORDERED_SYNC, previousIndexes = process.env.ORDERED_SYNC_INDEXES_VERIFIED;
  if (ordered) { process.env.ENABLE_ORDERED_SYNC = 'true'; process.env.ORDERED_SYNC_INDEXES_VERIFIED = 'true'; } else { delete process.env.ENABLE_ORDERED_SYNC; delete process.env.ORDERED_SYNC_INDEXES_VERIFIED; }
  t.after(async () => {
    globalThis.fetch = previousFetch;
    if (previousFlag === undefined) delete process.env.ENABLE_ORDERED_SYNC; else process.env.ENABLE_ORDERED_SYNC = previousFlag;
    if (previousIndexes === undefined) delete process.env.ORDERED_SYNC_INDEXES_VERIFIED; else process.env.ORDERED_SYNC_INDEXES_VERIFIED = previousIndexes;
    // Only the exact directory created by this test is removed.
    assert.ok(directory.startsWith(join(tmpdir(), 'mainline-receive-')));
    await rm(directory, { recursive: true, force: true });
  });
  cloud.rows.set('devices/test-device', { id: 'test-device', workspaceId, userId: 'test-user', deviceTokenHash: sha(token), status: 'paired', deletedAt: '', lastSeenAt: new Date().toISOString() });
  for (const [collection, document] of seed) cloud.rows.set(`${collection}/${document.id}`, { ownerOpenId: workspaceId, workspaceId, deletedAt: '', ...document });
  const state = Object.assign(createCloudInitialState(), local);
  const file = require.resolve('../electron/cloud-sync.cjs');
  const native = createRequire(file), module = { exports: {} }, hooks = {};
  new Function('require', 'module', 'exports', readFileSync(file, 'utf8'))((id) => id === 'electron'
    ? { safeStorage: { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() } }
    : id === 'node:fs/promises' ? { ...native(id), open: async (...args) => {
      if (hooks.failCheckpoint) throw new Error('synthetic checkpoint disk failure');
      return native(id).open(...args);
    } } : native(id), module, module.exports);
  const settings = { endpoint: 'https://cloud.test.invalid', encryptedToken: Buffer.from(token).toString('base64'), workspaceId, deviceId: 'test-device', userId: 'test-user', ...config };
  await writeFile(join(directory, 'cloud-sync.json'), JSON.stringify(settings));
  await writeFile(join(directory, 'notebook.json'), JSON.stringify(state));
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    if (url === 'http://local.test.invalid/api/state') return { ok: true, json: async () => structuredClone(state) };
    if (url === 'http://local.test.invalid/api/action') {
      if (hooks.beforeMerge) await hooks.beforeMerge();
      await handleAction(state, JSON.parse(init.body));
      await writeFile(join(directory, 'notebook.json'), JSON.stringify(state));
      return { ok: true, json: async () => ({ ok: true }) };
    }
    assert.equal(url, settings.endpoint, 'all test requests must stay in the injected transport');
    const request = JSON.parse(init.body);
    calls.push(request);
    if (hooks.beforeCloud) await hooks.beforeCloud(request);
    const result = await cloud.desktop.main({ ...request, headers: init.headers });
    if (hooks.afterCloud) await hooks.afterCloud(request, result);
    return { ok: true, status: 200, json: async () => result };
  };
  return { directory, state, cloud, calls, hooks, sync: (options) => module.exports.sync(directory, 'http://local.test.invalid', options),
    call: (action, payload) => cloud.desktop.main({ action, payload, headers: { Authorization: `Bearer ${token}` } }),
    config: async () => JSON.parse(await readFile(join(directory, 'cloud-sync.json'), 'utf8')) };
}

test('ordinary first sync merges a partial desktop and never replaces cloud-only tasks', async (t) => {
  const f = await fixture(t, { local: { captures: [{ id: 'local-note', entryKind: 'journal_entry', source: 'manual', content: '电脑只有这段记录', journalDate: '2026-09-24' }] },
    seed: [['tasks', { id: 'cloud-only', title: '手机已有的长期任务', status: 'active', createdAt: '2026-09-24', updatedAt: '2026-09-24', version: 1 }]] });
  await f.sync();
  assert.equal(f.calls.filter((item) => item.action === 'sync.replaceTasks').length, 0);
  assert.ok(f.state.tasks.some((row) => row.id === 'cloud-only' && !row.deletedAt));
  assert.equal([...f.cloud.rows.values()].find((row) => row.id === 'cloud-only').deletedAt, '');
});

test('legacy baseline callers are compatible but can no longer remove absent cloud tasks', async (t) => {
  const f = await fixture(t, { seed: [['tasks', { id: 'cloud-only', title: '保留云端任务', version: 1 }]] });
  const result = await f.call('sync.replaceTasks', { tasks: [], baselineId: 'desktop-task-scope-v1' });
  assert.equal(result.ok, true);
  assert.equal(result.data.removed, 0);
  assert.equal(result.data.taskCursor.at, '');
  assert.equal(f.cloud.rows.get('tasks/cloud-only').deletedAt, '');
  const repeated = await f.call('sync.replaceTasks', { tasks: [], baselineId: 'desktop-task-scope-v1' });
  assert.equal(repeated.data.reused, true);
});

test('desktop receives all 245 equal-timestamp historic rows in bounded resumable pages', async (t) => {
  const seed = Array.from({ length: 245 }, (_, i) => ['tasks', { id: `task-${String(i).padStart(3, '0')}`, title: `历史 ${i}`, status: 'active', updatedAt: '2026-09-20', version: 1 }]);
  const f = await fixture(t, { ordered: true, seed });
  let result;
  for (let n = 0; n < 12; n++) {
    result = await f.sync({ pageBudget: 2 });
    if (!result.receivePending) break;
  }
  assert.equal(f.state.tasks.length, 245);
  assert.equal(result.receivePending, false);
  assert.ok(f.calls.some((item) => item.action === 'sync.historyPage'));
  assert.equal(f.calls.filter((item) => item.action === 'sync.pull').length, 0);
});

test('an edit arriving during idle head check is never acknowledged by the old snapshot', async (t) => {
  const local = { tasks: [{ id: 'known', title: '已确认的原文', updatedAt: '2026-09-20', status: 'active' }] };
  const actual = require('../electron/cloud-sync.cjs');
  const f = await fixture(t, { local, config: { taskScopeVersion: 1, syncScopeVersion: 6, historyScopeVersion: 1, pullCursorRepairVersion: 2, pushConfirmationRepairVersion: 2,
    lastPushAt: '2026-09-25T23:59:59Z', lastCloudRevision: 'initial', pushHashes: actual.buildPushHashes(local) } });
  f.hooks.afterCloud = async (request) => {
    if (request.action === 'sync.head') { f.state.tasks[0].title = '等待期间补写的原文'; delete f.hooks.afterCloud; }
  };
  await f.sync();
  const settings = await f.config();
  assert.notEqual(settings.pushHashes['tasks:known'], actual.buildPushHashes(f.state)['tasks:known']);
  await f.sync();
  assert.ok(f.calls.some((item) => item.action === 'sync.push' && item.payload.operations.some((op) => op.data.title === '等待期间补写的原文')));
});

test('failed history page resumes from last durable checkpoint and idle does not reread history', async (t) => {
  const seed = Array.from({ length: 245 }, (_, i) => ['tasks', { id: `task-${String(i).padStart(3, '0')}`, title: `历史 ${i}`, status: 'active', version: 1 }]);
  const f = await fixture(t, { ordered: true, seed });
  let pages = 0;
  f.hooks.beforeCloud = async (request) => {
    if (request.action === 'sync.historyPage' && ++pages === 2) throw new Error('page interrupted');
  };
  await assert.rejects(f.sync(), /page interrupted/);
  assert.equal(f.state.tasks.length, 99);
  const checkpoint = (await f.config()).orderedSync;
  assert.equal(checkpoint.cursor.after, 'task-098');
  f.hooks.beforeCloud = undefined;
  const start = f.calls.length;
  let result = await f.sync();
  while (result.receivePending) result = await f.sync();
  assert.deepEqual(f.calls.slice(start).find((item) => item.action === 'sync.historyPage').payload.cursor, checkpoint.cursor);
  assert.equal(f.state.tasks.length, 245);
  const idleStart = f.calls.length, writes = f.cloud.metrics.writes, reads = f.cloud.metrics.reads;
  const idle = await f.sync();
  assert.equal(idle.fastPath, true);
  assert.deepEqual(f.calls.slice(idleStart).map((item) => item.action), ['sync.head']);
  assert.equal(f.cloud.metrics.writes, writes);
  assert.equal(f.cloud.metrics.reads - reads, 1, 'the warm idle check reads only the head document in the local emulator');
});

test('local page save failure keeps progress behind data and a retry replays safely', async (t) => {
  const f = await fixture(t, { ordered: true, seed: [['tasks', { id: 'a', title: '不能先确认', status: 'active', version: 1 }]] });
  f.hooks.beforeMerge = () => { throw new Error('disk full'); };
  await assert.rejects(f.sync(), /disk full/);
  assert.equal((await f.config()).orderedSync, undefined);
  f.hooks.beforeMerge = undefined;
  await f.sync();
  assert.equal(f.state.tasks.length, 1);
  assert.equal(f.state.tasks[0].title, '不能先确认');
});

test('crash between record save and checkpoint publication replays without loss or duplicates', async (t) => {
  const f = await fixture(t, { ordered: true, seed: [['tasks', { id: 'a', title: '磁盘已有原文', status: 'active', version: 1 }]] });
  f.hooks.failCheckpoint = true;
  await assert.rejects(f.sync(), /checkpoint disk failure/);
  assert.equal(JSON.parse(await readFile(join(f.directory, 'notebook.json'), 'utf8')).tasks.length, 1);
  assert.equal((await f.config()).orderedSync, undefined);
  f.hooks.failCheckpoint = false;
  await f.sync();
  assert.equal(f.state.tasks.length, 1);
});

test('bootstrap catches insertion behind the ID cursor and deletion committed during reading', async (t) => {
  const seed = Array.from({ length: 120 }, (_, i) => ['tasks', { id: `task-${String(i).padStart(3, '0')}`, title: `历史 ${i}`, status: 'active', version: 1 }]);
  const f = await fixture(t, { ordered: true, seed });
  const { withSyncSequence } = require('../../wechat-mini-program-0.10.37-login-copy-20260905/cloudfunctions/desktopSync/sync-database.js');
  const db = withSyncSequence(f.cloud.db);
  f.hooks.afterCloud = async (request) => {
    if (request.action !== 'sync.historyPage') return;
    delete f.hooks.afterCloud;
    await db.collection('tasks').doc('before-cursor').set({ id: 'before-cursor', ownerOpenId: workspaceId, title: '分页时手机新增', status: 'active', version: 1 });
    await db.collection('tasks').doc('task-000').update({ deletedAt: '2026-09-25T00:00:00Z', version: 2 });
  };
  let result = await f.sync();
  while (result.receivePending) result = await f.sync();
  assert.ok(f.state.tasks.some((row) => row.id === 'before-cursor'));
  assert.ok(f.state.tasks.find((row) => row.id === 'task-000').deletedAt);
  assert.ok(result.receivedThrough >= 2);
  assert.equal(f.state.tasks.find((row) => row.id === 'task-000').steps.length, 1, 'replaying a legacy task must not generate extra steps');
});

test('aborting an old account request prevents its page from reaching the local server', async (t) => {
  const f = await fixture(t, { ordered: true, seed: [['tasks', { id: 'private-a', title: 'A 的内容', status: 'active' }]] });
  const controller = new AbortController();
  f.hooks.afterCloud = async (request) => { if (request.action === 'sync.historyPage') controller.abort(); };
  await assert.rejects(f.sync({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.state.tasks.length, 0);
  assert.equal((await f.config()).orderedSync, undefined);
});

test('changed login cannot reuse a previous account checkpoint', async (t) => {
  const f = await fixture(t, { ordered: true });
  await f.sync();
  const saved = await f.config();
  saved.userId = 'different-user';
  await writeFile(join(f.directory, 'cloud-sync.json'), JSON.stringify(saved));
  await assert.rejects(f.sync(), { code: 'SYNC_CHECKPOINT_INVALID' });
});

test('the two backends ship the same history/sequence paging contract', () => {
  const a = require.resolve('../../wechat-mini-program-0.10.37-login-copy-20260905/cloudfunctions/notebookApi/history-page.js');
  const b = require.resolve('../../wechat-mini-program-0.10.37-login-copy-20260905/cloudfunctions/desktopSync/history-page.js');
  assert.equal(readFileSync(a, 'utf8'), readFileSync(b, 'utf8'));
});

test('a long user-authored journal survives actual ordered receive and upload serializers', async (t) => {
  const content = '原文可能有歧义，费用不是 120 元。\n'.repeat(1000);
  const f = await fixture(t, { ordered: true, seed: [['captures', { id: 'long-original', entryKind: 'journal_entry', source: 'wechat', content, rawContent: content, journalDate: '2026-09-20', version: 1 }]] });
  let result = await f.sync();
  for (let i = 0; i < 8 && result.receivePending; i++) result = await f.sync();
  assert.equal(f.state.captures.find((row) => row.id === 'long-original').rawContent, content);
  assert.equal(f.cloud.desktop.sanitizeJournalDocument({ ...f.state.captures.find((row) => row.id === 'long-original') }).content, content);
});
