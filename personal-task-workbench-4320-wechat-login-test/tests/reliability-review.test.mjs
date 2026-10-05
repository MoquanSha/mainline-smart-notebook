import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createJournalWorker } from '../ai/journal-worker.mjs';
import { createAnnotationWorker } from '../ai/annotation-worker.mjs';
import { organizeDiary } from '../ai/diary-jobs.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-review-'));
process.env.SMART_NOTEBOOK_DATA_DIR = directory;
const api = await import('../server.mjs');
const hash = (text) => createHash('sha256').update(text).digest('hex');
const scope = hash(`local:${directory}`), owner = `profile:${hash(directory)}`;
const raw = '我可能没有支付123元。', candidate = '我支付132元。';
const save = (state) => fs.writeFileSync(api.STORE_PATH, JSON.stringify(state));
test('desktop journal review uses the same profile and active record; wrong space and deleted targets reveal nothing', async () => {
  const state = api.createCloudInitialState(); state.settings.aiMode = 'deepseek';
  await api.handleAction(state, { action: 'capture.add', id: 'journal', content: raw, intent: 'organize', source: 'manual', journalDate: '2026-09-25' });
  const worker = createJournalWorker({ db: api.diaryJobStore, owner, read: async () => state,
    commit: async (mutate) => { mutate(state); save(state); }, organize: async () => ({ content: candidate }) });
  await worker.resume();
  const query = { expectedDataScope: scope, kind: 'journal_entry', captureId: 'journal' };
  const page = await api.readOrganizationReview(query);
  assert.equal(page.original, raw); assert.equal(page.candidate, candidate);
  assert.equal(state.captures[0].organizedContent, raw);
  await assert.rejects(api.readOrganizationReview({ ...query, expectedDataScope: 'another' }), /切换/);
  await assert.rejects(api.readOrganizationReview({ ...query, captureId: 'another' }), /删除|空间/);
  state.captures[0].deletedAt = new Date().toISOString(); save(state);
  await assert.rejects(api.readOrganizationReview(query), /删除/);
});
test('desktop diary and annotation review resolve through their owning source record', async () => {
  const state = api.createCloudInitialState(); state.settings.aiMode = 'deepseek';
  state.captures.push({ id: 'parent', content: '主笔记', annotations: [{ id: 'note', rawContent: raw, content: raw, organizationRequested: true }] });
  await createAnnotationWorker({ db: api.diaryJobStore, owner, read: async () => state,
    commit: async (mutate) => mutate(state), organize: async () => ({ content: candidate }) }).resume();
  const result = await organizeDiary({ db: api.diaryJobStore, owner, date: '2026-09-25', providerKey: 'synthetic',
    input: { promptTemplate: '保留原意', outputSchema: {}, context: { manualInputs: [{ id: 'a', content: raw }], dailyFacts: {} } },
    generate: async () => ({ daySummary: '## 今日记录\n\n' + candidate, periods: [] }), validate: (value) => value });
  state.days.push({ date: '2026-09-25', manualInputs: [{ id: 'a', content: raw }], organizationJob: result.job }); save(state);
  const annotation = await api.readOrganizationReview({ expectedDataScope: scope, kind: 'journal_annotation', captureId: 'parent', annotationId: 'note' });
  const diary = await api.readOrganizationReview({ expectedDataScope: scope, kind: 'daily_diary', date: '2026-09-25' });
  assert.equal(annotation.original, raw); assert.equal(annotation.candidate, candidate);
  assert.equal(diary.original, raw); assert.equal(diary.candidate, '## 今日记录\n\n' + candidate);
});
test.after(async () => { await api.diaryJobStore.close(); assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('mainline-review-')); fs.rmSync(directory, { recursive: true, force: true }); });
