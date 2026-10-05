import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-diary-reliability-'));
process.env.SMART_NOTEBOOK_DATA_DIR = root;
const { executeAction, createCloudInitialState, STORE_PATH } = await import('../server.mjs');
const require = createRequire(import.meta.url);
const desktop = require('../electron/cloud-sync.cjs');
const cloud = require('../../wechat-mini-program-0.10.37-login-copy-20260905/cloudfunctions/desktopSync/index.js').__test;
const state = createCloudInitialState();
state.settings.autoUpdateEnabled = false;
state.settings.aiMode = 'rules';
state.settings.codexSessionsDir = path.join(root, 'empty-codex');
fs.writeFileSync(STORE_PATH, JSON.stringify(state));
const day = (date) => JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')).days.find((item) => item.date === date);

test('desktop originals are already on disk while AI waits, and a new original can be saved without waiting for AI', async () => {
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  const date = '2026-09-24';
  const organizing = executeAction({ action: 'diary.organizeInput', date, inputId: 'a', content: 'first original' }, null, async (snapshot) => {
    entered();
    await pending;
    const target = snapshot.days.find((item) => item.date === date);
    target.summary = '## 今日记录\n\nold AI result';
    target.synthesisSource = 'llm';
  });
  await started;
  assert.equal(day(date).manualInputs[0].content, 'first original');
  await executeAction({ action: 'diary.appendInput', date, inputId: 'b', content: 'second original' });
  release();
  await organizing;
  assert.deepEqual(day(date).manualInputs.map((input) => input.id), ['a', 'b']);
  assert.ok(!day(date).summary.includes('old AI result'));
});

test('desktop retries preserve one original and long Markdown survives desktop-cloud-desktop sanitizers', async () => {
  const content = '  **可能并没有完成**，预算 123.45 元。🙂\n'.repeat(500) + 'END  ';
  const action = { action: 'diary.appendInput', date: '2026-09-23', inputId: 'long', content };
  await executeAction(action);
  await executeAction(action);
  const original = day(action.date);
  assert.equal(original.manualInputs.length, 1);
  assert.equal(original.manualInputs[0].content, content);
  const transferred = desktop.sanitizeDayRecord(cloud.sanitizeDayRecordDocument(desktop.sanitizeDayRecord(original)));
  assert.equal(transferred.manualInputs[0].content, content);
  assert.ok(transferred.summary.endsWith('END'));
  await assert.rejects(executeAction({ ...action, content: 'different' }), /提交编号/);
});

test.after(() => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('mainline-diary-reliability-'));
  fs.rmSync(root, { recursive: true, force: true });
});
