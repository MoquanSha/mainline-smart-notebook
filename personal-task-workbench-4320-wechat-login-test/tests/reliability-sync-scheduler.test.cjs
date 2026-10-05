const test = require('node:test');
const assert = require('node:assert/strict');
const { createSyncRunner, createRemoteSyncLifecycle } = require('../electron/sync-scheduler.cjs');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function timers() {
  let id = 0;
  const pending = new Map();
  return { pending, setTimer: (callback, delay) => { pending.set(++id, { callback, delay }); return id; }, clearTimer: (id) => pending.delete(id),
    async run(delay) { const item = [...pending].find(([, value]) => value.delay === delay); assert.ok(item, `no timer for ${delay}`); pending.delete(item[0]); item[1].callback(); await tick(); } };
}

test('changes arriving during a shared sync cause exactly one subsequent run', async () => {
  const gate = deferred(); let count = 0;
  const runner = createSyncRunner(async () => { if (++count === 1) await gate.promise; return count; });
  const a = runner.run({ key: 'a' }); await tick();
  const b = runner.run({ key: 'a' }), c = runner.run({ key: 'a' });
  gate.resolve();
  assert.deepEqual(await Promise.all([a, b, c]), [2, 2, 2]);
  assert.equal(count, 2);
});

test('profile cancellation rejects late completion and waits before another profile can run', async () => {
  const gate = deferred(); let observed;
  const runner = createSyncRunner(async (scope, context) => { observed = context; if (scope.key === 'a') await gate.promise; context.assertCurrent(); return scope.key; });
  const old = runner.run({ key: 'a' });
  const rejection = assert.rejects(old, { code: 'SYNC_SCOPE_CHANGED' });
  await tick();
  const stop = runner.cancel();
  assert.equal(observed.signal.aborted, true);
  await assert.rejects(runner.run({ key: 'b' }), { code: 'SYNC_SCOPE_CHANGED' });
  gate.resolve(); await stop; await rejection;
  assert.equal(await runner.run({ key: 'b' }), 'b');
});

test('watch failures back off 2s, 4s and stop on permission error without idle polling', async () => {
  const clock = timers(); let calls = 0;
  const lifecycle = createRemoteSyncLifecycle({ ...clock, watch: async () => { calls++; throw Object.assign(new Error('down'), { code: calls === 3 ? 'PERMISSION_DENIED' : 'NETWORK' }); }, sync: async () => ({ connected: true }) });
  lifecycle.start(); await tick();
  await clock.run(0);
  await clock.run(2000);
  await clock.run(4000);
  assert.equal(calls, 3);
  assert.equal(clock.pending.size, 0);
  lifecycle.stop();
});

test('bursts coalesce, events during receiving and partial history each get a follow-up', async () => {
  const clock = timers(), gate = deferred(); let change, calls = 0;
  const lifecycle = createRemoteSyncLifecycle({ ...clock,
    watch: (callback, signal) => { change = callback; return new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })); },
    sync: async () => { calls++; if (calls === 1) await gate.promise; return { connected: true, receivePending: calls === 2 }; } });
  lifecycle.start(); await tick(); await clock.run(0);
  change(); change(); change(); gate.resolve(); await tick();
  await clock.run(50); await clock.run(50);
  assert.equal(calls, 3); assert.equal(clock.pending.size, 0);
  lifecycle.stop();
});

test('stop closes the watch, cancels retry and ignores an old response', async () => {
  const clock = timers(), gate = deferred(); let signal, delivered = 0;
  const lifecycle = createRemoteSyncLifecycle({ ...clock, watch: (_change, abort) => { signal = abort; return new Promise((resolve) => abort.addEventListener('abort', resolve, { once: true })); }, sync: () => gate.promise, onResult: () => delivered++ });
  lifecycle.start(); await tick(); await clock.run(0); lifecycle.stop();
  gate.resolve({ connected: true, receivePending: true }); await tick();
  assert.equal(signal.aborted, true); assert.equal(delivered, 0); assert.equal(clock.pending.size, 0);
});

test('transient receive errors retry with backoff but invalid checkpoints remain visible and stop', async () => {
  const clock = timers(); let calls = 0, errors = 0;
  const lifecycle = createRemoteSyncLifecycle({ ...clock, watch: (_change, signal) => new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })),
    sync: async () => { if (++calls < 3) throw new Error('network'); throw Object.assign(new Error('bad cursor'), { code: 'SYNC_CHECKPOINT_INVALID', retryable: false }); }, onError: () => errors++ });
  lifecycle.start(); await tick(); await clock.run(0); await clock.run(2000); await clock.run(4000);
  assert.equal(errors, 3); assert.equal(clock.pending.size, 0); lifecycle.stop();
});
