import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';

const directory = await import('node:fs').then(({ mkdtempSync }) => mkdtempSync(path.join(os.tmpdir(), 'mainline-todo-fidelity-')));
process.env.SMART_NOTEBOOK_DATA_DIR = directory;
const api = await import('../server.mjs');
const testDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

test('desktop today-todo input and comment paths retain long source tails', async () => {
  const content = `今天记录 ${'中文🙂'.repeat(1800)} 结尾保留标记-desktop-${testDate.replaceAll('-', '')}`;
  const items = api.splitTodayTodoInput(content);
  assert.equal(items.length, 1);
  assert.equal(items[0].raw, content);
  assert.match(items[0].raw, new RegExp(`结尾保留标记-desktop-${testDate.replaceAll('-', '')}$`));

  const state = api.createCloudInitialState();
  Object.assign(state.settings, { aiMode: 'rules', autoOrganize: false, autoUpdateEnabled: false });
  await api.handleAction(state, { action: 'todayTodo.add', content, date: testDate, clientItems: [{ id: 'today_todo_client_1_tail' }] });
  assert.equal(state.dailyTasks[0].rawInput, content);

  const comment = `进展 ${'评论🙂'.repeat(1800)} 结尾保留标记-comment-${testDate.replaceAll('-', '')}`;
  await api.handleAction(state, { action: 'todayTodo.commentAdd', todoId: state.dailyTasks[0].id, content: comment, commentId: 'todo_comment_client_1_tail' });
  assert.equal(state.dailyTasks[0].comments[0].rawContent, comment);
});
