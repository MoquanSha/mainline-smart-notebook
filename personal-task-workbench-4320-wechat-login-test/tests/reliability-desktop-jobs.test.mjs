import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createJobStore } from '../ai/job-store.mjs';
import { organizeDiary, diarySegments } from '../ai/diary-jobs.mjs';
import jobs from '../ai/organization-job.cjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-ai-jobs-'));
test.after(() => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('mainline-ai-jobs-'));
  fs.rmSync(root, { recursive: true, force: true });
});
const input = { promptTemplate: '保留原意', outputSchema: {}, context: { date: '2026-09-24', now: '2026-09-24T01:00:00Z',
  manualInputs: [{ id: 'one', content: '甲'.repeat(3000) + '乙'.repeat(3000) + '丙'.repeat(10) }], dailyFacts: {}, captures: [],
  timelineEvents: [], sessions: [], dailyTasks: [], activeTasks: [], existingPeriods: [] } };
const options = { owner: 'A', date: input.context.date, providerKey: 'model:v1', input, validate: (value) => value };
const generate = async ({ context }) => ({ daySummary: '## 今日记录\n\n' + context.manualInputs.map((item) => item.content).join('\n\n'), periods: [] });

test('desktop and cloud use the identical lease/receipt implementation', () => {
  assert.equal(fs.readFileSync(new URL('../ai/organization-job.cjs', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../../wechat-mini-program-0.10.37-login-copy-20260905/cloudfunctions/notebookApi/organization-job.js', import.meta.url), 'utf8'));
});

test('long Unicode originals are sent in full; changing wall clock or generated periods does not redo completed work', async () => {
  const db = createJobStore(path.join(root, 'long.sqlite'));
  let calls = 0;
  const content = '🙂甲\n'.repeat(2400) + '结尾 123.45，并没有完成。';
  const longInput = { ...input, context: { ...input.context, manualInputs: [{ id: 'one', content }] } };
  const parts = diarySegments(longInput.context);
  assert.equal(parts.flatMap((part) => part.manualInputs).map((part) => part.content).join(''), content);
  assert.ok(parts.every((part) => Array.from(part.manualInputs[0].content).length <= 3000));
  const first = await organizeDiary({ ...options, input: longInput, db, maxParts: 32, generate: async (part) => { calls++; return generate(part); } });
  const count = calls;
  const second = await organizeDiary({ ...options, input: { ...longInput, context: { ...longInput.context, now: 'another clock', existingPeriods: [{ title: 'generated' }] } }, db,
    generate: async () => { calls++; throw new Error('must not rerun'); } });
  assert.equal(calls, count);
  assert.equal(second.value.daySummary, first.value.daySummary);
  assert.ok(first.value.daySummary.endsWith('结尾 123.45，并没有完成。'));
  await db.close();
});

test('restart after a middle-part failure retains successful parts in the real on-disk store', async () => {
  const file = path.join(root, 'restart.sqlite');
  let db = createJobStore(file), calls = [];
  await organizeDiary({ ...options, db, maxParts: 3, generate: async (part) => {
    calls.push(part.context.segment.index);
    if (part.context.segment.index === 1) throw new Error('interrupted');
    return generate(part);
  } });
  await db.close();
  db = createJobStore(file);
  const done = await organizeDiary({ ...options, db, retry: true, maxParts: 3,
    generate: async (part) => { calls.push(part.context.segment.index); return generate(part); } });
  assert.deepEqual(calls, [0, 1, 1, 2]);
  assert.ok(done.value.daySummary.endsWith('丙'.repeat(10)));
  await db.close();
});

test('local checkpoint rollback and parallel callers do not publish incomplete or duplicate receipts', async () => {
  const db = createJobStore(path.join(root, 'atomic.sqlite'));
  await assert.rejects(db.runTransaction(async (tx) => {
    await tx.collection('ai_runs').doc('partial').set({ value: 'uncommitted' });
    throw new Error('crash before commit');
  }), /crash/);
  assert.deepEqual((await db.collection('ai_runs').doc('partial').get()).data, []);
  let release, entered, calls = 0;
  const waiting = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const make = () => jobs.createOrganizationJobs({ db });
  const args = { owner: 'A', targetId: 'day', kind: 'diary', promptVersion: 'v1', parts: ['text'] };
  const first = make().run({ ...args, generate: async () => { calls++; entered(); await waiting; return 'result'; } });
  await started;
  const second = await make().run({ ...args, generate: async () => { calls++; return 'duplicate'; } });
  assert.equal(second.busy, true);
  release();
  await first;
  assert.equal(calls, 1);
  await db.close();
});

test('killing the actual worker process retains committed receipts and another owner cannot reuse them', async () => {
  const file = path.join(root, 'killed.sqlite');
  const args = { owner: 'A', targetId: 'day', kind: 'diary', promptVersion: 'v1', parts: ['first', 'second', 'last'] };
  const script = `import { createJobStore } from ${JSON.stringify(new URL('../ai/job-store.mjs', import.meta.url).href)};
    import jobs from ${JSON.stringify(new URL('../ai/organization-job.cjs', import.meta.url).href)};
    const db = createJobStore(${JSON.stringify(file)});
    const engine = jobs.createOrganizationJobs({ db, leaseMs: 1000 });
    const args = ${JSON.stringify(args)};
    await engine.run({ ...args, generate: async (part) => part });
    const alive = setInterval(() => {}, 1000);
    await engine.run({ ...args, generate: async () => { process.stdout.write('IN_FLIGHT\\n'); await new Promise(() => {}); } });
    clearInterval(alive);`;
  const child = spawn(process.execPath, ['--input-type=module', '-'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const closed = once(child, 'close');
  const db = createJobStore(file);
  let childError = '';
  child.stderr.on('data', (chunk) => { childError += chunk; });
  try {
    const entered = new Promise((resolve, reject) => {
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; if (output.includes('IN_FLIGHT')) resolve(); });
      child.once('error', reject);
      child.once('exit', () => reject(new Error('worker exited before interruption: ' + childError)));
    });
    child.stdin.end(script);
    await entered;
    child.kill();
    await closed;
    const engine = jobs.createOrganizationJobs({ db });
    const calls = [];
    const generatePart = async (part, index) => { calls.push(index); return part; };
    const pending = await engine.run({ ...args, maxParts: 3, generate: generatePart });
    let paused = pending;
    if (pending.busy) {
      assert.deepEqual(calls, []);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, pending.job.leaseUntil - Date.now()) + 20));
      paused = await engine.run({ ...args, maxParts: 3, generate: generatePart });
    }
    assert.equal(paused.job.errorCode, 'AI_CALL_UNKNOWN');
    const resumed = await engine.run({ ...args, retry: true, maxParts: 3, generate: generatePart });
    assert.deepEqual(calls, [1, 2]);
    assert.deepEqual(resumed.outputs, args.parts);
    calls.length = 0;
    await engine.run({ ...args, owner: 'B', maxParts: 3, generate: generatePart });
    assert.deepEqual(calls, [0, 1, 2]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    await db.close();
  }
});
