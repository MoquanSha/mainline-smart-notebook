import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-photo-http-'));
const root = fs.mkdtempSync(path.join(evidence, 'photo-http-'));
const data = path.join(root, 'data'); fs.mkdirSync(data);
process.env.SMART_NOTEBOOK_DATA_DIR = data;
const { server, createCloudInitialState, diaryJobStore, STORE_PATH } = await import('../server.mjs');
const require = createRequire(import.meta.url), sync = require('../electron/cloud-sync.cjs');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZWQAAAAASUVORK5CYII=', 'base64');
const state = createCloudInitialState();
Object.assign(state.settings, { autoUpdateEnabled: false, autoOrganize: false, codexSessionsDir: path.join(root, 'absent') });
state.dailyTasks = [{ id: 'photo-history', entryKind: 'today_todo', title: 'Synthetic history photo', date: '2026-08-06',
  comments: [{ id: 'comment', content: 'Synthetic photo', attachments: [{ id: 'p', fileID: 'cloud://env/p', size: PNG.length,
    relativePath: 'todo-image-0-broken.png' }] }] }];
const imageDirectory = path.join(data, 'comment-images'); fs.mkdirSync(imageDirectory);
fs.writeFileSync(path.join(imageDirectory, 'todo-image-0-broken.png'), PNG.subarray(0, 24));
fs.writeFileSync(STORE_PATH, JSON.stringify(state));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`, nativeFetch = globalThis.fetch;
const counts = { cloudCalls: 0, imageDownloads: 0 };
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith(base + '/')) return nativeFetch(url, init);
  if (url === 'https://cloud.test/photo') {
    counts.cloudCalls++;
    const body = JSON.parse(init.body);
    assert.equal(body.action, 'attachment.tempUrls');
    assert.deepEqual(body.payload.references, [{ todoId: 'photo-history', attachmentId: 'p', fileID: 'cloud://env/p' }]);
    return Response.json({ ok: true, data: { files: [{ fileID: 'cloud://env/p', url: 'https://photo.test/p', expiresAt: new Date(Date.now() + 600000).toISOString() }] } });
  }
  assert.equal(url, 'https://photo.test/p', 'no external network is permitted');
  counts.imageDownloads++; return new Response(PNG, { headers: { 'content-length': String(PNG.length) } });
};

test('real local HTTP merge persists a repaired historical photo and serves its complete bytes without warm re-download', async () => {
  try {
    const initial = await nativeFetch(base + '/api/state').then((r) => r.json());
    const hydrated = await sync.hydrateAttachmentUrls({ endpoint: 'https://cloud.test/photo', token: 'synthetic' }, root, base, initial);
    const result = await sync.cacheCloudAttachmentsLocally(root, base, hydrated.state);
    assert.equal(result.downloaded, 1); assert.equal(result.failed, 0);
    const disk = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    const received = disk.dailyTasks.find((row) => row.id === 'photo-history').comments[0].attachments[0];
    assert.ok(Date.parse(received.previewUrlExpiresAt) > Date.now());
    assert.notEqual(received.relativePath, 'todo-image-0-broken.png');
    const response = await nativeFetch(base + '/api/comment-images/' + received.relativePath);
    assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
    const warmState = await nativeFetch(base + '/api/state').then((r) => r.json());
    const warm = await sync.hydrateAttachmentUrls({ endpoint: 'https://cloud.test/photo', token: 'synthetic' }, root, base, warmState);
    await sync.cacheCloudAttachmentsLocally(root, base, warm.state);
    assert.deepEqual(counts, { cloudCalls: 1, imageDownloads: 1 });
    const originalHash = sync.buildPushHashes(initial)['daily_tasks:photo-history'];
    assert.match(originalHash, /^[a-f0-9]{64}$/);
    assert.equal(sync.buildPushHashes(warmState)['daily_tasks:photo-history'], originalHash,
      'local URL/cache maintenance must not create a business upload');
  } finally {
    globalThis.fetch = nativeFetch;
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    diaryJobStore.close();
    assert.ok(fs.realpathSync(root).startsWith(fs.realpathSync(evidence) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
