import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { scopedClient } = require('../../wechat-mini-program-0.10.37-login-copy-20260905/tests/helpers/scoped-client.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-home-history-client-'));
process.env.SMART_NOTEBOOK_DATA_DIR = directory; process.env.SMART_NOTEBOOK_HOME_TOKEN = 'synthetic';
process.env.SMART_NOTEBOOK_HOME_OWNER = JSON.stringify({ userId: 'synthetic', workspaceId: 'A' });
const { server, STORE_PATH, createCloudInitialState, mutateState, diaryJobStore } = await import('../server.mjs');
const initial = createCloudInitialState(), date = i => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
Object.assign(initial.settings, { aiMode: 'rules', autoOrganize: false, autoUpdateEnabled: false, codexSessionsDir: path.join(directory, 'absent') });
initial.tasks = Array.from({ length: 245 }, (_, i) => ({ id: 'task-' + String(i).padStart(3, '0'), title: '任务', version: 1, steps: [] }));
initial.days = Array.from({ length: 245 }, (_, i) => ({ date: date(i), summary: '原文 ' + i, version: 1, manualInputs: [] }));
fs.writeFileSync(STORE_PATH, JSON.stringify(initial));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`, storage = new Map(), requests = [];
let failPage = false, alter, cloudRequests = 0, r;
const owner = workspaceId => ({ account: { user: { id: 'synthetic' }, workspaceId } });
function open() {
  r = scopedClient(async () => { cloudRequests++; throw new Error('Cloud forbidden'); }, storage, {
    request(options) {
      const action = options.data.action; requests.push(action);
      if (failPage && action === 'sync.historyPage') { failPage = false; options.fail({ errMsg: 'lost page' }); return; }
      fetch(options.url, { method: options.method, headers: options.header, body: JSON.stringify(options.data) }).then(async response => {
        const result = await response.json();
        if (alter) result.data = alter(action, result.data);
        options.success({ statusCode: response.status, data: result });
      }).catch(error => options.fail({ errMsg: error.message }));
    }
  }, { cloudSyncEnabled: false, manualSyncOnly: true });
  r.cache.adoptScope(owner('A')); r.cache.writeConnection({ serverBaseUrl: base, token: 'synthetic' });
  r.cache.write(r.cache.KEYS.bootstrap, owner('A'));
  return r;
}
open();
test.after(async () => {
  r.api.__test.cancelDirtyFlushTimer(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve)); await diaryJobStore.close();
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('mainline-home-history-client-'));
  fs.rmSync(directory, { recursive: true, force: true });
});

test('actual phone receives bounded home history, keeps failed-page progress and resumes after reopening', async () => {
  const first = await r.api.syncNow({ historyPageBudget: 1 });
  assert.equal(first.history?.supported, true); assert.equal(first.history.pending, true);
  const checkpoint = r.cache.read(r.cache.KEYS.homeHistoryTransfer);
  failPage = true;
  const failed = await r.api.syncNow({ historyPageBudget: 1 });
  assert.equal(failed.history.pending, true); assert.equal(failed.history.error.code, 'HOME_OFFLINE');
  assert.deepEqual(r.cache.read(r.cache.KEYS.homeHistoryTransfer), checkpoint);
  r.api.__test.cancelDirtyFlushTimer(); open();
  let result;
  for (let i = 0; i < 12; i++) {
    result = await r.api.syncNow({ historyPageBudget: 2 });
    if (!result.history.pending) break;
  }
  assert.equal(result.remoteFresh, true);
  assert.equal(r.cache.read(r.cache.KEYS.diaryDays).length, 245);
  assert.equal(r.cache.read(r.cache.KEYS.tasks).length, 245);
  assert.equal(r.cache.read(r.cache.KEYS.historyTransfer, null), null, 'cloud checkpoint stays separate');
  assert.equal(cloudRequests, 0);
});

test('subsequent sync receives changed AI body and deletions without replaying writes or all history', async () => {
  await mutateState(state => {
    state.days.find(row => row.date === date(0)).summary = '后续整理结果';
    state.days.find(row => row.date === date(0)).organizationStatus = 'organized';
    state.days = state.days.filter(row => row.date !== date(1));
  });
  const before = requests.length;
  const result = await r.api.syncNow();
  assert.equal(result.remoteFresh, true);
  assert.deepEqual(requests.slice(before), ['sync.snapshot', 'sync.changes']);
  const days = r.cache.read(r.cache.KEYS.diaryDays);
  assert.equal(days.find(row => row.date === date(0)).summary, '后续整理结果');
  assert.ok(!days.some(row => row.date === date(1)), 'a prior cached day must not reappear after its tombstone');
  const idle = requests.length, file = fs.readFileSync(STORE_PATH, 'utf8');
  await r.api.syncNow();
  assert.deepEqual(requests.slice(idle), ['sync.snapshot']);
  assert.equal(fs.readFileSync(STORE_PATH, 'utf8'), file);
});

test('foreign home profile header cannot overwrite cache, cursor, or queued original', async () => {
  const original = r.cache.read(r.cache.KEYS.homeHistoryTransfer);
  const days = r.cache.read(r.cache.KEYS.diaryDays);
  alter = (action, data) => action === 'sync.snapshot' ? { ...data, epoch: 'foreign-profile' } : data;
  try { await assert.rejects(r.api.syncNow(), { code: 'WORKSPACE_MISMATCH' }); }
  finally { alter = null; }
  assert.deepEqual(r.cache.read(r.cache.KEYS.homeHistoryTransfer), original);
  assert.deepEqual(r.cache.read(r.cache.KEYS.diaryDays), days);
});

test('a failed atomic page checkpoint leaves the same cursor for a later explicit retry', async () => {
  await mutateState(state => { state.tasks[0].title = 'later'; });
  const checkpoint = r.cache.read(r.cache.KEYS.homeHistoryTransfer);
  const set = global.wx.setStorageSync;
  global.wx.setStorageSync = (key, value) => {
    if (key.endsWith('.homeHistoryTransfer')) throw new Error('storage full');
    set(key, value);
  };
  const failed = await r.api.syncNow();
  assert.equal(failed.history.pending, true); assert.ok(failed.history.error);
  assert.deepEqual(r.cache.read(r.cache.KEYS.homeHistoryTransfer), checkpoint);
  global.wx.setStorageSync = set;
  await r.api.syncNow();
  assert.equal(r.cache.read(r.cache.KEYS.tasks).find(row => row.id === 'task-000').title, 'later');
});
