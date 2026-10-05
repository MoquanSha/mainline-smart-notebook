import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { createHomeSyncHandler } from '../home-sync.mjs';
const A = { userId: 'user-A', workspaceId: 'space-A' }, B = { userId: 'user-B', workspaceId: 'space-B' };
const scopeHeader = scope => scope ? { 'x-mainline-scope': encodeURIComponent(JSON.stringify(scope)) } : {};
async function fixture(t, principal = A, storedOwner = A) {
  let state = { meta: storedOwner ? { homeOwner: storedOwner } : {}, settings: {}, days: [], tasks: [], dailyTasks: [], captures: [], proposals: [] }, writes = 0, images = 0;
  const handler = createHomeSyncHandler({ token: 'synthetic', principal, requireScope: true,
    readState: async () => structuredClone(state),
    mutateState: async fn => { const next = structuredClone(state); await fn(next); state = next; writes++; return structuredClone(state); },
    handleAction: async (draft, payload) => { draft.days.push({ date: payload.date, manualInputs: [{ id: payload.inputId, content: payload.content }], version: 1 }); },
    receiveTodoCommentImage: async () => { images++; return { id: 'image' }; }
  });
  const server = createServer((req, res) => handler(req, res, new URL(req.url, 'http://localhost')));
  handler.attachServer(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { handler.closeEventStreams(); server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const rpc = async (body, scope = A, route = 'rpc') => {
    const result = await fetch(`${base}/api/home/${route}`, { method: 'POST', headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json', ...scopeHeader(scope) }, body: JSON.stringify(body) });
    return { status: result.status, ...await result.json() };
  };
  return { rpc, base, state: () => state, writes: () => writes, images: () => images };
}
const input = (id, scope = A) => ({ action: 'diary.appendInput', requestId: id, scope,
  payload: { date: '2026-09-20', inputId: id, content: id } });

test('valid token cannot route another account or a missing scope into a bound profile', async t => {
  const f = await fixture(t);
  for (const [body, header, code] of [[input('B', B), B, 'WORKSPACE_MISMATCH'], [input('forged', B), A, 'WORKSPACE_MISMATCH'], [input('missing', undefined), null, 'HOME_SCOPE_REQUIRED']]) {
    const result = await f.rpc(body, header);
    assert.equal(result.ok, false); assert.equal(result.error.code, code);
  }
  const read = await f.rpc({ action: 'task.list', scope: B }, B);
  assert.equal(read.ok, false); assert.equal(read.data, undefined);
  assert.equal(f.writes(), 0); assert.equal(f.state().days.length, 0);
});

test('batch validates every original scope and retains matching A/C acknowledgements', async t => {
  const f = await fixture(t);
  const missing = input('missing'); delete missing.scope;
  const result = await f.rpc({ scope: A, operations: [input('A'), input('B', B), missing, input('C')] }, A, 'batch');
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.results.map(row => row.ok), [true, false, false, true]);
  assert.deepEqual(result.data.results.filter(row => !row.ok).map(row => row.error.code), ['WORKSPACE_MISMATCH', 'HOME_SCOPE_REQUIRED']);
  assert.deepEqual(f.state().days.map(row => row.manualInputs[0].id), ['A', 'C']);
  assert.equal((await f.rpc(input('A', B), B)).ok, false, 'a receipt is not authority to replay under another identity');
});

test('bootstrap returns the server-bound identity and never replaces it from a client claim', async t => {
  const f = await fixture(t);
  const result = await f.rpc({ action: 'bootstrap', scope: A });
  assert.equal(result.data.account.user.id, A.userId);
  assert.equal(result.data.account.workspaceId, A.workspaceId);
  assert.equal((await f.rpc({ action: 'bootstrap', scope: B }, B)).error.code, 'WORKSPACE_MISMATCH');
});

test('unbound server and profile-store owner mismatch fail closed without writes', async t => {
  const unbound = await fixture(t, null, null);
  assert.equal((await unbound.rpc(input('first'))).error.code, 'HOME_IDENTITY_UNBOUND');
  assert.equal(unbound.writes(), 0);
  const wrongStore = await fixture(t, B, A);
  assert.equal((await wrongStore.rpc(input('B', B), B)).error.code, 'WORKSPACE_MISMATCH');
  assert.equal((await wrongStore.rpc({ action: 'task.list', scope: B }, B)).error.code, 'WORKSPACE_MISMATCH');
  assert.equal(wrongStore.writes(), 0);
});

test('image upload and socket cannot bypass the bound request scope', async t => {
  const f = await fixture(t);
  const response = await f.rpc({}, B, 'comment-image');
  assert.equal(response.error.code, 'WORKSPACE_MISMATCH'); assert.equal(f.images(), 0);
  const ws = new WebSocket(f.base.replace('http:', 'ws:') + '/api/home/socket', { headers: { authorization: 'Bearer synthetic', ...scopeHeader(B) } });
  const messages = [];
  const code = await new Promise((resolve, reject) => { ws.on('message', data => messages.push(JSON.parse(String(data)))); ws.on('close', resolve); ws.on('error', reject); });
  assert.equal(code, 1008); assert.equal(messages[0].code, 'WORKSPACE_MISMATCH'); assert.equal(messages[0].revision, undefined);
});

test('a mismatched on-disk owner also blocks images under an otherwise matching request identity', async t => {
  const f = await fixture(t, B, A);
  const upload = await f.rpc({}, B, 'comment-image');
  assert.equal(upload.ok, false); assert.equal(upload.error.code, 'WORKSPACE_MISMATCH');
  assert.equal(upload.error.retryable, false); assert.equal(f.images(), 0);
  const download = await fetch(f.base + '/api/home/comment-images/todo-image-123-abc.jpg', {
    headers: { authorization: 'Bearer synthetic', ...scopeHeader(B) }
  });
  assert.equal((await download.json()).error.code, 'WORKSPACE_MISMATCH');
});

test('image requests without a scope header still require an authenticated desktop profile', async t => {
  const f = await fixture(t, null, null);
  const response = await fetch(f.base + '/api/home/comment-images/todo-image-123-abc.jpg', {
    headers: { authorization: 'Bearer synthetic' }
  });
  assert.equal((await response.json()).error.code, 'HOME_IDENTITY_UNBOUND');
});

test('a batch of foreign operations does not create owner metadata in an untouched profile', async t => {
  const f = await fixture(t, A, null);
  const before = structuredClone(f.state());
  const result = await f.rpc({ scope: A, operations: [input('foreign', B)] }, A, 'batch');
  assert.equal(result.data.results[0].ok, false);
  assert.deepEqual(f.state(), before);
});
