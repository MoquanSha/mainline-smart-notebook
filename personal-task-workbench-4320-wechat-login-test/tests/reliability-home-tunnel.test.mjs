import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { WebSocket } from 'ws';
import { createHomeSyncHandler } from '../home-sync.mjs';
import { createRelayServer } from '../relay/server.mjs';
const { HomeTunnelClient } = createRequire(import.meta.url)('../electron/home-tunnel-client.cjs');
const A = { userId: 'user-A', workspaceId: 'space-A' }, B = { userId: 'user-B', workspaceId: 'space-B' };
const headers = (scope = A) => ({ authorization: 'Bearer synthetic-home-secret', 'content-type': 'application/json',
  'x-mainline-scope': encodeURIComponent(JSON.stringify(scope)) });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
  const until = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > until) throw new Error('Timed out: ' + label); await pause(5); }
}
async function fixture(t, options = {}) {
  let state = { meta: { homeOwner: A }, settings: {}, days: [], tasks: [], dailyTasks: [], captures: [], proposals: [] };
  const metrics = { reads: 0, writes: 0, forwards: [] }, peers = [];
  const handler = createHomeSyncHandler({ token: 'synthetic-home-secret', principal: A, requireScope: true,
    readState: async () => { metrics.reads++; if (options.read) await options.read(); return structuredClone(state); },
    mutateState: async fn => { const next = structuredClone(state); await fn(next); state = next; metrics.writes++; return structuredClone(state); },
    handleAction: async (draft, payload) => { draft.days.push({ date: payload.date, manualInputs: [{ id: payload.inputId, content: payload.content }], version: 1 }); },
  });
  const home = createServer((req, res) => handler(req, res, new URL(req.url, 'http://localhost')));
  handler.attachServer(home);
  await new Promise(resolve => home.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${home.address().port}`;
  const relay = createRelayServer({ homes: new Map([['synthetic-home', 'synthetic-tunnel-secret']]), requestTimeoutMs: 1000 });
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  const relayBase = `http://127.0.0.1:${relay.server.address().port}`;
  const client = new HomeTunnelClient({ localBaseUrl: local, fetch: (url, init) => {
    assert.ok(url.startsWith(local + '/api/home/')); metrics.forwards.push({ url, signal: init.signal }); return fetch(url, init);
  } });
  t.after(async () => {
    options.release?.(); for (const ws of peers) ws.terminate(); client.stop(); handler.closeEventStreams();
    home.closeAllConnections();
    await Promise.all([relay.close(), new Promise(resolve => home.close(resolve))]);
  });
  client.start({ relayBaseUrl: relayBase, homeId: 'synthetic-home', tunnelToken: 'synthetic-tunnel-secret' });
  await until(() => client.status().connected, 'desktop tunnel');
  const base = relayBase + '/h/synthetic-home';
  const rpc = async (body, scope = A, route = 'rpc') => {
    const response = await fetch(base + '/api/home/' + route, { method: 'POST', headers: headers(scope), body: JSON.stringify(body) });
    return { status: response.status, ...await response.json() };
  };
  const watch = (scope = A) => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/api/home/socket', { headers: headers(scope), handshakeTimeout: 800 });
    peers.push(ws); const result = { ws, frames: [], error: null, closed: null };
    ws.on('message', bytes => result.frames.push(JSON.parse(String(bytes))));
    ws.on('error', error => { result.error = error; }); ws.on('close', code => { result.closed = code; });
    return result;
  };
  return { rpc, watch, handler, client, relay, relayBase, local, base, metrics, state: () => state };
}

test('external connection check reaches the scoped home ping without reading notebook data', async t => {
  const f = await fixture(t);
  const response = await fetch(f.base + '/api/home/ping', { headers: headers() });
  assert.equal(response.status, 200); const body = await response.json();
  assert.equal(body.data.scopeProtocol, 1); assert.deepEqual(body.data.principal, A);
  assert.equal(f.metrics.reads, 0); assert.equal(f.metrics.writes, 0);
});

test('relay preserves workspace headers for existing RPC and rejects a mismatched account', async t => {
  const f = await fixture(t);
  assert.equal((await f.rpc({ action: 'task.list', scope: A })).ok, true);
  const wrong = await f.rpc({ action: 'task.list', scope: A }, B);
  assert.equal(wrong.error.code, 'WORKSPACE_MISMATCH'); assert.equal(wrong.error.retryable, false);
  assert.equal(f.metrics.writes, 0);
});

test('external batch preserves per-operation A/C receipts and blocks a foreign B operation', async t => {
  const f = await fixture(t);
  const operation = (id, scope = A) => ({ action: 'diary.appendInput', scope, requestId: id,
    payload: { date: '2026-09-20', inputId: id, content: id } });
  const body = { scope: A, operations: [operation('A'), operation('B', B), operation('C')] };
  const response = await f.rpc(body, A, 'batch');
  assert.equal(response.ok, true); assert.deepEqual(response.data.results.map(row => row.ok), [true, false, true]);
  assert.deepEqual(f.state().days.map(day => day.manualInputs[0].id), ['A', 'C']);
  const retry = await f.rpc(body, A, 'batch');
  assert.equal(retry.ok, true); assert.equal(f.state().days.length, 2);
});

test('external notifications pass authenticated revisions with no notebook polling and close with the phone', async t => {
  const f = await fixture(t), good = f.watch();
  await until(() => good.frames.length || good.error, 'notification handshake');
  assert.equal(good.error, null); assert.equal(good.frames[0].type, 'connected');
  f.handler.notifyChange('2026-09-25T00:00:00.000Z');
  await until(() => good.frames.some(frame => frame.type === 'changed'), 'change notification');
  const changed = good.frames.find(frame => frame.type === 'changed');
  assert.notEqual(changed.revision, good.frames[0].revision);
  await pause(80);
  assert.equal(f.metrics.reads, 0); assert.equal(f.metrics.writes, 0); assert.equal(f.metrics.forwards.length, 0);
  good.ws.close(); await until(() => good.closed !== null, 'phone closed');
  await until(() => f.client.status().notificationConnections === 0, 'local notification released');
});

test('a foreign notification subscriber receives only a permanent authorization error', async t => {
  const f = await fixture(t), wrong = f.watch(B);
  await until(() => wrong.closed !== null, 'rejected notification');
  assert.equal(wrong.error, null); assert.equal(wrong.closed, 1008);
  assert.equal(wrong.frames.length, 1); assert.equal(wrong.frames[0].code, 'WORKSPACE_MISMATCH');
  assert.equal(wrong.frames[0].revision, undefined); assert.equal(f.metrics.reads, 0);
});

test('legacy change requests wait for one actual change and release on client cancellation', async t => {
  const f = await fixture(t);
  const get = suffix => fetch(f.base + '/api/home/changes' + suffix, { headers: headers() }).then(response => response.json());
  const first = await get(''); assert.equal(first.ok, true);
  const pending = get('?since=' + encodeURIComponent(first.data.revision));
  await until(() => f.client.status().activeRequests === 1, 'long request forwarded');
  f.handler.notifyChange(); const next = await pending;
  assert.equal(next.data.changed, true); assert.notEqual(next.data.revision, first.data.revision);
  const controller = new AbortController();
  const cancelled = fetch(f.base + '/api/home/changes?since=' + encodeURIComponent(next.data.revision), { headers: headers(), signal: controller.signal });
  const rejection = assert.rejects(cancelled, error => error.name === 'AbortError');
  await until(() => f.client.status().activeRequests === 1, 'second long request forwarded');
  const forwarded = f.metrics.forwards.at(-1);
  controller.abort(); await rejection;
  await until(() => forwarded.signal.aborted && f.relay.status().pendingRequests === 0 && f.client.status().activeRequests === 0, 'cancel reached local request');
  assert.equal(f.metrics.reads, 0); assert.equal(f.metrics.writes, 0);
});

test('relay rejects query smuggling, non-home paths and wrong methods before forwarding', async t => {
  const f = await fixture(t);
  for (const [method, route] of [['GET', '/api/home/ping?token=forged'], ['POST', '/api/home/rpc?path=/api/state'],
    ['GET', '/api/state'], ['GET', '/api/home/changes?since=a&since=b'], ['POST', '/api/home/socket'],
    ['DELETE', '/api/home/rpc'], ['GET', '/api/home/comment-images/todo-image-123-abc.jpg?token=x&token=y']]) {
    const response = await fetch(f.base + route, { method, headers: headers() });
    assert.ok([403, 404].includes(response.status), method + ' ' + route);
  }
  assert.equal(f.metrics.forwards.length, 0);
});

test('stopping the old desktop connection aborts outstanding forwarding and notification handles', async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { read: async () => { entered(); await wait; }, release });
  const watch = f.watch(); await until(() => watch.frames.length, 'notification connected');
  const pending = f.rpc({ action: 'task.list', scope: A });
  await started; const localRequest = f.metrics.forwards.at(-1);
  f.client.stop(false); release();
  const result = await pending;
  assert.equal(result.ok, false); assert.equal(result.error.code, 'HOME_OFFLINE');
  await until(() => watch.closed !== null && localRequest.signal.aborted, 'old handles cancelled');
  assert.equal(f.client.status().activeRequests, 0); assert.equal(f.client.status().notificationConnections, 0);
});

test('replacement tunnel rejects only its old requests and leaves the new connection usable', async t => {
  let reads = 0, entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { read: async () => { if (++reads === 1) { entered(); await wait; } }, release });
  const oldRequest = f.rpc({ action: 'task.list', scope: A }); await started;
  const replacement = new HomeTunnelClient({ localBaseUrl: f.local });
  t.after(() => replacement.stop());
  replacement.start({ relayBaseUrl: f.relayBase, homeId: 'synthetic-home', tunnelToken: 'synthetic-tunnel-secret' });
  await until(() => replacement.status().connected, 'replacement tunnel connected');
  f.client.stop();
  const newRequest = await f.rpc({ action: 'task.list', scope: A });
  assert.equal(newRequest.ok, true);
  assert.equal((await oldRequest).error.code, 'HOME_OFFLINE');
  release(); await pause(30);
  assert.equal((await f.rpc({ action: 'task.list', scope: A })).ok, true);
});

test('an older desktop tunnel keeps RPC compatibility but receives explicit upgrade results for new features', async t => {
  const f = await fixture(t); f.client.stop();
  const legacy = new WebSocket(f.relayBase.replace('http:', 'ws:') + '/tunnel/home/synthetic-home', {
    headers: { authorization: 'Bearer synthetic-tunnel-secret' }, handshakeTimeout: 800 });
  t.after(() => legacy.terminate());
  legacy.on('error', () => {});
  legacy.on('message', raw => {
    const request = JSON.parse(String(raw));
    if (request.type === 'request') legacy.send(JSON.stringify({ type: 'response', id: request.id, statusCode: 200,
      body: Buffer.from(JSON.stringify({ ok: true, data: { receivedScope: request.headers['x-mainline-scope'] } })).toString('base64') }));
  });
  await new Promise((resolve, reject) => { legacy.once('open', resolve); legacy.once('error', reject); });
  const rpc = await f.rpc({ action: 'task.list', scope: A });
  assert.equal(rpc.ok, true); assert.equal(rpc.data.receivedScope, headers()['x-mainline-scope']);
  const response = await fetch(f.base + '/api/home/ping', { headers: headers() });
  assert.equal(response.status, 501); assert.equal((await response.json()).error.retryable, false);
  const watch = f.watch(); await until(() => watch.closed !== null, 'legacy watch stopped');
  assert.equal(watch.frames[0].code, 'HOME_UPGRADE_REQUIRED'); assert.equal(watch.frames[0].retryable, false);
});

test('invalid UTF-8 from the external path is rejected before any original can be altered or committed', async t => {
  const f = await fixture(t);
  const input = { action: 'diary.appendInput', scope: A, requestId: 'bad-byte',
    payload: { date: '2026-09-20', inputId: 'bad-byte', content: 'PLACEHOLDER' } };
  const [prefix, suffix] = JSON.stringify(input).split('PLACEHOLDER');
  const raw = Buffer.concat([Buffer.from(prefix), Buffer.from([0xff]), Buffer.from(suffix)]);
  const response = await fetch(f.base + '/api/home/rpc', { method: 'POST', headers: headers(), body: raw });
  assert.equal(response.status, 400); const body = await response.json();
  assert.equal(body.error.retryable, false); assert.equal(f.metrics.writes, 0);
  assert.equal(f.state().days.length, 0);
});
