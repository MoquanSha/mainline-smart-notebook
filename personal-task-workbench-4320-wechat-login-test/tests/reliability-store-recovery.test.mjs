import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import io from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-store-recovery-'));
process.env.SMART_NOTEBOOK_DATA_DIR = root;
process.env.SMART_NOTEBOOK_EMPTY_SEED = 'true';
const { STORE_PATH, createCloudInitialState, mutateState, readState, server, diaryJobStore } = await import('../server.mjs');
const bytes = () => fs.readFileSync(STORE_PATH);

for (const [name, raw, code] of [
  ['invalid JSON', '{"tasks":[{"content":"唯一原文 👨‍👩‍👧"}', 'LOCAL_STORE_INVALID_JSON'],
  ['unsupported schema', '{"tasks":"历史数据","days":[]}', 'LOCAL_STORE_INVALID_SCHEMA'],
  ['normalizer failure', '{"tasks":[],"days":[null]}', 'LOCAL_STORE_NORMALIZE_FAILED'],
]) {
  test(`${name} must preserve exact source bytes and never call a mutator or seed demo data`, async () => {
    fs.writeFileSync(STORE_PATH, raw);
    let called = false;
    await assert.rejects(mutateState(() => { called = true; }), error => error.code === code);
    assert.equal(called, false);
    assert.deepEqual(bytes(), Buffer.from(raw));
    assert.equal(fs.readdirSync(root).some(name => name.startsWith('notebook.json.broken-')), false,
      'reading should leave the only original in place');
  });
}

test('an existing profile whose notebook disappears is blocked instead of reinitialized', async () => {
  const initial = createCloudInitialState();
  fs.writeFileSync(STORE_PATH, JSON.stringify(initial));
  await mutateState(state => { state.days.push({ date: '2026-09-24', manualInputs: [{ id: 'only', content: '唯一原文' }] }); });
  const original = bytes();
  fs.unlinkSync(STORE_PATH);
  let called = false;
  await assert.rejects(mutateState(() => { called = true; }), error => error.code === 'LOCAL_STORE_MISSING');
  assert.equal(called, false); assert.equal(fs.existsSync(STORE_PATH), false);
  fs.writeFileSync(STORE_PATH, original);
});

test('an external update while a mutation is awaiting cannot be overwritten by the older snapshot', async () => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const pending = mutateState(async state => { entered(); await wait; state.days[0].summary = 'stale editor'; });
  const rejected = assert.rejects(pending, error => error.code === 'LOCAL_STORE_CHANGED');
  await started;
  const external = createCloudInitialState();
  external.days.push({ date: '2026-09-25', manualInputs: [{ id: 'external', content: '另一个操作写入的新原文' }] });
  const raw = JSON.stringify(external);
  fs.writeFileSync(STORE_PATH, raw);
  release(); await rejected;
  assert.deepEqual(bytes(), Buffer.from(raw));
  assert.equal(fs.readdirSync(root).some(name => name.startsWith('notebook.json.tmp-')), false);
});

test('temporary read locks retry without replacing, renaming or changing source bytes', async () => {
  const before = bytes(), original = io.readFile;
  let attempts = 0;
  io.readFile = async (file, ...args) => {
    if (file === STORE_PATH) { attempts++; throw Object.assign(new Error('locked'), { code: 'EACCES' }); }
    return original(file, ...args);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(readState({ fresh: true }), error => error.code === 'LOCAL_STORE_UNREADABLE'); }
  finally { io.readFile = original; syncBuiltinESMExports(); }
  assert.equal(attempts, 3); assert.deepEqual(bytes(), before);
});

for (const stage of ['sync', 'rename']) {
  test(`a ${stage} failure never replaces the last committed notebook or exposes the failed state`, async () => {
    const before = bytes(), originalOpen = io.open, originalRename = io.rename;
    if (stage === 'sync') {
      io.open = async (file, ...args) => {
        const handle = await originalOpen(file, ...args);
        if (String(file).startsWith(STORE_PATH + '.tmp-')) {
          handle.sync = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
        }
        return handle;
      };
    } else io.rename = async (from, to) => {
      if (to === STORE_PATH) throw Object.assign(new Error('destination locked'), { code: 'EACCES' });
      return originalRename(from, to);
    };
    syncBuiltinESMExports();
    try { await assert.rejects(mutateState(state => { state.days[0].summary = 'must never appear'; }), error => ['ENOSPC', 'EACCES'].includes(error.code)); }
    finally { io.open = originalOpen; io.rename = originalRename; syncBuiltinESMExports(); }
    assert.deepEqual(bytes(), before);
    assert.notEqual((await readState()).days[0].summary, 'must never appear');
    assert.equal(fs.readdirSync(root).some(name => name.startsWith('notebook.json.tmp-')), false);
  });
}

test('invalid UTF-8 is preserved verbatim and HTTP reports a recovery error without a success snapshot', async () => {
  const before = bytes();
  const damaged = Buffer.concat([Buffer.from('{"tasks":[],"days":[],"title":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  fs.writeFileSync(STORE_PATH, damaged);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/state`);
    const body = await response.json();
    assert.equal(response.status, 503); assert.equal(body.code, 'LOCAL_STORE_INVALID_JSON');
    assert.equal(body.retryable, false); assert.equal(body.days, undefined);
    assert.deepEqual(bytes(), damaged);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.writeFileSync(STORE_PATH, before); }
});

test('fresh concurrent initialization works, while a missing initialized store stays blocked after process restart', () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-store-first-run-'));
  const source = new URL('../server.mjs', import.meta.url).href;
  const run = () => spawnSync(process.execPath, ['--input-type=module', '-e', `
    const {readState,diaryJobStore}=await import(${JSON.stringify(source)});
    try {const results=await Promise.all(Array.from({length:8},()=>readState())); console.log(JSON.stringify({ok:true,counts:results.map(s=>s.days.length)}));}
    catch(e){console.log(JSON.stringify({ok:false,code:e.code}));}
    finally{await diaryJobStore.close();}
  `], { env: { ...process.env, SMART_NOTEBOOK_DATA_DIR: fresh }, encoding: 'utf8', timeout: 10_000 });
  try {
    const first = run(); assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout.trim()), { ok: true, counts: Array(8).fill(0) });
    assert.ok(fs.existsSync(path.join(fresh, '.notebook-initialized')));
    fs.unlinkSync(path.join(fresh, 'notebook.json'));
    const second = run(); assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(second.stdout.trim()), { ok: false, code: 'LOCAL_STORE_MISSING' });
    assert.equal(fs.existsSync(path.join(fresh, 'notebook.json')), false);
  } finally {
    assert.equal(path.dirname(path.resolve(fresh)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(fresh).startsWith('mainline-store-first-run-'));
    fs.rmSync(fresh, { recursive: true, force: true });
  }
});

test.after(async () => {
  await diaryJobStore.close();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('mainline-store-recovery-'));
  fs.rmSync(root, { recursive: true, force: true });
});
