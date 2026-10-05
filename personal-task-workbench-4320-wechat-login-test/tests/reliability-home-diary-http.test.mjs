import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { scopedClient } = require('../../wechat-mini-program-0.10.37-login-copy-20260905/tests/helpers/scoped-client.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-home-diary-http-'));
process.env.SMART_NOTEBOOK_DATA_DIR = root;
process.env.SMART_NOTEBOOK_HOME_TOKEN = 'synthetic-diary';
process.env.SMART_NOTEBOOK_HOME_OWNER = JSON.stringify({ userId: 'synthetic', workspaceId: 'A' });
process.env.DEEPSEEK_API_KEY = 'synthetic-provider-only';
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, ...args) => {
  if (new URL(url).hostname !== '127.0.0.1') throw new Error('External network forbidden');
  return nativeFetch(url, ...args);
};
const { server, createCloudInitialState, STORE_PATH, resumeDiaryOrganizations, resumeJournalOrganizations,
  resumeAnnotationOrganizations, diaryJobStore, mutateState } = await import('../server.mjs');
let release, entered;
const waiting = new Promise(resolve => { release = resolve; });
const started = new Promise(resolve => { entered = resolve; });
const modelCalls = [];
const provider = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  const body = JSON.parse(raw), context = JSON.parse(body.messages[1].content.split('上下文：\n')[1]);
  modelCalls.push(context);
  if (modelCalls.length === 1) { entered(); await waiting; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
    content: JSON.stringify({ date: context.date, daySummary: '## 今日记录\n\n' + context.manualInputs.map(part => part.content).join('\n'), periods: [] })
  } }] }));
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const initial = createCloudInitialState();
Object.assign(initial.settings, { aiMode: 'deepseek', autoOrganize: false, autoUpdateEnabled: false,
  codexSessionsDir: path.join(root, 'absent'), providerApiBase: `http://127.0.0.1:${provider.address().port}` });
fs.writeFileSync(STORE_PATH, JSON.stringify(initial));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const wire = [], metrics = { actualCloudMeasured: false, cloudRequests: 0, cloudReads: 0, cloudWrites: 0 };
const r = scopedClient(async () => { metrics.cloudRequests++; throw new Error('Cloud forbidden'); }, new Map(), {
  request(options) {
    const body = JSON.stringify(options.data), item = { path: options.url.split('/api/home/')[1], requestBytes: Buffer.byteLength(body) };
    wire.push(item);
    nativeFetch(options.url, { method: options.method, headers: options.header, body }).then(async response => {
      const raw = await response.text(); item.responseBytes = Buffer.byteLength(raw);
      options.success({ statusCode: response.status, data: JSON.parse(raw) });
    }).catch(error => options.fail({ errMsg: error.message }));
  }
}, { cloudSyncEnabled: false, manualSyncOnly: true });
r.cache.adoptScope({ account: { user: { id: 'synthetic' }, workspaceId: 'A' } });
r.cache.writeConnection({ serverBaseUrl: base, token: 'synthetic-diary' });
const disk = () => JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));

test('actual phone module -> home HTTP -> durable diary -> bounded AI worker completes without delaying save', { timeout: 15000 }, async () => {
  const date = '2026-09-20', content = '甲'.repeat(3000) + '乙'.repeat(3000) + '有可能没有完成，预算 123.45 元。';
  await r.api.call('diary.appendInput', { date, inputId: 'raw', content }, { requestId: 'raw' });
  const flushed = await r.api.flushQueue();
  assert.equal(flushed.sent, 1); assert.equal(flushed.remaining, 0);
  await started; // proves the HTTP after-commit callback, before calling resume ourselves
  const saved = disk().days.find(d => d.date === date);
  assert.equal(saved.manualInputs[0].content, content); assert.equal(saved.organizationStatus, 'pending');
  assert.equal(r.cache.read(r.cache.KEYS.diaryDays).find(d => d.date === date).manualInputs[0].pending, false);
  const done = resumeDiaryOrganizations(); release(); await done;
  const completed = disk().days.find(d => d.date === date);
  assert.equal(completed.organizationStatus, 'organized'); assert.equal(modelCalls.length, 3);
  assert.ok(completed.version > saved.version, 'completed content must replace the pending version on the phone');
  const receivedOriginal = modelCalls.flatMap(part => part.manualInputs).map(part => part.content).join('');
  assert.ok(receivedOriginal === content, `provider original differs: received=${receivedOriginal.length}, expected=${content.length}`);
  const before = fs.readFileSync(STORE_PATH, 'utf8'), callsBefore = modelCalls.length;
  await r.api.call('diary.appendInput', { date, inputId: 'raw', content }, { requestId: 'raw', immediateSync: true });
  await resumeDiaryOrganizations();
  assert.equal(r.cache.read(r.cache.KEYS.diaryDays).find(d => d.date === date).organizationStatus, 'organized');
  assert.equal(modelCalls.length, callsBefore);
  assert.equal(fs.readFileSync(STORE_PATH, 'utf8'), before, 'replay never modifies saved originals, undo or receipts');
  const idle = wire.length;
  await r.api.flushQueue(); await r.api.flushQueue();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(wire.length, idle); assert.equal(metrics.cloudRequests, 0);
  Object.assign(metrics, { diary: { modelCalls: modelCalls.length, originals: completed.manualInputs.length,
    saveAndReplayRequests: wire.length, emptyQueueRequests: wire.length - idle, wire: structuredClone(wire) } });
});

test('actual home journal batch resumes both main text and supplements after raw commit', { timeout: 10000 }, async () => {
  const modelCallsBefore = modelCalls.length;
  await mutateState(state => { state.settings.aiMode = 'rules'; });
  await r.api.call('journal.create', { id: 'journal', date: '2026-09-20', content: '保留灵光原文', favorite: true }, { requestId: 'journal' });
  await r.api.call('journal.append', { entryId: 'journal', supplementId: 'note', content: '保留补充原文' }, { requestId: 'note' });
  const flushed = await r.api.flushQueue();
  assert.equal(flushed.sent, 2);
  await Promise.all([resumeJournalOrganizations(), resumeAnnotationOrganizations()]);
  const capture = disk().captures.find(row => row.id === 'journal');
  assert.equal(capture.rawContent, '保留灵光原文');
  assert.equal(capture.organizationRequested, false);
  assert.equal(capture.annotations[0].rawContent, '保留补充原文');
  assert.equal(capture.annotations[0].organizationRequested, false);
  assert.ok(capture.favoritedAt);
  metrics.journal = { operations: 2, batchRequests: 1, modelCalls: modelCalls.length - modelCallsBefore };
  assert.equal(metrics.journal.modelCalls, 0, 'rules-only organization must not call the model');
});

test.after(async () => {
  release(); r.api.__test.cancelDirtyFlushTimer();
  await Promise.allSettled([resumeDiaryOrganizations(), resumeJournalOrganizations(), resumeAnnotationOrganizations()]);
  server.closeAllConnections(); provider.closeAllConnections();
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => provider.close(resolve))]);
  await diaryJobStore.close(); globalThis.fetch = nativeFetch;
  if (process.env.MAINLINE_TEST_EVIDENCE) fs.writeFileSync(path.join(process.env.MAINLINE_TEST_EVIDENCE, 'home-diary-local-metrics.json'), JSON.stringify(metrics, null, 2));
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('mainline-home-diary-http-'));
  fs.rmSync(root, { recursive: true, force: true });
});
