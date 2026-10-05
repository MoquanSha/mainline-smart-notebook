import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-diary-worker-'));
process.env.SMART_NOTEBOOK_DATA_DIR = root;
const { executeAction, resumeDiaryOrganizations, createCloudInitialState, STORE_PATH, diaryJobStore, synthesizeDay, reconcileDailySummaryTodoFacts, formatDailyDiarySummary } = await import('../server.mjs');
const initial = createCloudInitialState();
initial.settings.aiMode = 'rules';
initial.settings.autoUpdateEnabled = false;
initial.settings.codexSessionsDir = path.join(root, 'absent');
fs.writeFileSync(STORE_PATH, JSON.stringify(initial));
const disk = () => JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
const find = (date) => disk().days.find((day) => day.date === date);
const complete = async (snapshot, date) => {
  const day = snapshot.days.find((item) => item.date === date);
  day.organizationStatus = 'organized';
  day.synthesisSource = 'llm';
  day.summary = '## 今日记录\n\n' + day.manualInputs.map((item) => item.content).join('\n');
};

test('new original is not blocked by a previous permanently failed job', async () => {
  const date = '2026-09-20';
  await executeAction({ action: 'diary.appendInput', date, inputId: 'old', content: '原文' });
  const state = disk(), day = state.days.find((item) => item.date === date);
  day.organizationJob = { id: 'old-failed', status: 'failed', retryable: false, retryAfter: Date.now() + 60000 };
  day.aiError = 'old capacity error';
  fs.writeFileSync(STORE_PATH, JSON.stringify(state));
  await executeAction({ action: 'diary.appendInput', date, inputId: 'new', content: '新增原文' });
  assert.equal(find(date).organizationJob, undefined);
  assert.equal(find(date).aiError, '');
  await resumeDiaryOrganizations(null, { organize: complete });
  assert.equal(find(date).organizationRequested, false);
});

test('startup schedules one wakeup for a persisted running lease without a second user action', { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const date = '2026-09-21';
  await executeAction({ action: 'diary.appendInput', date, inputId: 'restart', content: '等待重启后继续' });
  const state = disk(), day = state.days.find((item) => item.date === date);
  day.organizationJob = { id: 'lease', status: 'running', completed: 1, total: 2, retryAfter: Date.now() + 120 };
  fs.writeFileSync(STORE_PATH, JSON.stringify(state));
  let calls = 0, started;
  const entered = new Promise((resolve) => { started = resolve; });
  await resumeDiaryOrganizations(null, { organize: async (...args) => { calls++; started(); await complete(...args); } });
  assert.equal(calls, 0);
  t.mock.timers.tick(131);
  await entered; // The scheduled callback must start the work by itself.
  await resumeDiaryOrganizations(); // Join the now-active worker before inspecting its disk commit.
  assert.equal(calls, 1);
  assert.equal(find(date).organizationRequested, false);
});

test('background submit resolves while AI is pending and a stale AI result cannot replace a later original', async () => {
  const date = '2026-09-22';
  let enter, release, calls = 0;
  const entered = new Promise((resolve) => { enter = resolve; });
  const waiting = new Promise((resolve) => { release = resolve; });
  const organize = async (snapshot, target) => {
    calls++;
    if (calls === 1) { enter(); await waiting; }
    await complete(snapshot, target);
  };
  const saved = await executeAction({ action: 'diary.appendInput', date, inputId: 'a', content: 'A' }, null, organize, { background: true });
  assert.equal(saved.days.find((day) => day.date === date).manualInputs[0].content, 'A');
  await entered;
  await executeAction({ action: 'diary.appendInput', date, inputId: 'b', content: 'B' }, null, organize, { background: true });
  const finished = resumeDiaryOrganizations(null, { organize });
  release();
  await finished;
  assert.equal(calls, 2);
  assert.deepEqual(find(date).manualInputs.map((item) => item.content), ['A', 'B']);
  assert.equal(find(date).summary, '## 今日记录\n\nA\nB');
  assert.equal(find(date).organizationRequested, false);
});

test('checkpoint failure exposes a failed retry state without discarding original input', async () => {
  const state = createCloudInitialState();
  state.settings.aiMode = 'deepseek';
  const date = '2026-09-23';
  state.days.push({ date, manualInputs: [{ id: 'a', content: '保留这份原文', createdAt: '2026-09-23T00:00:00Z' }],
    eventIds: [], sessions: [], periods: [], organizationJob: { id: 'obsolete', status: 'complete' } });
  const result = await synthesizeDay(state, date, { owner: 'synthetic', db: { runTransaction() { throw new Error('disk unavailable'); } } });
  assert.equal(result.organizationJob.status, 'failed');
  assert.ok(result.organizationJob.retryAfter > Date.now());
  assert.equal(result.manualInputs[0].content, '保留这份原文');
});

test('empty handwritten input cannot let task facts become the daily diary body', () => {
  const result = reconcileDailySummaryTodoFacts(
    '## 今日记录\n\n模型误把“完成整理”写成了今日感悟。\n\n## 今日补充\n\n- 电脑端工作结果：整理记录',
    { completedTodos: [{ title: '完成整理' }], proposedTodos: [], todoNotes: [] },
    [],
  );
  assert.equal(result.split('\n\n## 今日补充\n\n')[0], '## 今日记录\n\n今天暂未手动补写日记或感悟。');
  assert.match(result, /电脑端工作结果：整理记录/);
  assert.match(result, /今日待办完成：完成整理/);
});

test('handwritten input remains the main section while verified facts stay supplemental', () => {
  const result = reconcileDailySummaryTodoFacts(
    '## 今日记录\n\n今天有点累，但还是完成了主要工作。\n\n## 今日补充\n\n- 模型补充的工作结果',
    { completedTodos: [{ title: '完成整理' }], proposedTodos: [], todoNotes: [] },
    [{ id: 'input', content: '今天有点累，但还是完成了主要工作。' }],
  );
  assert.match(result, /^## 今日记录\n\n今天有点累/);
  assert.equal((result.match(/## 今日补充/g) || []).length, 1);
  assert.match(result, /今日待办完成：完成整理/);
  assert.doesNotMatch(result, /模型补充的工作结果/);
});

test('manual diary input gets reversible light formatting and only completed todos are appended', () => {
  const original = '今天完成了同步排查。\n\n\n晚上还想再复盘一下。';
  const summary = formatDailyDiarySummary([{ content: original }], [{ title: '完成同步排查' }, { title: '明天再看' }]);
  assert.equal(summary, '## 今日记录\n\n今天完成了同步排查。\n\n晚上还想再复盘一下。\n\n## 今日补充\n\n- 今日待办完成：完成同步排查、明天再看');
  assert.equal(original.includes("\n\n\n"), true);
});

test('a handwritten Markdown supplement heading is preserved as user content', () => {
  const content = '今天记录自己的复盘。\n\n## 今日补充\n\n这里是我原本写的第二段。';
  const result = reconcileDailySummaryTodoFacts(
    `## 今日记录\n\n${content}`,
    { completedTodos: [{ title: '完成整理' }], proposedTodos: [], todoNotes: [] },
    [{ id: 'input-heading', content }],
  );
  assert.match(result, /这里是我原本写的第二段/);
  assert.match(result, /今日待办完成：完成整理/);
});

test.after(async () => {
  await diaryJobStore.close();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('mainline-diary-worker-'));
  fs.rmSync(root, { recursive: true, force: true });
});
