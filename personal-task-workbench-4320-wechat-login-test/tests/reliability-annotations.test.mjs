import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cloudSync from '../electron/cloud-sync.cjs';
import presenter from '../../wechat-mini-program-0.10.37-login-copy-20260905/miniprogram/pages/capture/presenter.js';
import { createAnnotationWorker } from '../ai/annotation-worker.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-annotations-'));
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.env.SMART_NOTEBOOK_DATA_DIR = directory;
const api = await import('../server.mjs');
const initial = () => {
  const state = api.createCloudInitialState();
  state.settings.aiMode = 'rules'; state.settings.autoUpdateEnabled = false;
  state.settings.codexSessionsDir = path.join(directory, 'absent');
  state.captures.push({ id: 'capture', entryKind: 'journal_entry', content: '主笔记', occurredAt: '2026-09-24T12:00:00Z',
    source: 'manual', status: 'processed', version: 1 });
  return state;
};
const body = (content = '  原始补充\r\n  ') => ({ action: 'capture.annotationAdd', captureId: 'capture', annotationId: 'input-1', content });

test('desktop supplement preserves exact long original before organization, including after disk normalization', async () => {
  const state = initial(), content = '  **补充原文**\r\n' + '甲🙂'.repeat(9000) + '\n  结尾';
  await api.handleAction(state, body(content));
  assert.ok(state.captures[0].annotations[0].rawContent === content, 'original was truncated or normalized before durable save');
  assert.equal(state.captures[0].annotations[0].organizationStatus, 'pending');
  fs.writeFileSync(api.STORE_PATH, JSON.stringify(state));
  const normalized = await api.mutateState(() => {}, null, { notify: false });
  assert.ok(normalized.captures[0].annotations[0].rawContent === content, 'reopening truncated the original');
});

test('a repeated supplement ID is idempotent and a different payload is rejected without overwriting', async () => {
  const state = initial();
  await api.handleAction(state, body());
  await api.handleAction(state, body());
  assert.equal(state.captures[0].annotations.length, 1);
  await assert.rejects(api.handleAction(state, body('另一段原文')), { code: 'INPUT_ID_CONFLICT' });
  assert.equal(state.captures[0].annotations[0].rawContent, body().content);
});

test('a late supplement cannot be appended to a deleted parent', async () => {
  const state = initial(); state.captures[0].deletedAt = '2026-09-24T13:00:00Z';
  await assert.rejects(api.handleAction(state, body()), /删除/);
  assert.equal(state.captures[0].annotations?.length || 0, 0);
});

test('a journal timestamp after Shanghai midnight does not fall into yesterday and explicit dates remain unchanged', async () => {
  const state = initial();
  state.captures[0].occurredAt = '2026-09-24T18:30:00Z';
  state.captures.push({ ...state.captures[0], id: 'explicit-date', journalDate: '2026-09-20' });
  fs.writeFileSync(api.STORE_PATH, JSON.stringify(state));
  const normalized = await api.mutateState(() => {}, null, { notify: false });
  assert.equal(normalized.captures[0].journalDate, '2026-09-25');
  assert.equal(normalized.captures[1].journalDate, '2026-09-20');
});

test('background organization leaves the state queue free, handles every Unicode part and retains concurrent appends', async () => {
  const state = initial(), content = '甲🙂'.repeat(3200) + '原文结尾可能未完成';
  await api.handleAction(state, body(content));
  fs.writeFileSync(api.STORE_PATH, JSON.stringify(state));
  let enter, release;
  const waiting = new Promise((resolve) => { release = resolve; }), entered = new Promise((resolve) => { enter = resolve; });
  const sent = [];
  const worker = api.resumeAnnotationOrganizations(null, { organize: async (_capture, raw) => {
    sent.push(raw); if (sent.length === 1) { enter(); await waiting; }
    return { content: raw, organizedBy: 'deepseek' };
  } });
  await entered;
  const pending = JSON.parse(fs.readFileSync(api.STORE_PATH, 'utf8')).captures[0].annotations[0];
  assert.ok(pending.rawContent === content);
  assert.equal(pending.organizationStatus, 'pending');
  await api.mutateState((current) => api.handleAction(current, { ...body('第二段补充'), annotationId: 'input-2' }));
  release(); await worker;
  const rows = JSON.parse(fs.readFileSync(api.STORE_PATH, 'utf8')).captures[0].annotations;
  assert.ok(sent.slice(0, 3).join('') === content);
  assert.ok(rows[0].content.endsWith('原文结尾可能未完成'));
  assert.equal(rows[0].organizationStatus, 'organized');
  assert.equal(rows[1].rawContent, '第二段补充');
  const count = sent.length;
  await api.resumeAnnotationOrganizations(null, { organize: async () => { throw new Error('must remain idle'); } });
  assert.equal(sent.length, count);
});

test('failed provider retains original and explicit retry reuses completed segments', async () => {
  const state = initial();
  await api.handleAction(state, { ...body('甲'.repeat(3000) + '乙'.repeat(100)), annotationId: 'fail-then-retry' });
  fs.writeFileSync(api.STORE_PATH, JSON.stringify(state));
  const sent = [];
  let fail = true;
  const organize = async (_capture, raw) => {
    sent.push(raw[0]); if (fail && raw[0] === '乙') return { content: raw, error: 'provider offline' };
    return { content: raw, organizedBy: 'deepseek' };
  };
  await api.resumeAnnotationOrganizations(null, { organize });
  const failed = JSON.parse(fs.readFileSync(api.STORE_PATH, 'utf8')).captures[0].annotations[0];
  assert.equal(failed.organizationStatus, 'failed');
  assert.ok(failed.rawContent.endsWith('乙'.repeat(100)));
  fail = false;
  await api.resumeAnnotationOrganizations(null, { captureId: 'capture', annotationId: 'fail-then-retry', retry: true, organize });
  assert.deepEqual(sent, ['甲', '乙', '乙']);
  assert.equal(JSON.parse(fs.readFileSync(api.STORE_PATH, 'utf8')).captures[0].annotations[0].organizationStatus, 'organized');
});

test('deleting during organization wins over late completion and repeated submission', async () => {
  const state = initial(), submission = { ...body('待删除的补充'), annotationId: 'delete-during-ai' };
  await api.handleAction(state, submission); fs.writeFileSync(api.STORE_PATH, JSON.stringify(state));
  let enter, release;
  const entered = new Promise((resolve) => { enter = resolve; }), waiting = new Promise((resolve) => { release = resolve; });
  const running = api.resumeAnnotationOrganizations(null, { organize: async () => { enter(); await waiting; return { content: '迟到的正文', organizedBy: 'deepseek' }; } });
  await entered;
  await api.mutateState((current) => api.handleAction(current, { action: 'capture.annotationDelete', captureId: 'capture', annotationId: submission.annotationId }));
  release(); await running;
  const row = JSON.parse(fs.readFileSync(api.STORE_PATH, 'utf8')).captures[0].annotations[0];
  assert.ok(row.deletedAt);
  assert.equal(row.content, submission.content);
  await assert.rejects(api.mutateState((current) => api.handleAction(current, submission)), { code: 'RECORD_DELETED' });
});

test('cloud journal roundtrip retains local pending progress and propagates deletion without showing the supplement', () => {
  const entry = initial().captures[0];
  const annotation = { id: 'sync-note', rawContent: '  原文\n', content: '  原文\n', createdAt: entry.occurredAt, version: 1,
    organizationRequested: true, organizationStatus: 'pending', organizationJob: { id: 'local-job', status: 'running', completed: 1, total: 2 } };
  entry.annotations = [annotation];
  const cloud = cloudSync.sanitizeJournalEntry(entry);
  assert.equal(cloud.journalSupplements[0].content, annotation.content);
  const received = cloudSync.journalDocumentForDesktop(cloud, entry);
  assert.equal(received.annotations[0].organizationRequested, true);
  assert.deepEqual(received.annotations[0].organizationJob, annotation.organizationJob);
  assert.equal(cloudSync.journalDocumentForDesktop(cloud).annotations[0].organizationRequested, undefined, 'another device must not claim this local worker');
  annotation.deletedAt = '2026-09-25T00:00:00Z'; annotation.version = 2;
  const deleted = cloudSync.sanitizeJournalEntry(entry);
  const combined = cloudSync.journalDocumentForDesktop(deleted, received);
  assert.ok(combined.annotations[0].deletedAt);
  assert.equal(presenter.present(deleted).supplements.length, 0);
});

test('desktop cloud sanitizer assigns missing journal dates in Shanghai time', () => {
  const entry = { id: 'legacy-midnight', entryKind: 'journal_entry', source: 'wechat',
    content: '上海凌晨记录', occurredAt: '2026-09-19T16:30:00.000Z', journalDate: '' };
  assert.equal(cloudSync.sanitizeJournalEntry(entry).journalDate, '2026-09-20');
  assert.equal(cloudSync.sanitizeJournalEntry({ ...entry, journalDate: '2026-09-18' }).journalDate, '2026-09-18');
});

test('desktop local normalization and cleanup use the same Shanghai date boundary', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  assert.doesNotMatch(source, /timestamp \+ 8 \* 60 \* 60 \* 1000/);
  assert.match(source, /capture\.journalDate = Number\.isFinite\(timestamp\) \? dayKey\(new Date\(timestamp\)\) : ''/);
  assert.match(source, /dayKey\(new Date\(task\.createdAt \|\| 0\)\) === date/);
  const home = fs.readFileSync(path.join(ROOT, 'home-sync.mjs'), 'utf8');
  assert.match(home, /const date = value instanceof Date \? value : new Date\(value\)/);
  assert.match(home, /if \(!Number\.isFinite\(date\.getTime\(\)\)\) return ""/);
});

test('a new worker resumes SQLite segment receipts when interruption happened before page-state progress was saved', async () => {
  const state = initial();
  await api.handleAction(state, { ...body('甲'.repeat(3000) + '乙'.repeat(100)), annotationId: 'restart-worker' });
  fs.writeFileSync(api.STORE_PATH, JSON.stringify(state));
  const sent = [];
  const options = { db: api.diaryJobStore, owner: 'restart-synthetic-profile',
    read: async () => JSON.parse(fs.readFileSync(api.STORE_PATH, 'utf8')),
    organize: async (_capture, raw) => { sent.push(raw[0]); return { content: raw, organizedBy: 'deepseek' }; },
  };
  const beforeRestart = createAnnotationWorker({ ...options, commit: async () => { throw new Error('interrupted before UI progress commit'); } });
  await assert.rejects(beforeRestart.resume(), /interrupted/);
  const afterRestart = createAnnotationWorker({ ...options, commit: (mutator, event) => api.mutateState(mutator, null, { event }) });
  await afterRestart.resume();
  assert.deepEqual(sent, ['甲', '乙']);
  const note = JSON.parse(fs.readFileSync(api.STORE_PATH, 'utf8')).captures[0].annotations[0];
  assert.equal(note.organizationStatus, 'organized');
  assert.ok(note.content.endsWith('乙'.repeat(100)));
});

test.after(async () => {
  await api.diaryJobStore.close();
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('mainline-annotations-'));
  fs.rmSync(directory, { recursive: true, force: true });
});
