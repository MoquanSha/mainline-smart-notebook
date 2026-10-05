import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJournalWorker } from '../ai/journal-worker.mjs';
import { createAnnotationWorker } from '../ai/annotation-worker.mjs';
import { organizeDiary } from '../ai/diary-jobs.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-fidelity-'));
process.env.SMART_NOTEBOOK_DATA_DIR = directory;
const api = await import('../server.mjs');
const examples = [
  ['number', '申请费是 123.45 元。', '申请费是 132.45 元。'],
  ['negation', '我没有完成申请。', '我完成了申请。'],
  ['uncertainty', '我可能会报名，时间尚不确定。', '我会报名，时间已经确定。'],
];
for (const [kind, raw, changed] of examples) {
  test(`desktop journal rejects changed ${kind}, preserves candidate and original, and waits for explicit retry`, async () => {
    const state = api.createCloudInitialState(); state.settings.aiMode = 'deepseek';
    await api.handleAction(state, { action: 'capture.add', id: kind, content: raw, intent: 'organize', source: 'manual', journalDate: '2026-09-25' });
    let calls = 0, output = changed;
    const config = { db: api.diaryJobStore, owner: `journal-${kind}`, read: async () => state, commit: async (mutate) => mutate(state),
      organize: async () => { calls++; return { content: output, organizedBy: 'deepseek' }; } };
    await createJournalWorker(config).resume();
    const row = state.captures[0];
    assert.equal(row.organizationStatus, 'failed');
    assert.equal(row.rawContent, raw); assert.equal(row.organizedContent, raw);
    assert.equal(row.organizationJob.automaticRetry, false);
    assert.match(row.aiError, /原意|数字|否定|不确定/);
    const saved = await api.diaryJobStore.collection('ai_runs').doc(row.organizationJob.id).get();
    const manifest = Array.isArray(saved.data) ? saved.data[0] : saved.data;
    assert.equal(manifest.fidelityReview.candidate, changed);
    assert.equal(manifest.fidelityReview.partIndex, 0);
    await createJournalWorker(config).resume(); assert.equal(calls, 1);
    output = '**' + raw + '**';
    await createJournalWorker(config).resume({ retry: true, captureId: kind });
    assert.equal(calls, 2); assert.equal(row.organizationStatus, 'ai_organized'); assert.equal(row.rawContent, raw);
  });
  test(`desktop annotation rejects changed ${kind} without replacing its reading body`, async () => {
    const state = api.createCloudInitialState(); state.settings.aiMode = 'deepseek';
    state.captures.push({ id: 'parent', content: '主笔记', annotations: [{ id: kind, content: raw, rawContent: raw, organizationRequested: true }] });
    let calls = 0;
    const config = { db: api.diaryJobStore, owner: `annotation-${kind}`, read: async () => state, commit: async (mutate) => mutate(state),
      organize: async () => { calls++; return { content: changed, organizedBy: 'deepseek' }; } };
    await createAnnotationWorker(config).resume();
    const row = state.captures[0].annotations[0];
    assert.equal(row.content, raw); assert.equal(row.organizationStatus, 'failed'); assert.equal(row.organizationJob.automaticRetry, false);
    await createAnnotationWorker(config).resume(); assert.equal(calls, 1);
  });
  test(`desktop diary checks ${kind} against diary body, not matching words hidden in supplements`, async () => {
    const options = { db: api.diaryJobStore, owner: `diary-${kind}`, date: '2026-09-25', providerKey: 'test',
      input: { promptTemplate: '保留原意', outputSchema: {}, context: { manualInputs: [{ id: kind, content: raw }], dailyFacts: {} } },
      validate: (value) => value, generate: async () => ({ daySummary: '## 今日记录\n\n' + changed + '\n\n## 今日补充\n\n' + raw, periods: [] }) };
    const result = await organizeDiary(options);
    assert.equal(result.value, undefined); assert.equal(result.job.status, 'failed'); assert.equal(result.job.automaticRetry, false);
  });
}
test.after(async () => { await api.diaryJobStore.close(); assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('mainline-fidelity-')); fs.rmSync(directory, { recursive: true, force: true }); });
