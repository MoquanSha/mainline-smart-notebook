import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHomeSyncHandler } from '../home-sync.mjs';
import { handleAction, createCloudInitialState } from '../server.mjs';

const proposal = (id, extra = {}) => ({ id, type: 'task_create', status: 'pending', title: id, version: 1, ...extra });
async function fixture(t, rows, handler) {
  let state = { ...createCloudInitialState(), proposals: rows };
  let chain = Promise.resolve();
  const mutations = [];
  const action = handler || (async (draft, body) => {
    mutations.push(body);
    const targets = body.action === 'proposal.applyAll' ? draft.proposals.filter(p => p.status === 'pending') : draft.proposals.filter(p => p.id === body.proposalId);
    for (const row of targets) { draft.tasks.push({ id: 'task-' + row.id }); row.status = 'applied'; }
  });
  const handle = createHomeSyncHandler({ token: 'synthetic', readState: async () => state,
    mutateState(fn) { const job = chain.then(async () => { const draft = structuredClone(state); await fn(draft); state = draft; return state; }); chain = job.catch(() => {}); return job; },
    handleAction: action, commentImagesDir: process.cwd(), receiveTodoCommentImage: async () => ({}) });
  const server = createServer((req, res) => handle(req, res, new URL(req.url, 'http://localhost')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/api/home/rpc`;
  const call = async (action, payload, requestId = 'request') => (await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer synthetic', 'content-type': 'application/json' }, body: JSON.stringify({ action, payload, requestId }) })).json();
  return { call, state: () => state, mutations };
}

test('home selection accepts A/C, preserves changed B and an unseen proposal', async t => {
  const f = await fixture(t, [proposal('a'), proposal('b', { version: 2 }), proposal('c'), proposal('unseen')]);
  const result = await f.call('proposal.applySelected', { selections: ['a', 'b', 'c'].map(id => ({ id, baseVersion: 1 })) });
  assert.equal(result.ok, true); assert.equal(result.data.applied, 2); assert.equal(result.data.failed, 1);
  assert.deepEqual(f.state().tasks.map(row => row.id), ['task-a', 'task-c']);
  assert.equal(f.state().proposals.find(row => row.id === 'unseen').status, 'pending');
  assert.equal(result.data.results[1].error.code, 'CONFLICT');
});

test('home failed selection has no partial mutation and lost reply replays the exact partial result', async t => {
  const f = await fixture(t, [proposal('a'), proposal('b'), proposal('c')], async (state, body) => {
    state.tasks.push({ id: 'task-' + body.proposalId });
    if (body.proposalId === 'b') throw new Error('step write failed');
    state.proposals.find(row => row.id === body.proposalId).status = 'applied';
  });
  const payload = { selections: ['a', 'b', 'c'].map(id => ({ id, baseVersion: 1 })) };
  const first = await f.call('proposal.applySelected', payload);
  assert.equal(first.ok, true); assert.equal(first.data.failed, 1);
  assert.deepEqual(f.state().tasks.map(row => row.id), ['task-a', 'task-c']);
  const replay = await f.call('proposal.applySelected', payload);
  assert.deepEqual(replay.data.results, first.data.results); assert.equal(replay.data.applied, 2);
  assert.deepEqual(f.state().tasks.map(row => row.id), ['task-a', 'task-c']);
  const changed = await f.call('proposal.applySelected', { selections: [{ id: 'b', baseVersion: 1 }] });
  assert.equal(changed.ok, false); assert.equal(changed.error.code, 'REQUEST_ID_CONFLICT');
});

test('legacy unspecified home apply-all is rejected before any adoption', async t => {
  const f = await fixture(t, [proposal('a')]);
  const result = await f.call('proposal.applyAll', {});
  assert.equal(result.ok, false); assert.equal(result.error.code, 'SELECTION_REQUIRED');
  assert.equal(f.state().tasks.length, 0);
});

test('duplicate and missing selections fail before mutation, and deleted proposals stay deleted', async t => {
  const f = await fixture(t, [proposal('a'), proposal('gone', { deletedAt: 'yesterday' })]);
  const invalid = await f.call('proposal.applySelected', { selections: [{ id: 'a', baseVersion: 1 }, { id: 'a', baseVersion: 1 }] });
  assert.equal(invalid.ok, false); assert.equal(f.mutations.length, 0);
  const missing = await f.call('proposal.applySelected', { selections: [{ id: 'missing', baseVersion: 1 }, { id: 'gone', baseVersion: 1 }] }, 'other');
  assert.equal(missing.ok, true); assert.equal(missing.data.failed, 2); assert.equal(f.mutations.length, 0);
});

test('concurrent home retries commit one set of entities and retain the original receipt', async t => {
  const f = await fixture(t, [proposal('a')]);
  const payload = { selections: [{ id: 'a', baseVersion: 1 }] };
  const results = await Promise.all([f.call('proposal.applySelected', payload), f.call('proposal.applySelected', payload)]);
  assert.ok(results.every(r => r.ok)); assert.equal(f.mutations.length, 1);
  assert.deepEqual(results[0].data.results, results[1].data.results);
});

test('home cannot count rejected or deferred suggestions as successfully adopted', async t => {
  const f = await fixture(t, [proposal('a', { status: 'rejected' }), proposal('b', { status: 'deferred' })]);
  const result = await f.call('proposal.applySelected', { selections: ['a', 'b'].map(id => ({ id, baseVersion: 1 })) });
  assert.equal(result.ok, true); assert.equal(result.data.applied, 0); assert.equal(result.data.failed, 2);
  assert.equal(f.mutations.length, 0);
});

test('actual desktop handler creates independent today todos from equal-title proposals', async t => {
  const f = await fixture(t, [proposal('a', { type: 'today_todo', title: '同名事项' }), proposal('b', { type: 'today_todo', title: '同名事项' })], handleAction);
  const result = await f.call('proposal.applySelected', { selections: ['a', 'b'].map(id => ({ id, baseVersion: 1 })) });
  assert.equal(result.data.applied, 2);
  assert.equal(f.state().dailyTasks.filter(row => row.entryKind === 'today_todo').length, 2);
  assert.equal(new Set(f.state().dailyTasks.map(row => row.lineageId)).size, 2);
});

test('actual desktop handler does not silently merge equal-title long-term proposals', async t => {
  const f = await fixture(t, [proposal('a', { title: '同名任务' }), proposal('b', { title: '同名任务' })], handleAction);
  const result = await f.call('proposal.applySelected', { selections: ['a', 'b'].map(id => ({ id, baseVersion: 1 })) });
  assert.equal(result.data.applied, 2); assert.equal(f.state().tasks.length, 2);
});
