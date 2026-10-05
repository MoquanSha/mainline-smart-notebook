import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-diary-http-'));
process.env.SMART_NOTEBOOK_DATA_DIR = root;
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, ...args) => {
  if (new URL(url).hostname !== '127.0.0.1') throw new Error('External network forbidden in this test');
  return nativeFetch(url, ...args);
};
const { server, createCloudInitialState, STORE_PATH, resumeDiaryOrganizations, diaryJobStore, mutateState, readBody } = await import('../server.mjs');
process.env.DEEPSEEK_API_KEY = 'synthetic-provider-only';
let release, entered;
const waiting = new Promise((resolve) => { release = resolve; });
const started = new Promise((resolve) => { entered = resolve; });
const calls = [];
let truncated = false;
const provider = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  const context = JSON.parse(body.messages[1].content.split('上下文：\n')[1]);
  calls.push(context);
  if (calls.length === 1) { entered(); await waiting; }
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ finish_reason: truncated ? 'length' : 'stop',
    message: { content: JSON.stringify({ date: context.date, daySummary: '## 今日记录\n\n' + context.manualInputs.map((part) => part.content).join('\n'), periods: [] }) } }] }));
});
await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
const initial = createCloudInitialState();
Object.assign(initial.settings, { aiMode: 'deepseek', autoUpdateEnabled: false, autoOrganize: false,
  codexSessionsDir: path.join(root, 'absent'), providerApiBase: `http://127.0.0.1:${provider.address().port}` });
fs.writeFileSync(STORE_PATH, JSON.stringify(initial));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const read = () => nativeFetch(base + '/api/state').then((response) => response.json());
const action = (body) => nativeFetch(base + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (response) => {
  const result = await response.json();
  assert.equal(response.status, 200, result.error);
  return result;
});

test('real HTTP save returns before provider reply; full input and progress survive through final local commit', async () => {
  const date = '2026-09-24', content = '甲'.repeat(3000) + '乙'.repeat(3000) + '可能没有完成，预算 123.45 元。';
  const saved = await action({ action: 'diary.appendInput', date, inputId: 'long-original', content });
  await started;
  const onDisk = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  assert.equal(onDisk.days.find((day) => day.date === date).manualInputs[0].content, content);
  const pending = await read();
  assert.equal(pending.aiRuns.length, 0, 'uncommitted AI snapshot must not leak into cached GET state');
  assert.equal(pending.days.find((day) => day.date === date).organizationStatus, 'pending');
  const done = resumeDiaryOrganizations();
  release();
  await done;
  const result = await read(), day = result.days.find((item) => item.date === date);
  assert.equal(calls.length, 3);
  const sent = calls.flatMap((part) => part.manualInputs).map((part) => part.content).join('');
  assert.ok(sent === content, `all originals should reach the provider once; sent=${sent.length}, original=${content.length}, segments=${JSON.stringify(calls.map((part) => part.manualInputs.map(input => ({ id: input.id, length: input.content.length, head: input.content.slice(0, 12), tail: input.content.slice(-30) }))))}`);
  assert.equal(day.organizationJob.completed, 3);
  assert.equal(day.organizationStatus, 'organized');
  assert.ok(day.summary.includes('可能没有完成，预算 123.45 元。'));
  assert.ok(result.meta.localRevision > saved.meta.localRevision);
  await action({ action: 'diary.refresh', date });
  await resumeDiaryOrganizations();
  assert.equal(calls.length, 3, 'unchanged originals should use committed receipts');
});

test('legacy organizeInput compatibility keeps the complete original beyond the old 6000-character preview limit', async () => {
  const date = '2026-09-22';
  const content = '甲'.repeat(7000) + '\n否定与不确定：没有确认，可能还要复核。';
  await action({ action: 'diary.organizeInput', date, inputId: 'legacy-long-original', content });
  const day = (await read()).days.find((item) => item.date === date);
  assert.equal(day.manualInputs.find((item) => item.id === 'legacy-long-original').content, content);
  assert.ok(day.summary.includes('否定与不确定：没有确认，可能还要复核。'));
  assert.ok(day.summary.startsWith('## 今日记录\n\n甲'));
});

test('provider output cutoff is visible as failure; originals remain and manual retry completes', async () => {
  truncated = true;
  const date = '2026-09-23';
  await action({ action: 'diary.appendInput', date, inputId: 'cutoff', content: '不能把没有完成写成完成。' });
  await resumeDiaryOrganizations();
  const failed = (await read()).days.find((day) => day.date === date);
  assert.equal(failed.organizationStatus, 'failed');
  assert.match(failed.aiError, /长度上限/);
  assert.equal(failed.manualInputs[0].content, '不能把没有完成写成完成。');
  truncated = false;
  await action({ action: 'diary.refresh', date });
  await resumeDiaryOrganizations();
  assert.equal((await read()).days.find((day) => day.date === date).organizationStatus, 'organized');
});

test('GET never exposes an in-flight mutation that eventually fails before disk commit', async () => {
  const original = await read();
  let enter, allow;
  const entered = new Promise((resolve) => { enter = resolve; });
  const pending = new Promise((resolve) => { allow = resolve; });
  const changing = mutateState(async (state) => {
    state.days[0].summary = 'UNCOMMITTED CONTENT';
    enter(); await pending;
    throw new Error('abort before commit');
  });
  const rejected = assert.rejects(changing, /abort before commit/);
  try {
    await entered;
    assert.ok((await read()).days[0].summary === original.days[0].summary, 'in-flight content escaped through the shared cache');
  } finally { allow(); await rejected; }
  assert.ok((await read()).days[0].summary === original.days[0].summary, 'aborted content remained in the shared cache');
});

test('request decoding preserves Chinese, emoji and combining text split at every byte boundary', async () => {
  const value = { content: '原文甲乙👨‍👩‍👧‍👦e\u0301不能改变，预算 123.45 元。' };
  const bytes = Buffer.from(JSON.stringify(value));
  for (let at = 1; at < bytes.length; at++) {
    const request = (async function* () { yield bytes.subarray(0, at); yield bytes.subarray(at); })();
    assert.deepEqual(await readBody(request), value, `UTF-8 byte boundary ${at}`);
  }
});

test('invalid UTF-8 and oversized multibyte input are rejected instead of silently replacing originals', async () => {
  const invalid = (async function* () { yield Buffer.from('{"content":"'); yield Buffer.from([0xff]); yield Buffer.from('"}'); })();
  await assert.rejects(readBody(invalid), error => error.status === 400);
  const oversized = (async function* () { yield Buffer.from(JSON.stringify({ content: '甲'.repeat(700000) })); })();
  await assert.rejects(readBody(oversized), error => error.status === 413);
});

test.after(async () => {
  release();
  await resumeDiaryOrganizations();
  server.closeAllConnections(); provider.closeAllConnections();
  await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => provider.close(resolve))]);
  await diaryJobStore.close();
  globalThis.fetch = nativeFetch;
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('mainline-diary-http-'));
  fs.rmSync(root, { recursive: true, force: true });
});
