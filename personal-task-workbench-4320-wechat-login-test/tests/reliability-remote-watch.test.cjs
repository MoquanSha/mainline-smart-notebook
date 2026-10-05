const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createRequire } = require('node:module');
const { getEventListeners } = require('node:events');

async function fixture(t, hooks = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mainline-watch-'));
  await writeFile(join(root, 'cloud-sync.json'), JSON.stringify({ endpoint: 'https://cloud.test.invalid', workspaceId: 'a', deviceId: 'd', encryptedToken: Buffer.from('test').toString('base64') }));
  const oldFetch = global.fetch;
  t.after(async () => { global.fetch = oldFetch; assert.ok(root.startsWith(join(tmpdir(), 'mainline-watch-'))); await rm(root, { recursive: true, force: true }); });
  const calls = [];
  global.fetch = async (_url, init) => {
    const { action, payload } = JSON.parse(init.body); calls.push({ action, payload });
    return { ok: true, json: async () => ({ ok: true, data: action === 'realtime.ticket'
      ? { available: true, protocol: 2, envId: 'test-env', ticket: 'test-ticket', workspaceId: 'a', signalId: 'head-a', signalKind: 'sync_head' } : { bound: true } }) };
  };
  const file = require.resolve('../electron/cloud-sync.cjs'), native = createRequire(file), module = { exports: {} };
  const sdk = { init: () => ({ auth: () => ({ signInWithCustomTicket: async () => { if (hooks.signIn) await hooks.signIn(); }, getCurrentUser: async () => ({ uid: 'u' }) }),
    database: () => ({ collection: (name) => ({ where: (query) => { assert.equal(name, 'sync_signals'); assert.equal(query.kind, 'sync_head'); return { watch: hooks.watch }; } }) }) }) };
  new Function('require', 'module', 'exports', readFileSync(file, 'utf8'))((id) => id === 'electron'
    ? { safeStorage: { isEncryptionAvailable: () => true, decryptString: (value) => value.toString() } }
    : id === '@cloudbase/js-sdk' ? sdk : native(id), module, module.exports);
  return { watch: (changed, signal, ready) => module.exports.watchRemote(root, changed, signal, ready), calls };
}

test('synchronous SDK watch failure closes its returned handle and removes abort listener', async (t) => {
  let closed = 0;
  const f = await fixture(t, { watch: ({ onError }) => { onError(new Error('watch failed')); return { close: () => closed++ }; } });
  const controller = new AbortController();
  await assert.rejects(f.watch(() => {}, controller.signal), /watch failed/);
  assert.equal(closed, 1); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('throwing SDK watch setup also removes the abort listener', async (t) => {
  const f = await fixture(t, { watch: () => { throw new Error('setup failure'); } });
  const controller = new AbortController();
  await assert.rejects(f.watch(() => {}, controller.signal), /setup failure/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('account switch during authentication never creates a late watcher or binding', async (t) => {
  let resolve, started, watchers = 0;
  const gate = new Promise((r) => { resolve = r; });
  const entered = new Promise((r) => { started = r; });
  const f = await fixture(t, { signIn: async () => { started(); await gate; }, watch: () => { watchers++; return { close() {} }; } });
  const controller = new AbortController();
  const work = f.watch(() => {}, controller.signal);
  await entered; controller.abort(); resolve();
  await assert.rejects(work, { name: 'AbortError' });
  assert.equal(watchers, 0);
  assert.deepEqual(f.calls.map((item) => item.action), ['realtime.ticket']);
});

test('ordered head changes include this devices writes and deduplicate identical snapshots', { timeout: 5000 }, async (t) => {
  let observer, changed = 0, ready = 0, closed = 0;
  let entered;
  const installed = new Promise((resolve) => { entered = resolve; });
  const f = await fixture(t, { watch: (value) => { observer = value; entered(); return { close: () => closed++ }; } });
  const controller = new AbortController();
  const work = f.watch(() => changed++, controller.signal, () => ready++);
  await installed;
  assert.ok(observer);
  assert.equal(ready, 0, 'construction alone is not a successful subscription');
  observer.onChange({ docs: [{ revision: 'sequence-1', sourceDeviceId: 'd' }] });
  observer.onChange({ docs: [{ revision: 'sequence-1' }] });
  observer.onChange({ docs: [{ revision: 'sequence-2' }] });
  assert.equal(ready, 1); assert.equal(changed, 2);
  controller.abort(); await work;
  observer.onChange({ docs: [{ revision: 'sequence-3' }] });
  assert.equal(changed, 2); assert.equal(closed, 1);
});
