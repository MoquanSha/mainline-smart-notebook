import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJournalWorker } from '../ai/journal-worker.mjs';
import { createAnnotationWorker } from '../ai/annotation-worker.mjs';
import { organizeDiary } from '../ai/diary-jobs.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-segments-'));
process.env.SMART_NOTEBOOK_DATA_DIR = root;
const api = await import('../server.mjs');
const examples = [
  ['amount', '甲'.repeat(2998) + '123.45元。'],
  ['uncertain', '甲'.repeat(2999) + '不确定。'],
  ['fence', '说明。\n\n```js\n' + 'const amount = 123.45; // 没有付款\n'.repeat(220) + '```\n\n结尾可能会调整。'],
];
for (const [name, raw] of examples) {
  test(`desktop ${name} survives echo organization without artificial seams in journal and diary`, async () => {
    const state = api.createCloudInitialState(); state.settings.aiMode = 'deepseek';
    await api.handleAction(state, { action: 'capture.add', id: name, content: raw, intent: 'organize', source: 'manual' });
    await createJournalWorker({ db: api.diaryJobStore, owner: name, read: async () => state, commit: async (f) => f(state),
      organize: async (_row, content) => ({ content, organizedBy: 'deepseek' }) }).resume();
    assert.equal(state.captures[0].organizedContent, raw);
    assert.equal(state.captures[0].rawContent, raw);
    state.captures[0].annotations = [{ id: 'annotation', rawContent: raw, content: raw, organizationRequested: true }];
    await createAnnotationWorker({ db: api.diaryJobStore, owner: name, read: async () => state, commit: async (f) => f(state),
      organize: async (_row, content) => ({ content, organizedBy: 'deepseek' }) }).resume();
    assert.equal(state.captures[0].annotations[0].content, raw);
    const result = await organizeDiary({ db: api.diaryJobStore, owner: name, date: '2026-09-25', providerKey: 'synthetic',
      input: { promptTemplate: '保留原意', outputSchema: {}, context: { manualInputs: [{ id: name, content: raw }] } },
      maxParts: 32, validate: (value) => value,
      generate: async ({ context }) => ({ daySummary: '## 今日记录\n\n' + context.manualInputs[0].content, periods: [] }) });
    assert.equal(result.value.daySummary, '## 今日记录\n\n' + raw);
  });
}
test('desktop journal explicit retry repairs an aggregate seam in a new receipt generation', async () => {
  const raw = '甲'.repeat(2999) + '。2元';
  const state = api.createCloudInitialState(); state.settings.aiMode = 'deepseek';
  await api.handleAction(state, { action: 'capture.add', id: 'aggregate', content: raw, intent: 'organize', source: 'manual' });
  let safe = false, calls = 0;
  const options = { db: api.diaryJobStore, owner: 'aggregate', read: async () => state, commit: async (f) => f(state),
    organize: async (_row, content) => { calls++; return { content: content + (!safe && content.startsWith('甲') ? '\n\n1. ' : ''), organizedBy: 'deepseek' }; } };
  await createJournalWorker(options).resume();
  assert.equal(state.captures[0].organizationStatus, 'failed'); assert.equal(calls, 2);
  assert.equal(state.captures[0].organizedContent, raw);
  safe = true;
  await createJournalWorker(options).resume({ retry: true, captureId: 'aggregate' });
  assert.equal(state.captures[0].organizationStatus, 'ai_organized'); assert.equal(calls, 4);
  assert.equal(state.captures[0].organizationJob.generation, 1);
  assert.equal(state.captures[0].organizedContent, raw);
});
test.after(async () => { await api.diaryJobStore.close(); assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('mainline-segments-')); fs.rmSync(root, { recursive: true, force: true }); });
