import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-home-compact-'));
process.env.SMART_NOTEBOOK_DATA_DIR = directory;
process.env.SMART_NOTEBOOK_HOME_TOKEN = 'synthetic-compact';
const principal = { userId: 'synthetic', workspaceId: 'A' };
process.env.SMART_NOTEBOOK_HOME_OWNER = JSON.stringify(principal);
const { server, STORE_PATH, HOOK_QUEUE, createCloudInitialState, diaryJobStore } = await import('../server.mjs');
const initial = createCloudInitialState();
Object.assign(initial.settings, { aiMode: 'rules', autoOrganize: false, autoUpdateEnabled: false, codexSessionsDir: path.join(directory, 'absent') });
const historyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() - 3 * 86400000));
initial.captures = Array.from({ length: 140 }, (_, i) => ({ id: `entry-${i}`, entryKind: 'journal_entry', source: 'manual', kind: 'note', content: `原文 ${i}`, rawContent: `原文 ${i}`, journalDate: historyDate, occurredAt: `${historyDate}T02:00:00Z`, version: 1 }));
initial.proposals = [{ id: 'selected', type: 'today_todo', title: '提案', status: 'pending', version: 1 }];
initial.captures[10].journalSupplements = [];
initial.captures[11].journalSupplements = [{ id: 'cloud-shared', content: '已从云端收到的原文', version: 1 }];
initial.captures[12].journalSupplements = [{ id: 'conflicting', content: '手机保留的原文', version: 1 }];
initial.captures[12].annotations = [{ id: 'conflicting', content: '电脑保留的原文', version: 2 }];
initial.captures[13].journalSupplements = [{ id: 'deleted-supplement', content: '已删除', version: 1, deletedAt: '2026-09-20T00:00:00Z' }];
initial.captures[13].annotations = [{ id: 'deleted-supplement', content: '已删除', version: 9 }];
fs.writeFileSync(STORE_PATH, JSON.stringify(initial));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/home/`, headers = { Authorization: 'Bearer synthetic-compact', 'content-type': 'application/json' };
const home = async (route, body) => {
  headers['X-Mainline-Scope'] = encodeURIComponent(JSON.stringify(principal));
  if (body) body = { ...body, scope: principal, ...(body.operations ? { operations: body.operations.map(op => ({ ...op, scope: principal })) } : {}) };
  const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text(); return { status: response.status, bytes: Buffer.byteLength(text), ...JSON.parse(text) };
};
const recordOp = (id, entry = 'entry-0') => ({ action: 'capture.setFavorite', requestId: id, payload: { id: entry, favorited: true, baseVersion: 1 } });
const disk = () => fs.readFileSync(STORE_PATH, 'utf8');
test.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await diaryJobStore.close(); assert.ok(directory.startsWith(path.join(os.tmpdir(), 'mainline-home-compact-'))); fs.rmSync(directory, { recursive: true, force: true }); });

test('record-v1 returns only the acknowledged journal record, while an old client retains the overview response', async () => {
  const operation = recordOp('compact');
  const modern = await home('rpc', { ...operation, responseMode: 'record-v1' });
  assert.equal(modern.ok, true); assert.equal(modern.data.id, 'entry-0'); assert.ok(modern.data.favoritedAt);
  assert.equal(modern.data.history, undefined); assert.ok(modern.bytes < 4000);
  const legacy = await home('rpc', operation);
  assert.ok(Array.isArray(legacy.data.history)); assert.ok(legacy.data.history.flatMap(day => day.entries).length >= 140);
  assert.equal(legacy.data.syncReceipt.duplicate, true); assert.ok(legacy.bytes > modern.bytes * 20);
});

test('duplicate-only RPC and batch preserve exact file bytes, revision, and change notification revision', async () => {
  const operation = recordOp('replay', 'entry-1'); await home('rpc', operation);
  const before = disk(), revision = (await home('ping')).data.revision;
  await new Promise(resolve => setTimeout(resolve, 25));
  const duplicate = await home('rpc', operation); assert.equal(duplicate.data.syncReceipt.duplicate, true);
  const batch = await home('batch', { operations: [operation] }); assert.equal(batch.data.results[0].duplicate, true);
  assert.equal(disk(), before); assert.equal((await home('ping')).data.revision, revision);
});

test('an all-rejected batch neither writes the file nor signals a data change', async () => {
  const before = disk(), revision = (await home('ping')).data.revision;
  await new Promise(resolve => setTimeout(resolve, 25));
  const result = await home('batch', { operations: [{ action: 'invalid.action', requestId: 'invalid', payload: {} }, { action: 'capture.hide', payload: { id: 'entry-0' } }] });
  assert.equal(result.data.syncReceipt.failed, 2); assert.equal(disk(), before); assert.equal((await home('ping')).data.revision, revision);
});

test('a mixed duplicate/new batch commits only the new operation and still emits a change', async () => {
  const before = JSON.parse(disk()).meta.localRevision, revision = (await home('ping')).data.revision;
  await new Promise(resolve => setTimeout(resolve, 25));
  const result = await home('batch', { operations: [recordOp('replay', 'entry-1'), recordOp('new', 'entry-2')] });
  assert.deepEqual(result.data.results.map(row => row.duplicate), [true, false]);
  assert.equal(JSON.parse(disk()).meta.localRevision, before + 1); assert.notEqual((await home('ping')).data.revision, revision);
});

test('record-v1 replay returns the current deletion marker instead of restoring the original body', async () => {
  const operation = recordOp('will-delete', 'entry-3'); await home('rpc', { ...operation, responseMode: 'record-v1' });
  const removed = await home('rpc', { action: 'journal.delete', requestId: 'delete', payload: { entryId: 'entry-3' }, responseMode: 'record-v1' });
  assert.equal(removed.data.id, 'entry-3'); assert.ok(removed.data.trashedAt || removed.data.deletedAt);
  const replay = await home('rpc', { ...operation, responseMode: 'record-v1' });
  assert.ok(replay.data.trashedAt || replay.data.deletedAt); assert.equal(replay.data.syncReceipt.duplicate, true);
});

test('replaying a selected proposal decision does not rewrite its durable partial receipt', async () => {
  const operation = { action: 'proposal.applySelected', requestId: 'selection', payload: { selections: [{ id: 'selected', baseVersion: 1 }, { id: 'missing', baseVersion: 1 }] } };
  const first = await home('rpc', operation), before = disk(); assert.equal(first.data.failed, 1);
  const replay = await home('batch', { operations: [operation] });
  assert.deepEqual(replay.data.results[0].data, first.data); assert.equal(disk(), before);
});

test('a duplicate request cannot suppress separately imported hook input', async () => {
  fs.mkdirSync(path.dirname(HOOK_QUEUE), { recursive: true });
  fs.writeFileSync(HOOK_QUEUE, JSON.stringify({ id: 'synthetic-hook', kind: 'user_prompt', content: '需要保留的新输入', occurredAt: '2026-09-20T00:00:00Z' }) + '\n');
  const before = JSON.parse(disk()).meta.localRevision;
  await home('rpc', recordOp('replay', 'entry-1'));
  const saved = JSON.parse(disk()); assert.ok(saved.captures.some(row => row.id === 'capture-synthetic-hook')); assert.equal(saved.meta.localRevision, before + 1);
  const once = disk(); await home('rpc', recordOp('replay', 'entry-1')); assert.equal(disk(), once);
});

test('the real mini date/occurredAt payload survives home creation and appears under its original history day', async () => {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() - 3 * 86400000));
  const occurredAt = `${date}T02:34:00Z`;
  const saved = await home('rpc', { action: 'journal.create', requestId: 'draft-day', responseMode: 'record-v1', payload: { id: 'draft-day', content: '原日期的感悟', date, occurredAt } });
  assert.equal(saved.data.journalDate, date); assert.equal(saved.data.occurredAt, occurredAt);
  assert.equal(JSON.parse(disk()).timeline.find(event => event.captureId === 'draft-day').occurredAt, occurredAt);
  const overview = await home('rpc', { action: 'journal.overview', payload: { historyDays: 14 } });
  assert.ok(overview.data.history.find(day => day.date === date)?.entries.some(entry => entry.id === 'draft-day'));
});

test('phone supplement IDs survive the desktop adapter and an empty legacy supplement list cannot hide new annotations', async () => {
  const operation = { action: 'journal.append', requestId: 'append-op', responseMode: 'record-v1', payload: { entryId: 'entry-10', supplementId: 'supplement-shared-id', content: '  保留这段补充\n\n没有确定。\n' } };
  const first = await home('rpc', operation);
  assert.equal(first.data.journalSupplements.length, 1);
  assert.equal(first.data.journalSupplements[0].id, 'supplement-shared-id'); assert.equal(first.data.journalSupplements[0].content, operation.payload.content);
  const replay = await home('rpc', operation); assert.equal(replay.data.journalSupplements.length, 1);
  const capture = JSON.parse(disk()).captures.find(row => row.id === 'entry-10'); assert.equal(capture.annotations[0].id, 'supplement-shared-id');
});

test('an already mirrored supplement is not added twice and changing its original under the same ID is rejected', async () => {
  const operation = { action: 'journal.append', requestId: 'mirrored', payload: { entryId: 'entry-11', supplementId: 'cloud-shared', content: '已从云端收到的原文' } };
  const replay = await home('rpc', operation); assert.equal(replay.data.journalSupplements.length, 1);
  assert.equal(JSON.parse(disk()).captures.find(row => row.id === 'entry-11').annotations.length, 0);
  const changed = await home('rpc', { ...operation, requestId: 'new-mismatch', payload: { ...operation.payload, content: '另一份原文' } });
  assert.equal(changed.error.code, 'INPUT_ID_CONFLICT');
  assert.equal(JSON.parse(disk()).captures.find(row => row.id === 'entry-11').journalSupplements[0].content, operation.payload.content);
});

test('legacy same-ID supplement conflicts retain both originals and a nested tombstone defeats an active legacy copy', async () => {
  const get = entry => home('rpc', { ...recordOp(`show-${entry}`, entry), responseMode: 'record-v1' });
  const conflict = await get('entry-12');
  assert.deepEqual(new Set(conflict.data.journalSupplements.map(row => row.content)), new Set(['手机保留的原文', '电脑保留的原文']));
  const variant = conflict.data.journalSupplements.find(row => row.conflictOf); assert.equal(variant.conflictOf, 'conflicting');
  const repeated = await get('entry-12'); assert.equal(repeated.data.journalSupplements.find(row => row.conflictOf).id, variant.id);
  const tombstone = await get('entry-13'); assert.equal(tombstone.data.journalSupplements.length, 1); assert.ok(tombstone.data.journalSupplements[0].deletedAt);
});
