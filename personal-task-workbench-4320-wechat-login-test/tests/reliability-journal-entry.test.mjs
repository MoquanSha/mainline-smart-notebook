import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cloudSync from '../electron/cloud-sync.cjs';
import { createJournalWorker } from '../ai/journal-worker.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-journal-entry-'));
process.env.SMART_NOTEBOOK_DATA_DIR = directory;
const api = await import('../server.mjs');
const initial = () => {
  const state = api.createCloudInitialState();
  Object.assign(state.settings, { aiMode: 'rules', autoOrganize: false, autoUpdateEnabled: false,
    codexSessionsDir: path.join(directory, 'absent') });
  return state;
};
const add = (content, extra = {}) => ({ action: 'capture.add', id: 'input-main', source: 'manual',
  intent: 'organize', journalDate: '2026-09-24', content, ...extra });

test('main journal stores exact long Unicode original and reading body before AI and after reopen', async () => {
  const state = initial(), raw = '  **原文**\r\n' + '甲🙂'.repeat(11000) + '\n  结尾未完成';
  await api.handleAction(state, add(raw));
  assert.ok(state.captures[0].content === raw, 'content changed or truncated');
  assert.ok(state.captures[0].rawContent === raw, 'raw original missing');
  fs.writeFileSync(api.STORE_PATH, JSON.stringify(state));
  const reopened = await api.mutateState(() => {}, null, { notify: false });
  assert.ok(reopened.captures[0].organizedContent === raw, 'reopen truncated reading body');
  assert.ok(reopened.captures[0].content === raw, 'public API silently truncated a user original');
  assert.ok(cloudSync.sanitizeJournalEntry(reopened.captures[0]).content === raw, 'sync inherited a preview instead of the original');
  assert.equal(reopened.captures[0].journalDate, '2026-09-24');
  assert.equal(reopened.captures[0].organizationRequested, true);
  assert.equal(reopened.captures[0].organizationStatus, 'pending');
});

test('main journal stable ID replay cannot duplicate note or explicit task side effects', async () => {
  for (const intent of ['organize', 'note', 'today', 'long_term', 'favorite', 'defer']) {
    const state = initial(), request = add('核对申请材料', { intent });
    await api.handleAction(state, request);
    const once = JSON.stringify(state);
    await api.handleAction(state, request);
    assert.equal(JSON.stringify(state), once, `${intent} replay changed persisted state`);
    await assert.rejects(api.handleAction(state, { ...request, content: '不同原文' }), { code: 'INPUT_ID_CONFLICT' });
  }
});

test('save-only and deferred main notes start organization only on explicit request and do not enter task proposals', async () => {
  for (const intent of ['note', 'defer']) {
    const state = initial(); await api.handleAction(state, add('普通感悟', { intent }));
    assert.equal(state.captures[0].status, 'processed');
    assert.equal(state.captures[0].organizationRequested, false);
    assert.equal(state.proposals.length, 0);
    await api.handleAction(state, { action: 'capture.organizationRetry', captureId: 'input-main' });
    assert.equal(state.captures[0].organizationRequested, true);
    assert.equal(state.captures[0].organizationStatus, 'pending');
  }
});

test('main journal replay cannot revive a deleted row or change its original intent', async () => {
  const state = initial(), request = add('保留的输入');
  await api.handleAction(state, request);
  await assert.rejects(api.handleAction(state, { ...request, intent: 'today' }), { code: 'INPUT_ID_CONFLICT' });
  state.captures[0].deletedAt = new Date().toISOString();
  await assert.rejects(api.handleAction(state, request), { code: 'RECORD_DELETED' });
  assert.equal(state.captures.length, 1);
});

test('oversized journal and ambiguous IDs fail before any source or derived state is changed', async () => {
  const state = initial(), before = JSON.stringify(state);
  await assert.rejects(api.handleAction(state, add('甲'.repeat(300000))), { code: 'INPUT_CAPACITY' });
  assert.equal(JSON.stringify(state), before);
  await assert.rejects(api.handleAction(state, add('原文', { id: 'x'.repeat(161) })), { code: 'VALIDATION' });
  assert.equal(JSON.stringify(state), before);
});

test('redaction policy refuses a changed original before persistence, rather than silently replacing it', async () => {
  const state = initial(), before = JSON.stringify(state);
  await assert.rejects(api.handleAction(state, add('token=synthetic-example-not-a-credential')), { code: 'INPUT_REDACTION_REQUIRED' });
  assert.equal(JSON.stringify(state), before);
});

test('a persisted submission from another data scope is rejected before any local write', async () => {
  const state = initial(); fs.writeFileSync(api.STORE_PATH, JSON.stringify(state));
  const before = fs.readFileSync(api.STORE_PATH, 'utf8');
  await assert.rejects(api.executeAction(add('A 的离线原文', { expectedDataScope: 'another-profile' })), { code: 'SCOPE_MISMATCH', status: 409 });
  assert.equal(fs.readFileSync(api.STORE_PATH, 'utf8'), before);
});

test('main journal confirms original before AI, frees state queue, and preserves concurrent notes and metadata', async () => {
  const state = initial(), raw = '甲🙂'.repeat(3200) + '最后一段可能尚未完成';
  fs.writeFileSync(api.STORE_PATH, JSON.stringify(state));
  let enter, release;
  const entered = new Promise((resolve) => { enter = resolve; }), waiting = new Promise((resolve) => { release = resolve; });
  const sent = [];
  const organize = async (_row, content) => { sent.push(content); if (sent.length === 1) { enter(); await waiting; } return { content, organizedBy: 'deepseek' }; };
  const saved = await api.executeAction(add(raw), null, undefined, { background: true, organizeJournal: organize });
  assert.equal(saved.captures[0].rawContent, raw);
  await entered;
  const onDisk = JSON.parse(fs.readFileSync(api.STORE_PATH, 'utf8'));
  assert.equal(onDisk.captures[0].organizationStatus, 'pending');
  await api.mutateState((current) => {
    current.captures[0].favoritedAt = new Date().toISOString();
    current.captures[0].annotations.push({ id: 'concurrent-note', content: '补充说明', rawContent: '补充说明' });
  });
  release(); await api.resumeJournalOrganizations(null, { organize });
  const row = JSON.parse(fs.readFileSync(api.STORE_PATH, 'utf8')).captures[0];
  assert.equal(sent.join(''), raw);
  assert.ok(row.organizedContent.endsWith('最后一段可能尚未完成'));
  assert.ok(row.favoritedAt); assert.equal(row.annotations[0].content, '补充说明');
  assert.equal(row.organizationStatus, 'ai_organized'); assert.equal(row.organizationRequested, false);
  assert.equal(row.rawContent, raw); assert.equal(row.content, raw);
  assert.equal(JSON.parse(fs.readFileSync(api.STORE_PATH, 'utf8')).proposals.length, 0);
  await api.resumeJournalOrganizations(null, { organize: async () => { throw new Error('completed worker must stay idle'); } });
  assert.equal(sent.length, 3);
});

test('main journal failed retry reuses completed parts across new workers and preserves raw original', async () => {
  const state = initial(), raw = '甲'.repeat(3000) + '乙原文';
  await api.handleAction(state, add(raw)); fs.writeFileSync(api.STORE_PATH, JSON.stringify(state));
  let fail = true; const sent = [];
  const options = { db: api.diaryJobStore, owner: 'journal-restart', read: async () => JSON.parse(fs.readFileSync(api.STORE_PATH, 'utf8')),
    commit: (mutator, event) => api.mutateState(mutator, null, { event }),
    organize: async (_row, content) => { sent.push(content[0]); if (fail && content.startsWith('乙')) throw new Error('offline'); return { content, organizedBy: 'deepseek' }; } };
  await createJournalWorker(options).resume();
  let row = JSON.parse(fs.readFileSync(api.STORE_PATH, 'utf8')).captures[0];
  assert.equal(row.organizationStatus, 'failed'); assert.equal(row.rawContent, raw);
  fail = false;
  await createJournalWorker(options).resume({ captureId: row.id, retry: true });
  assert.deepEqual(sent, ['甲', '乙', '乙']);
  row = JSON.parse(fs.readFileSync(api.STORE_PATH, 'utf8')).captures[0];
  assert.equal(row.organizationStatus, 'ai_organized'); assert.equal(row.rawContent, raw);
});

test('late main journal AI cannot overwrite a changed body or revive deleted records, including after resume', async () => {
  for (const kind of ['edit', 'delete']) {
    const state = initial(); await api.handleAction(state, add('原文', { id: kind })); fs.writeFileSync(api.STORE_PATH, JSON.stringify(state));
    let enter, release, calls = 0;
    const entered = new Promise((resolve) => { enter = resolve; }), waiting = new Promise((resolve) => { release = resolve; });
    const options = { db: api.diaryJobStore, owner: kind, read: async () => JSON.parse(fs.readFileSync(api.STORE_PATH, 'utf8')),
      commit: (mutator, event) => api.mutateState(mutator, null, { event }),
      organize: async () => { calls++; enter(); await waiting; return { content: '旧整理稿', organizedBy: 'deepseek' }; } };
    const worker = createJournalWorker(options), running = worker.resume(); await entered;
    await api.mutateState((current) => { if (kind === 'edit') current.captures[0].organizedContent = '后来编辑的正文'; else current.captures[0].deletedAt = new Date().toISOString(); });
    release(); await running; await createJournalWorker(options).resume();
    const row = JSON.parse(fs.readFileSync(api.STORE_PATH, 'utf8')).captures[0];
    assert.equal(calls, 1);
    if (kind === 'edit') { assert.equal(row.organizedContent, '后来编辑的正文'); assert.equal(row.organizationJob.retryable, false); }
    else { assert.ok(row.deletedAt); assert.equal(row.organizedContent, '原文'); }
  }
});

test('sync roundtrip retains local replay identity and worker while a different desktop only receives the original', async () => {
  const state = initial(); await api.handleAction(state, add('  原文\n', { source: 'import' }));
  const row = state.captures[0]; row.organizationJob = { status: 'pending', completed: 1, total: 2 };
  const document = cloudSync.sanitizeJournalEntry(row);
  assert.equal(document.rawContent, row.rawContent); assert.equal(document.organizationHost, 'desktop');
  assert.equal(document.organizationRequested, undefined); assert.equal(document.inputSignature, undefined);
  const local = cloudSync.journalDocumentForDesktop(document, row);
  assert.equal(local.organizationRequested, true); assert.equal(local.inputSignature, row.inputSignature);
  assert.deepEqual(local.organizationJob, row.organizationJob);
  assert.equal(cloudSync.journalDocumentForDesktop(document).organizationRequested, undefined);
});

test.after(async () => {
  await api.diaryJobStore.close();
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('mainline-journal-entry-'));
  fs.rmSync(directory, { recursive: true, force: true });
});
