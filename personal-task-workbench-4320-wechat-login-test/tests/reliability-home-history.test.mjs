import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import * as home from '../home-sync.mjs';
import { createCloudInitialState } from '../server.mjs';
const date = i => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
async function fixture(t, initial = {}) {
  let state = { ...createCloudInitialState(), ...initial }, writes = 0;
  const mutate = async fn => {
    const draft = structuredClone(state);
    await fn(draft);
    if (draft.meta.homeHistory || state.meta.homeHistory) home.prepareHomeHistory?.(draft, state.meta.homeHistory);
    state = draft; writes++;
    return structuredClone(state);
  };
  const handler = home.createHomeSyncHandler({ token: 'synthetic', readState: async () => structuredClone(state), mutateState: mutate, handleAction: async () => {} });
  const server = createServer((req, res) => handler(req, res, new URL(req.url, 'http://localhost')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { handler.closeEventStreams(); server.closeAllConnections(); server.close(resolve); }));
  const rpc = async (action, payload = {}, token = 'synthetic') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/home/rpc`, { method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ action, payload }) });
    const raw = await response.text();
    return { ...JSON.parse(raw), status: response.status, bytes: Buffer.byteLength(raw) };
  };
  return { rpc, mutate, state: () => state, writes: () => writes };
}
async function collect(f, action, options = {}) {
  let cursor = options.cursor, pages = 0, records = [], last;
  do {
    const response = await f.rpc(action, { ...options, cursor, limit: 73 });
    assert.equal(response.ok, true, JSON.stringify(response.error));
    last = response.data; records.push(...last.records); cursor = last.nextCursor;
    assert.ok(last.records.length <= 73); assert.ok(++pages < 50);
  } while (last.hasMore);
  return { records, cursor, pages };
}

test('home snapshot advertises bounded history that includes all 245 diaries and tasks, excluding raw Codex', async t => {
  const f = await fixture(t, {
    tasks: Array.from({ length: 245 }, (_, i) => ({ id: 'task-' + String(i).padStart(3, '0'), title: '任务', version: 1 })),
    days: Array.from({ length: 245 }, (_, i) => ({ date: date(i), summary: '原文', version: 1 })),
    captures: [{ id: 'journal', entryKind: 'journal_entry', source: 'manual', kind: 'note', journalDate: date(1), content: '手写' },
      { id: 'raw', entryKind: 'journal_entry', source: 'codex', kind: 'tool_output', content: '不可展示的工具输入' }]
  });
  const head = await f.rpc('sync.snapshot');
  assert.equal(head.ok, true, JSON.stringify(head.error)); assert.equal(head.data.source, 'home');
  assert.ok(head.bytes < 1800);
  const history = await collect(f, 'sync.historyPage');
  assert.equal(history.records.length, 491);
  assert.ok(!history.records.some(row => row.document.id === 'raw'));
  assert.equal(history.records.filter(row => row.collection === 'day_records').length, 245);
  const writes = f.writes(), index = JSON.stringify(f.state().meta.homeHistory);
  const idle = await collect(f, 'sync.changes', { after: history.cursor.changeAfter });
  assert.equal(idle.records.length, 0);
  await f.rpc('sync.snapshot');
  assert.equal(f.writes(), writes); assert.equal(JSON.stringify(f.state().meta.homeHistory), index);
});

test('history pages retain a 420-record task and diary backfill without treating a page boundary as deletion', async t => {
  const f = await fixture(t, {
    tasks: Array.from({ length: 210 }, (_, i) => ({ id: `task-${String(i).padStart(3, '0')}`, title: `待办 ${i}`, version: 1 })),
    days: Array.from({ length: 210 }, (_, i) => ({ date: date(i), summary: `小记 ${i}`, version: 1 }))
  });
  const history = await collect(f, 'sync.historyPage');
  assert.equal(history.records.length, 420);
  assert.equal(new Set(history.records.map((row) => `${row.collection}:${row.document.id}`)).size, 420);
  assert.equal(history.records.filter((row) => row.collection === 'tasks').length, 210);
  assert.equal(history.records.filter((row) => row.collection === 'day_records').length, 210);
  const idle = await collect(f, 'sync.changes', { after: history.cursor.changeAfter });
  assert.equal(idle.records.length, 0);
});

test('history anchor catches behind-cursor insertion, prior-row deletion and equal-version body changes', async t => {
  const f = await fixture(t, { tasks: ['b', 'c', 'd'].map(id => ({ id, title: id, version: 1 })) });
  const first = await f.rpc('sync.historyPage', { limit: 1 });
  assert.equal(first.ok, true, JSON.stringify(first.error));
  assert.equal(first.data.records[0].document.id, 'b');
  await f.mutate(state => {
    state.tasks = state.tasks.filter(row => row.id !== 'b');
    state.tasks.push({ id: 'a', title: '后插入', version: 1 });
    state.tasks.find(row => row.id === 'c').title = '修改内容但旧写入者未增版本';
  });
  const tail = await collect(f, 'sync.historyPage', { cursor: first.data.nextCursor });
  const changes = await collect(f, 'sync.changes', { after: tail.cursor.changeAfter });
  const rows = new Map(changes.records.map(row => [row.document.id, row.document]));
  assert.equal(rows.get('a').title, '后插入'); assert.ok(rows.get('b').deletedAt);
  assert.equal(rows.get('c').title, '修改内容但旧写入者未增版本');
  const saved = structuredClone(f.state());
  const restarted = await fixture(t, saved);
  const replay = await collect(restarted, 'sync.changes', { after: tail.cursor.changeAfter });
  assert.deepEqual(replay.records, changes.records);
});

test('changes arriving after a captured window remain available in the next window', async t => {
  const f = await fixture(t, { tasks: ['a', 'b', 'c'].map(id => ({ id, title: id, version: 1 })) });
  const head = (await f.rpc('sync.snapshot')).data;
  assert.ok(head);
  await f.mutate(state => { state.tasks.forEach(row => { row.title += '1'; }); });
  const first = await f.rpc('sync.changes', { after: head.sequence, limit: 1 });
  assert.equal(first.ok, true, JSON.stringify(first.error));
  await f.mutate(state => { state.tasks.find(row => row.id === 'b').title = 'later'; });
  const end = await collect(f, 'sync.changes', { cursor: first.data.nextCursor, after: head.sequence });
  const next = await collect(f, 'sync.changes', { after: end.cursor.through });
  assert.equal(next.records.find(row => row.document.id === 'b').document.title, 'later');
});

test('history cursor rejects changed signature, another profile and unauthorized requests', async t => {
  const f = await fixture(t, { tasks: ['a', 'b'].map(id => ({ id, title: id })) });
  const first = await f.rpc('sync.historyPage', { limit: 1 }); assert.equal(first.ok, true);
  const changed = { ...first.data.nextCursor, after: 'zzz' };
  assert.equal((await f.rpc('sync.historyPage', { cursor: changed })).error.code, 'HISTORY_CURSOR_INVALID');
  const other = await fixture(t);
  assert.equal((await other.rpc('sync.historyPage', { cursor: first.data.nextCursor })).error.code, 'WORKSPACE_MISMATCH');
  assert.equal((await f.rpc('sync.snapshot', {}, 'wrong')).status, 401);
});

test('failed writer cannot publish sequence changes and unchanged records produce no incremental payload', async t => {
  const f = await fixture(t, { tasks: [{ id: 'a', title: 'a', version: 1 }] });
  const head = await f.rpc('sync.snapshot'); assert.equal(head.ok, true);
  const before = JSON.stringify(f.state());
  await assert.rejects(f.mutate(state => { state.tasks[0].title = 'uncommitted'; throw new Error('rollback'); }));
  assert.equal(JSON.stringify(f.state()), before);
  await f.mutate(() => {});
  const changes = await collect(f, 'sync.changes', { after: head.data.sequence });
  assert.equal(changes.records.length, 0);
});

test('bounded byte pages preserve complete large originals and explicitly reject one oversized row', async t => {
  const f = await fixture(t, { tasks: [{ id: 'a', description: '文'.repeat(120000) }, { id: 'b', description: '文'.repeat(120000) }] });
  const first = await f.rpc('sync.historyPage', { limit: 99 });
  assert.equal(first.ok, true); assert.equal(first.data.records.length, 1); assert.equal(first.data.hasMore, true);
  assert.equal(first.data.records[0].document.description.length, 120000);
  await f.mutate(state => { state.tasks[1].description = '文'.repeat(320000); });
  const denied = await f.rpc('sync.historyPage', { cursor: first.data.nextCursor });
  assert.equal(denied.error.code, 'RECORD_CAPACITY');
});
