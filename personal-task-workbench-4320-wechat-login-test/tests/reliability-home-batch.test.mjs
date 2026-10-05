import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHomeSyncHandler } from '../home-sync.mjs';
import { createCloudInitialState, handleAction } from '../server.mjs';

const op = (id, action = 'capture.setFavorite', payload = {}) => ({ requestId: id, action, payload: { id, favorite: true, ...payload } });
async function fixture(t, action = async (draft, body) => { draft.captures.push({ id: body.captureId }); }, initial = {}) {
  let state = { ...createCloudInitialState(), ...initial }, chain = Promise.resolve(), calls = 0;
  const handler = createHomeSyncHandler({ token: 'synthetic', readState: async () => structuredClone(state),
    mutateState(fn) { const job = chain.then(async () => { const draft = structuredClone(state); await fn(draft); state = draft; return structuredClone(state); }); chain = job.catch(() => {}); return job; },
    handleAction: async (...args) => { calls++; return action(...args); } });
  const server = createServer((req, res) => handler(req, res, new URL(req.url, 'http://localhost')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const post = async (route, body, token = 'synthetic') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/home/${route}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, ...await response.json() };
  };
  return { post, batch: ops => post('batch', { operations: ops }), rpc: operation => post('rpc', operation), state: () => state, calls: () => calls, mutate: fn => fn(state) };
}

test('home batch rolls back failed B completely, commits A/C and retries B independently', async t => {
  let fail = true;
  const f = await fixture(t, async (draft, body) => {
    draft.captures.push({ id: body.captureId }); draft.meta.marker = body.captureId;
    if (body.captureId === 'B' && fail) throw new Error('injected after write');
  });
  const operations = ['A', 'B', 'C'].map(id => op(id));
  const first = await f.batch(operations);
  assert.deepEqual(first.data.results.map(r => r.ok), [true, false, true]);
  assert.deepEqual(f.state().captures.map(r => r.id), ['A', 'C']);
  fail = false;
  const retry = await f.batch(operations);
  assert.deepEqual(retry.data.results.map(r => r.duplicate), [true, false, true]);
  assert.deepEqual(f.state().captures.map(r => r.id), ['A', 'C', 'B']);
  assert.equal(f.calls(), 4);
});

test('batch and RPC share receipts and reject changed payload or action with the same ID', async t => {
  const f = await fixture(t);
  const original = op('A');
  const first = await f.batch([original]);
  const replay = await f.rpc(original);
  assert.equal(replay.data.syncReceipt.duplicate, true); assert.equal(f.calls(), 1);
  assert.equal(replay.data.syncReceipt.appliedAt, first.data.results[0].appliedAt);
  const changed = await f.batch([op('A', 'capture.setFavorite', { favorite: false })]);
  assert.equal(changed.data.results[0].error.code, 'REQUEST_ID_CONFLICT');
  const differentAction = await f.rpc(op('A', 'capture.hide'));
  assert.equal(differentAction.error.code, 'REQUEST_ID_CONFLICT'); assert.equal(f.calls(), 1);
});

test('missing IDs and overlong IDs cannot be executed or truncated into another receipt', async t => {
  const f = await fixture(t);
  const result = await f.batch([{ action: 'capture.hide', payload: { id: 'a' } }, op('x'.repeat(181))]);
  assert.deepEqual(result.data.results.map(r => r.ok), [false, false]); assert.equal(f.calls(), 0);
});

test('home payload cannot replace its outer operation with settings or another action', async t => {
  const seen = [], f = await fixture(t, async (_, body) => { seen.push(body.action); });
  const result = await f.batch([op('A', 'capture.hide', { action: 'settings.update', patch: { autoOrganize: true } })]);
  assert.equal(result.data.results[0].ok, false); assert.equal(f.calls(), 0); assert.deepEqual(seen, []);
});

test('legacy receipts without a payload digest are preserved for reconciliation instead of acknowledged as success', async t => {
  const f = await fixture(t, undefined, { meta: { homeSyncReceipts: [{ id: 'old', action: 'capture.hide', appliedAt: '2026-09-01' }] } });
  const result = await f.batch([op('old', 'capture.hide')]);
  assert.equal(result.data.results[0].ok, false); assert.equal(result.data.results[0].error.code, 'LEGACY_RECEIPT');
  assert.equal(f.calls(), 0); assert.equal(f.state().meta.homeSyncReceipts.length, 1);
});

test('batch selected proposals use the same exact partial decision on RPC replay', async t => {
  const proposals = ['a', 'b', 'c', 'unseen'].map(id => ({ id, title: id, type: 'today_todo', status: 'pending', version: id === 'b' ? 2 : 1 }));
  const f = await fixture(t, handleAction, { proposals });
  const operation = { requestId: 'selection', action: 'proposal.applySelected', payload: { selections: ['a', 'b', 'c'].map(id => ({ id, baseVersion: 1 })) } };
  const first = await f.batch([operation]);
  assert.equal(first.data.results[0].ok, true); assert.equal(first.data.results[0].data.applied, 2); assert.equal(first.data.results[0].data.failed, 1);
  const retry = await f.rpc(operation); assert.deepEqual(retry.data, first.data.results[0].data);
  assert.equal(f.state().dailyTasks.length, 2); assert.equal(f.state().proposals[3].status, 'pending');
  const collision = await f.batch([op('selection')]); assert.equal(collision.data.results[0].error.code, 'REQUEST_ID_CONFLICT');
});

test('original operation stays deduplicated after more than 800 later acknowledgements', async t => {
  const f = await fixture(t);
  await f.batch([op('first')]);
  for (let i = 0; i < 17; i++) await f.batch(Array.from({ length: 50 }, (_, n) => op(`later-${i}-${n}`)));
  const replay = await f.rpc(op('first')); assert.equal(replay.data.syncReceipt.duplicate, true);
  assert.equal(f.calls(), 851);
});

test('journal creation keeps its date and replay returns its own entry when an equal-text entry arrives later', async t => {
  const f = await fixture(t, handleAction);
  const operation = { requestId: 'journal-op', action: 'journal.create', payload: { id: 'original', content: '保留我的原文', journalDate: '2026-09-20' } };
  const first = await f.rpc(operation); assert.equal(first.data.id, 'original'); assert.equal(first.data.journalDate, '2026-09-20');
  f.mutate(state => state.captures.push({ ...state.captures[0], id: 'later', occurredAt: '2099-01-01T00:00:00Z' }));
  const retry = await f.rpc(operation); assert.equal(retry.data.id, 'original'); assert.equal(retry.data.syncReceipt.duplicate, true);
  assert.equal(f.calls(), 1);
});

test('concurrent batch/RPC retries apply once, and invalid credentials never run any item', async t => {
  const f = await fixture(t);
  const denied = await f.post('batch', { operations: [op('A')] }, 'wrong'); assert.equal(denied.status, 401); assert.equal(f.calls(), 0);
  await Promise.all([f.batch([op('A')]), f.rpc(op('A'))]); assert.equal(f.calls(), 1);
});

test('a rebased precondition replays the same confirmed intent while a changed body is rejected', async t => {
  const f = await fixture(t, async (draft, body) => { const row = draft.captures.find(x => x.id === body.captureId); row.favorite = body.favorite; row.version++; }, { captures: [{ id: 'A', version: 1 }] });
  const first = await f.rpc(op('change', 'capture.setFavorite', { id: 'A', baseVersion: 1 })); assert.equal(first.ok, true);
  const replay = await f.rpc(op('change', 'capture.setFavorite', { id: 'A', baseVersion: 2 })); assert.equal(replay.data.syncReceipt.duplicate, true); assert.equal(f.calls(), 1);
  const changed = await f.rpc(op('change', 'capture.setFavorite', { id: 'A', baseVersion: 2, favorite: false })); assert.equal(changed.error.code, 'REQUEST_ID_CONFLICT');
});

test('journal retry without a record ID uses a stable generated record and preserves the original day', async t => {
  const f = await fixture(t, handleAction);
  const operation = { requestId: 'legacy-journal', action: 'journal.create', payload: { content: '原文', journalDate: '2026-09-19' } };
  const first = await f.rpc(operation), retry = await f.rpc(operation);
  assert.match(first.data.id, /^home_capture_/); assert.equal(retry.data.id, first.data.id);
  assert.equal(first.data.journalDate, '2026-09-19'); assert.equal(f.state().captures.length, 1);
});
