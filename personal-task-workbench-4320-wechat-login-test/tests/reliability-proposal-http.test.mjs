import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-proposal-http-'));
process.env.SMART_NOTEBOOK_DATA_DIR = directory;
process.env.SMART_NOTEBOOK_HOME_TOKEN = 'synthetic-http-token';
const principal = { userId: 'synthetic', workspaceId: 'A' };
process.env.SMART_NOTEBOOK_HOME_OWNER = JSON.stringify(principal);
const { server, createCloudInitialState, STORE_PATH, diaryJobStore, mutateState } = await import('../server.mjs');
const row = (id, extra = {}) => ({ id, type: 'today_todo', title: id, status: 'pending', version: 1, captureIds: [], suggestedHandling: 'ask_user', requiresConfirmation: true, ...extra });
const initial = createCloudInitialState();
Object.assign(initial.settings, { aiMode: 'rules', autoOrganize: false, autoUpdateEnabled: false, codexSessionsDir: path.join(directory, 'absent') });
initial.proposals = [row('a'), row('b', { version: 2 }), row('c'), row('unseen')];
fs.writeFileSync(STORE_PATH, JSON.stringify(initial));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const state = async () => (await fetch(url + 'api/state')).json();
const scope = (await state()).status.dataScope;
const call = async body => { const response = await fetch(url + 'api/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
test.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await diaryJobStore.close(); assert.ok(directory.startsWith(path.join(os.tmpdir(), 'mainline-proposal-http-'))); fs.rmSync(directory, { recursive: true, force: true }); });

test('desktop HTTP bulk adopts exact selection and returns durable per-item results', async () => {
  const body = { action: 'proposal.applyAll', requestId: 'desktop-batch', expectedDataScope: scope, selections: ['a', 'b', 'c'].map(id => ({ id, baseVersion: 1 })) };
  const result = await call(body); assert.equal(result.status, 200);
  const receipt = result.body.meta.lastProposalDecision;
  assert.equal(receipt.requestId, body.requestId); assert.equal(receipt.applied, 2); assert.equal(receipt.failed, 1);
  const disk = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  assert.deepEqual(disk.dailyTasks.map(todo => todo.title).sort(), ['a', 'c']);
  assert.equal(disk.proposals.find(p => p.id === 'unseen').status, 'pending');
  // A later change cannot alter what the same request was acknowledged for.
  await mutateState(draft => { draft.proposals.find(p => p.id === 'b').version = 3; });
  const retry = await call(body); assert.deepEqual(retry.body.meta.lastProposalDecision, receipt);
  assert.equal(retry.body.dailyTasks.length, 2);
});

test('desktop rejects wrong workspace and missing selection without adopting remaining rows', async () => {
  const before = (await state()).dailyTasks.length;
  const wrong = await call({ action: 'proposal.applyAll', expectedDataScope: 'other', requestId: 'wrong', selections: [{ id: 'unseen', baseVersion: 1 }] });
  assert.equal(wrong.status, 409);
  const missing = await call({ action: 'proposal.applyAll', expectedDataScope: scope, requestId: 'missing' });
  assert.equal(missing.status, 400); assert.equal((await state()).dailyTasks.length, before);
});

test('same desktop request ID cannot be reused for a different selection', async () => {
  const result = await call({ action: 'proposal.applyAll', expectedDataScope: scope, requestId: 'desktop-batch', selections: [{ id: 'unseen', baseVersion: 1 }] });
  assert.equal(result.status, 400); assert.match(result.body.error, /编号/);
  assert.equal((await state()).proposals.find(p => p.id === 'unseen').status, 'pending');
});

test('home HTTP persists compact receipts with data, hides ledgers from public snapshots and replays across entry points', async () => {
  const request = { action: 'journal.create', requestId: 'home-disk-op', payload: { id: 'home-disk-note', content: '手机原文', journalDate: '2026-09-20' } };
  const home = async (route, body) => (await fetch(url + `api/home/${route}`, { method: 'POST', headers: { Authorization: 'Bearer synthetic-http-token', 'content-type': 'application/json', 'X-Mainline-Scope': encodeURIComponent(JSON.stringify(principal)) }, body: JSON.stringify({ ...body, scope: principal, ...(body.operations ? { operations: body.operations.map(op => ({ ...op, scope: principal })) } : {}) }) })).json();
  const first = await home('batch', { operations: [request] }); assert.equal(first.data.results[0].ok, true);
  const disk = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  assert.equal(disk.captures.find(r => r.id === 'home-disk-note').journalDate, '2026-09-20');
  assert.equal(disk.meta.homeOperationReceipts.find(r => r.id === 'home-disk-op').entityId, 'home-disk-note');
  assert.ok(JSON.stringify(disk.meta.homeOperationReceipts).length < 1000);
  const replay = await home('rpc', request); assert.equal(replay.data.syncReceipt.duplicate, true); assert.equal(replay.data.id, 'home-disk-note');
  const visible = await state();
  assert.equal(visible.meta.homeSelectionReceipts, undefined);
  assert.equal(visible.meta.homeOperationReceipts, undefined);
  assert.equal(visible.meta.homeSyncReceipts, undefined);
  assert.equal(visible.meta.lastProposalDecision.requestId, 'desktop-batch');
});
