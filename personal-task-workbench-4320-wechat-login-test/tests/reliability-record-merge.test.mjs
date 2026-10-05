import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { handleAction, createCloudInitialState, purgeExpiredTrash } from '../server.mjs';
const require = createRequire(import.meta.url);
const sync = require('../electron/cloud-sync.cjs');
const { cloudRuntime } = require('../../wechat-mini-program-0.10.37-login-copy-20260905/tests/helpers/cloud-runtime.cjs');
const { inputRevision } = require('../electron/record-merge.cjs');
const { mergeRecord, deletionKey } = require('../electron/record-merge.cjs');
const row = (patch = {}) => ({ id: 'a', entryKind: 'today_todo', status: 'planned', title: '原文', date: '2026-09-24', comments: [], ...patch });
const state = (rows) => ({ tasks: [], captures: [], dailyTasks: rows, days: [], proposals: [], timeline: [], sourceLinks: [], syncRuns: [], aiRuns: [], settings: {} });

test('cloud merge respects deletion even when offline computer clock is newer', async () => {
  const local = state([row({ updatedAt: '2026-09-26T00:00:00Z' })]);
  await handleAction(local, { action: 'cloud.merge', collections: { dailyTasks: [row({ status: 'removed', trashedAt: '2026-09-24T00:00:00Z', updatedAt: '2026-09-24T00:00:00Z', version: 2 })] } });
  assert.equal(local.dailyTasks[0].status, 'removed');
  assert.ok(local.dailyTasks[0].trashedAt);
});

test('conflicting journal bodies survive together instead of replacing the older-clock body', () => {
  const merged = sync.mergeConflictOperation({ collection: 'captures', id: 'a', data: { id: 'a', content: '电脑原文，不确定费用是 120 元', updatedAt: '2026-09-24T01:00:00Z' } }, { id: 'a', content: '手机原文，费用 130 元', updatedAt: '2026-09-24T02:00:00Z' }).data;
  const bodies = new Set((merged.conflictVersions || []).map((item) => item.body.content));
  assert.ok(bodies.has('电脑原文，不确定费用是 120 元'));
  assert.ok(bodies.has('手机原文，费用 130 元'));
});

test('comment tombstones dominate stale comments while independent comments and attachments union', () => {
  const merged = sync.mergeComments([{ id: 'c', content: '电脑补充', updatedAt: '2099-01-01', attachments: [{ id: 'image-a', fileID: 'a' }] }, { id: 'new', content: '独立评论' }], [{ id: 'c', content: '手机补充', deletedAt: '2026-09-24', attachments: [{ id: 'image-b', fileID: 'b' }] }]);
  const comment = merged.find((item) => item.id === 'c');
  assert.ok(comment.deletedAt);
  assert.equal(comment.attachments.length, 2);
  assert.equal(merged.length, 2);
  assert.equal(new Set(comment.conflictVersions.map((item) => item.body.content)).size, 2);
});

test('pull/rebase keeps the pending original body and never revives a cloud deletion', () => {
  const pending = { collection: 'daily_tasks', id: 'a', baseVersion: 1, data: row({ description: '未上传的文字' }) };
  const result = sync.rebasePendingOperations([pending], state([row({ description: '云端旧文字', status: 'removed', trashedAt: '2026-09-24', version: 2 })]))[0];
  assert.ok(result.data.trashedAt);
  assert.ok(result.data.conflictVersions.some((item) => item.body.description === '未上传的文字'));
});

test('same input ID with two distinct originals preserves both and converges on replay', () => {
  const a = [{ id: 'original', content: '第一份原文', createdAt: '2026-09-24T00:00:00Z' }];
  const b = [{ id: 'original', content: '第二份原文', createdAt: '2026-09-24T00:00:00Z' }];
  const merged = sync.mergeDailyManualInputs(a, b);
  assert.equal(merged.length, 2);
  assert.deepEqual(sync.mergeDailyManualInputs(merged, b), merged);
  assert.deepEqual(sync.mergeDailyManualInputs(a, b), sync.mergeDailyManualInputs(b, a));
});

test('real desktop/cloud push receipts converge without repeated idle uploads, including day records', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-24T06:00:00Z') });
  const cloud = cloudRuntime();
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    assert.equal(request.action, 'sync.push');
    return { ok: true, json: async () => ({ ok: true, data: await cloud.desktop.push('space-a', request.payload.operations) }) };
  };
  const originals = [{ id: 'raw', content: '可能是 120 元，尚未确认', createdAt: '2026-09-24T00:00:00Z', source: 'desktop' }];
  const local = { ...state([row({ createdAt: '2026-09-24T00:00:00Z' })]),
    captures: [{ id: 'journal-a', entryKind: 'journal_entry', source: 'manual', content: '灵光原文', markdown: '灵光原文', journalTitle: '灵光', journalDate: '2026-09-24', journalSupplements: [] }],
    days: [{ id: 'day_records_2026-09-24', date: '2026-09-24', summary: '## 今日记录\n\n可能是 120 元，尚未确认', manualInputs: originals, organizationStatus: 'organized', organizationRevision: inputRevision(originals) }],
  };
  // Normal desktop mutations refresh the derived daily supplement before sync.
  await handleAction(local, { action: 'cloud.merge', collections: {} });
  const operations = sync.stateToOperations(local);
  const pushed = await sync.pushWithConflictResolution({ endpoint: 'https://test.invalid', token: 'test' }, operations);
  assert.equal(pushed.applied, 3);
  await handleAction(local, { action: 'cloud.merge', collections: sync.groupPushChangesForLocal(pushed.localChanges, local) });
  const hashes = sync.buildConfirmedPushHashes(local, operations, pushed.confirmedHashes);
  assert.equal(Object.keys(hashes).length, 3, JSON.stringify(sync.stateToOperations(local).map((op) => {
    const accepted = pushed.localChanges.find((item) => item.collection === op.collection)?.document;
    const received = accepted && sync.stateToOperations({ [{ daily_tasks: 'dailyTasks', captures: 'captures', day_records: 'days' }[op.collection]]: [accepted] })[0]?.data;
    return { collection: op.collection, changed: Object.keys(op.data).filter((key) => JSON.stringify(op.data[key]) !== JSON.stringify(received?.[key])) };
  })));
  assert.equal(sync.stateToOperations(local, '', '2026-09-24', { pushHashes: hashes }).length, 0);
  Object.assign(local.dailyTasks[0], { _id: 'a', ownerOpenId: 'space-a', sourceIds: ['private-local-archive'] });
  assert.equal(sync.stateToOperations(local, '', '2026-09-24', { pushHashes: hashes }).length, 0, 'SDK and local archive metadata do not trigger reuploads');
  local.dailyTasks[0].title = '回执到达期间又改了';
  assert.equal(sync.buildConfirmedPushHashes(local, operations, pushed.confirmedHashes)['daily_tasks:a'], undefined);
});

test('lost response and simultaneous bodies use actual cloud handlers without erasing either original', async (t) => {
  const cloud = cloudRuntime([row({ ownerOpenId: 'space-a', version: 2, title: '手机原文', deletedAt: '' })]);
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  let loseNext = true;
  globalThis.fetch = async (_url, init) => {
    const result = await cloud.desktop.push('space-a', JSON.parse(init.body).payload.operations);
    if (loseNext) { loseNext = false; throw new Error('response lost'); }
    return { ok: true, json: async () => ({ ok: true, data: result }) };
  };
  const operations = sync.stateToOperations(state([row({ title: '电脑原文', cloudVersion: 1 })]));
  await assert.rejects(sync.pushWithConflictResolution({ endpoint: 'https://test.invalid' }, operations), /response lost/);
  const result = await sync.pushWithConflictResolution({ endpoint: 'https://test.invalid' }, operations);
  const saved = cloud.rows.get('daily_tasks/a');
  assert.equal(result.unresolved, 0);
  const bodies = saved.conflictVersions.map((item) => item.body.title);
  assert.ok(bodies.includes('电脑原文') && bodies.includes('手机原文'));
  const writes = cloud.metrics.writes;
  await sync.pushWithConflictResolution({ endpoint: 'https://test.invalid' }, operations);
  assert.equal(cloud.metrics.writes, writes, 'replayed content needs no additional business or signal writes');
});

test('journal supplement conversion retains conflicts, deletion markers and more than sixty originals', () => {
  const items = Array.from({ length: 70 }, (_, i) => ({ id: `s-${i}`, content: `原文 ${i}` }));
  const entries = sync.mergeJournalSupplements(items, [{ id: 's-1', content: '手机修改', deletedAt: '2026-09-24' }]);
  assert.equal(entries.length, 70);
  const doc = sync.journalDocumentForDesktop({ journalSupplements: entries });
  const converted = sync.sanitizeJournalEntry({ ...doc, id: 'j', source: 'manual', entryKind: 'journal_entry' });
  const removed = converted.journalSupplements.find((item) => item.id === 's-1');
  assert.ok(removed.deletedAt);
  assert.equal(new Set(removed.conflictVersions.map((item) => item.body.content)).size, 2);
});

test('desktop restore carries explicit delete proof and expiry retains a sync tombstone', async () => {
  const local = createCloudInitialState();
  local.dailyTasks = [row({ status: 'removed', trashedAt: '2026-09-24T00:00:00Z', purgeAt: '2099-01-01T00:00:00Z' })];
  const deleted = structuredClone(local.dailyTasks[0]);
  await handleAction(local, { action: 'trash.restore', entityType: 'today_todo', entityId: 'a', expectedPurgeAt: deleted.purgeAt });
  assert.equal(local.dailyTasks[0].restoreOf, deletionKey(deleted));
  assert.equal(mergeRecord(deleted, local.dailyTasks[0]).status, 'planned');
  const second = { ...local.dailyTasks[0], status: 'removed', trashedAt: '2026-09-24T00:01:00Z', purgeAt: '2099-01-02T00:00:00Z' };
  local.dailyTasks[0] = second;
  await assert.rejects(handleAction(local, { action: 'trash.restore', entityType: 'today_todo', entityId: 'a', expectedPurgeAt: deleted.purgeAt }), /再次被删除/);
  local.dailyTasks[0].purgeAt = '2026-01-01T00:00:00Z';
  purgeExpiredTrash(local);
  assert.equal(local.dailyTasks.length, 1);
  assert.ok(local.dailyTasks[0].deletedAt);
  assert.equal(sync.stateToOperations(local).find((op) => op.id === 'a').data.deletedAt, local.dailyTasks[0].deletedAt);
  assert.equal(mergeRecord(local.dailyTasks[0], deleted).deletedAt, local.dailyTasks[0].deletedAt);
});
