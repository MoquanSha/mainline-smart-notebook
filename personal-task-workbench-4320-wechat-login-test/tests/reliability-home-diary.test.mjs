import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHomeSyncHandler } from '../home-sync.mjs';
import { createCloudInitialState, handleAction } from '../server.mjs';

async function fixture(t, options = {}) {
  const state = createCloudInitialState();
  Object.assign(state.settings, { aiMode: 'rules', autoOrganize: false, autoUpdateEnabled: false });
  let current = state, chain = Promise.resolve();
  const committed = [];
  const handler = createHomeSyncHandler({
    token: 'synthetic',
    readState: async () => structuredClone(current),
    mutateState(mutator) {
      const operation = chain.then(async () => {
        const draft = structuredClone(current);
        await mutator(draft);
        if (options.failCommit) throw new Error('disk unavailable');
        current = draft;
        return structuredClone(current);
      });
      chain = operation.catch(() => {});
      return operation;
    },
    handleAction,
    afterCommit(operations) {
      committed.push({ operations, state: structuredClone(current) });
      if (options.failWorker) throw new Error('worker unavailable');
    }
  });
  const server = createServer((req, res) => handler(req, res, new URL(req.url, 'http://localhost')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const post = async (route, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/home/${route}`, {
      method: 'POST', headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    return { status: res.status, ...await res.json() };
  };
  return { post, current: () => current, committed };
}
const input = (id, extra = {}) => ({ action: 'diary.appendInput', requestId: 'op-' + id,
  payload: { date: '2026-09-20', inputId: id, content: '  可能没有完成，预算 123.45 元。\n\n- 保留格式\n', ...extra } });

test('home raw diary receipt preserves date, ID, source, whitespace and schedules only after commit', async t => {
  const f = await fixture(t), operation = input('original');
  const saved = await f.post('rpc', operation);
  assert.equal(saved.ok, true, JSON.stringify(saved.error));
  assert.equal(saved.data.acceptedInputId, 'original');
  assert.equal(saved.data.day.manualInputs[0].content, operation.payload.content);
  assert.equal(saved.data.day.manualInputs[0].source, 'wechat');
  assert.equal(saved.data.day.organizationHost, 'desktop');
  assert.equal(saved.data.day.organizationStatus, 'pending');
  assert.equal(f.committed.length, 1);
  assert.equal(f.committed[0].state.days.find(d => d.date === '2026-09-20').manualInputs[0].id, 'original');
  const replay = await f.post('rpc', operation);
  assert.equal(replay.data.syncReceipt.duplicate, true);
  assert.equal(f.current().days.find(d => d.date === '2026-09-20').manualInputs.length, 1);
  const spaced = await f.post('rpc', input(' spaced  ID '));
  assert.equal(spaced.data.acceptedInputId, ' spaced  ID ');
  assert.ok(spaced.data.day.manualInputs.some(row => row.id === ' spaced  ID '));
});

test('diary A/C return reconciliable records while invalid B has no receipt or changes', async t => {
  const f = await fixture(t);
  const result = await f.post('batch', { operations: [input('A'), input('B', { date: '2026-02-30' }), input('C')] });
  assert.deepEqual(result.data.results.map(r => r.ok), [true, false, true]);
  assert.deepEqual(result.data.results.filter(r => r.ok).map(r => r.data.acceptedInputId), ['A', 'C']);
  assert.deepEqual(f.current().days.find(d => d.date === '2026-09-20').manualInputs.map(r => r.id), ['A', 'C']);
  assert.equal(f.committed[0].operations.length, 2);
  assert.equal(f.current().meta.homeOperationReceipts.length, 2);
});

test('invalid diary IDs, dates, conflicting originals and capacity fail without changing the saved state', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('rpc', input('valid'))).ok, true);
  for (const [operation, code] of [
    [input('bad-date', { date: '2026-09-20-extra' }), 'VALIDATION'],
    [input('bad-id', { inputId: 'x'.repeat(161) }), 'VALIDATION'],
    [input('control', { inputId: 'a\nb' }), 'VALIDATION'],
    [{ ...input('valid', { content: '另一份原文' }), requestId: 'conflict' }, 'INPUT_ID_CONFLICT'],
    [input('huge', { content: '原'.repeat(150000) }), 'DIARY_CAPACITY']
  ]) {
    const before = JSON.stringify(f.current());
    const result = await f.post('rpc', operation);
    assert.equal(result.error?.code, code, JSON.stringify(result));
    assert.equal(JSON.stringify(f.current()), before);
  }
});

test('replaying an accepted diary returns current originals or its deletion without resurrecting it', async t => {
  const f = await fixture(t), operation = input('first');
  assert.equal((await f.post('rpc', operation)).ok, true);
  await f.post('rpc', input('second', { content: '后来补充' }));
  let result = await f.post('batch', { operations: [operation] });
  assert.equal(result.data.results[0].data.day.manualInputs.length, 2);
  const day = f.current().days.find(d => d.date === '2026-09-20');
  day.deletedAt = '2026-09-25T00:00:00Z'; day.version += 1;
  result = await f.post('batch', { operations: [operation, input('late')] });
  assert.ok(result.data.results[0].data.day.deletedAt);
  assert.equal(result.data.results[1].error.code, 'RECORD_DELETED');
  assert.equal(day.manualInputs.length, 2);
});

test('failed commit never starts AI; a failed worker cannot undo acknowledged raw persistence', async t => {
  const failed = await fixture(t, { failCommit: true });
  assert.equal((await failed.post('rpc', input('disk-fail'))).ok, false);
  assert.equal(failed.committed.length, 0);
  const saved = await fixture(t, { failWorker: true });
  assert.equal((await saved.post('rpc', input('worker-fail'))).ok, true);
  assert.equal(saved.current().days.find(d => d.date === '2026-09-20').manualInputs[0].id, 'worker-fail');
});

test('journal create and append batch return current records and request desktop organization after persistence', async t => {
  const f = await fixture(t);
  const result = await f.post('batch', { operations: [
    { action: 'journal.create', requestId: 'journal', payload: { id: 'journal', date: '2026-09-20', content: '灵光原文', favorite: true } },
    { action: 'journal.append', requestId: 'supplement', payload: { entryId: 'journal', supplementId: 'supplement', content: '补充原文' } }
  ] });
  assert.deepEqual(result.data.results.map(r => r.ok), [true, true]);
  assert.equal(result.data.results[0].data.id, 'journal');
  assert.equal(result.data.results[1].data.journalSupplements[0].id, 'supplement');
  const capture = f.current().captures.find(c => c.id === 'journal');
  assert.equal(capture.organizationRequested, true);
  assert.equal(capture.organizationHost, 'desktop');
  assert.ok(capture.favoritedAt);
  assert.equal(f.committed[0].operations.length, 2);
});

test('home archive and unarchive match cloud semantics and never restore a trashed journal', async t => {
  const f = await fixture(t);
  f.current().captures = [{ id: 'journal', entryKind: 'journal_entry', content: '原文', version: 1, hiddenAt: 'hidden' }];
  const archive = await f.post('rpc', { action: 'journal.archive', requestId: 'archive', responseMode: 'record-v1', payload: { entryId: 'journal' } });
  assert.equal(archive.ok, true); assert.equal(archive.data.journalArchived, true);
  const restore = await f.post('rpc', { action: 'journal.restore', requestId: 'unarchive', responseMode: 'record-v1', payload: { entryId: 'journal' } });
  assert.equal(restore.data.journalArchived, false); assert.equal(restore.data.archivedAt, '');
  assert.equal(restore.data.hiddenAt, 'hidden');
  f.current().captures[0].trashedAt = '2026-09-25T00:00:00Z';
  const before = JSON.stringify(f.current());
  const denied = await f.post('rpc', { action: 'journal.restore', requestId: 'late', payload: { entryId: 'journal' } });
  assert.equal(denied.error.code, 'RECORD_DELETED'); assert.equal(JSON.stringify(f.current()), before);
});
